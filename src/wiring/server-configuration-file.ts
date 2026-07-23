import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { parseAssetThreadBindings } from "./asset-threads.ts";

export type ServerConfigurationFileErrorCode =
  | "repository_root_invalid"
  | "source_path_unsafe"
  | "stale_source_state"
  | "invalid_candidate"
  | "temporary_write_failed"
  | "source_replace_failed"
  | "post_apply_validation_failed"
  | "rollback_failed";

export class ServerConfigurationFileError extends Error {
  readonly code: ServerConfigurationFileErrorCode;

  constructor(code: ServerConfigurationFileErrorCode, message: string) {
    super(message);
    this.name = "ServerConfigurationFileError";
    this.code = code;
  }
}

export interface ApplyServerConfigurationFileOptions {
  readonly repositoryRoot: string;
  readonly expectedChannelsSha256: string;
  readonly expectedThreadBindingsSha256: string;
  readonly channelsAfterBytes: Buffer;
  readonly threadBindingsAfterBytes: Buffer;
}

export interface ApplyServerConfigurationFileResult {
  readonly channelsSha256: string;
  readonly threadBindingsSha256: string;
}

interface SourceSnapshot {
  readonly path: string;
  readonly relativePath: "config/channels.json" | "config/asset-threads.json";
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mode: number;
}

interface Replacement {
  readonly source: SourceSnapshot;
  readonly after: Buffer;
  readonly temporary: string;
  readonly backup: string;
  replaced: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && resolve(path).startsWith(`${resolve(root)}${sep}`);
}

async function readSource(root: string, relativePath: SourceSnapshot["relativePath"]): Promise<SourceSnapshot> {
  const requested = join(root, relativePath);
  const stat = await lstat(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ServerConfigurationFileError("source_path_unsafe", `${relativePath} must be a regular non-symlink file.`);
  }
  const canonical = await realpath(requested);
  if (!isInside(root, canonical)) {
    throw new ServerConfigurationFileError("source_path_unsafe", `${relativePath} escapes the repository root.`);
  }
  const bytes = await readFile(canonical);
  return Object.freeze({ path: canonical, relativePath, bytes, sha256: sha256(bytes), mode: stat.mode & 0o777 });
}

async function writeExclusive(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(code)) throw error;
  } finally {
    await handle?.close();
  }
}

function validateCandidate(channelsBytes: Buffer, threadBindingsBytes: Buffer): void {
  try {
    const channels = JSON.parse(channelsBytes.toString("utf8")) as unknown;
    if (typeof channels !== "object" || channels === null || Array.isArray(channels)) {
      throw new Error("channels.json must be an object");
    }
    const entries = Object.entries(channels);
    if (entries.length === 0) throw new Error("channels.json must contain at least one logical route");
    const ownerByChannelId = new Map<string, string>();
    for (const [name, value] of entries) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name) || typeof value !== "string") {
        throw new Error(`invalid channel route ${name}`);
      }
      if (value.trim() !== value || (value.length > 0 && !/^[0-9]{17,20}$/u.test(value))) {
        throw new Error(`channel route ${name} must be empty or one normalized Discord snowflake`);
      }
      if (value.length > 0) {
        const owner = ownerByChannelId.get(value);
        if (owner !== undefined) throw new Error(`Discord forum ${value} is assigned to both ${owner} and ${name}`);
        ownerByChannelId.set(value, name);
      }
    }
    parseAssetThreadBindings(JSON.parse(threadBindingsBytes.toString("utf8")) as unknown);
  } catch (error) {
    throw new ServerConfigurationFileError(
      "invalid_candidate",
      `Server-configuration candidate is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cleanup(replacements: readonly Replacement[]): Promise<void> {
  await Promise.all(
    replacements
      .flatMap((replacement) => [replacement.temporary, replacement.backup])
      .map(async (path) => unlink(path).catch(() => undefined)),
  );
}

async function rollback(replacements: readonly Replacement[]): Promise<boolean> {
  let ok = true;
  for (const replacement of [...replacements].reverse()) {
    if (replacement.replaced) {
      try {
        await rename(replacement.backup, replacement.source.path);
        await syncDirectory(dirname(replacement.source.path));
      } catch {
        ok = false;
      }
    } else {
      await unlink(replacement.backup).catch(() => undefined);
    }
    await unlink(replacement.temporary).catch(() => undefined);
  }
  for (const replacement of replacements) {
    try {
      if (sha256(await readFile(replacement.source.path)) !== replacement.source.sha256) ok = false;
    } catch {
      ok = false;
    }
  }
  return ok;
}

export async function applyServerConfigurationFile(
  options: ApplyServerConfigurationFileOptions,
): Promise<ApplyServerConfigurationFileResult> {
  let root: string;
  try {
    const requested = resolve(options.repositoryRoot);
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("repository root must be a non-symlink directory");
    root = await realpath(requested);
  } catch (error) {
    throw new ServerConfigurationFileError("repository_root_invalid", error instanceof Error ? error.message : String(error));
  }

  const channels = await readSource(root, "config/channels.json");
  const threadBindings = await readSource(root, "config/asset-threads.json");
  if (
    channels.sha256 !== options.expectedChannelsSha256 ||
    threadBindings.sha256 !== options.expectedThreadBindingsSha256
  ) {
    throw new ServerConfigurationFileError("stale_source_state", "Channel or thread-binding state changed after review.");
  }
  validateCandidate(options.channelsAfterBytes, options.threadBindingsAfterBytes);

  const changes = [
    { source: channels, after: options.channelsAfterBytes },
    { source: threadBindings, after: options.threadBindingsAfterBytes },
  ].filter((entry) => !entry.source.bytes.equals(entry.after));
  const replacements: Replacement[] = [];
  try {
    for (const change of changes) {
      const token = randomBytes(12).toString("hex");
      const directory = dirname(change.source.path);
      const temporary = join(directory, `.${basename(change.source.path)}.${token}.server-config.tmp`);
      const backup = join(directory, `.${basename(change.source.path)}.${token}.server-config.rollback`);
      const replacement: Replacement = {
        source: change.source,
        after: change.after,
        temporary,
        backup,
        replaced: false,
      };
      replacements.push(replacement);
      await writeExclusive(temporary, change.after, change.source.mode);
      await link(change.source.path, backup);
    }
  } catch (error) {
    await cleanup(replacements);
    throw new ServerConfigurationFileError("temporary_write_failed", `Could not prepare server-configuration transaction: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    for (const directory of new Set(replacements.map((replacement) => dirname(replacement.source.path)))) {
      await syncDirectory(directory);
    }
  } catch (error) {
    await cleanup(replacements);
    throw new ServerConfigurationFileError("temporary_write_failed", `Could not preserve rollback custody before server-configuration application: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    for (const source of [channels, threadBindings]) {
      if (sha256(await readFile(source.path)) !== source.sha256) {
        throw new ServerConfigurationFileError("stale_source_state", "Server configuration changed before application.");
      }
    }
  } catch (error) {
    await cleanup(replacements);
    if (error instanceof ServerConfigurationFileError) throw error;
    throw new ServerConfigurationFileError(
      "stale_source_state",
      `Server configuration could not be rechecked before application: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let channelsAfter: Buffer;
  let threadBindingsAfter: Buffer;
  try {
    for (const replacement of replacements) {
      await rename(replacement.temporary, replacement.source.path);
      replacement.replaced = true;
      await syncDirectory(dirname(replacement.source.path));
    }
    channelsAfter = await readFile(channels.path);
    threadBindingsAfter = await readFile(threadBindings.path);
    if (
      sha256(channelsAfter) !== sha256(options.channelsAfterBytes) ||
      sha256(threadBindingsAfter) !== sha256(options.threadBindingsAfterBytes)
    ) {
      throw new ServerConfigurationFileError("post_apply_validation_failed", "Applied server-configuration hashes do not match the reviewed candidate.");
    }
    validateCandidate(channelsAfter, threadBindingsAfter);
  } catch (error) {
    const restored = await rollback(replacements);
    if (!restored) {
      throw new ServerConfigurationFileError("rollback_failed", `Server configuration failed and exact rollback could not be proven: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (error instanceof ServerConfigurationFileError) throw error;
    throw new ServerConfigurationFileError("source_replace_failed", `Server configuration failed and canonical files were restored: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Canonical sources are already validated. Backup removal is housekeeping;
  // a leftover hidden hard-link must not falsely report that committed source
  // bytes were rolled back.
  await Promise.all(replacements.map((replacement) => unlink(replacement.backup).catch(() => undefined)));
  await Promise.all(
    [...new Set(replacements.map((replacement) => dirname(replacement.source.path)))]
      .map(async (directory) => syncDirectory(directory).catch(() => undefined)),
  );
  return Object.freeze({
    channelsSha256: sha256(channelsAfter),
    threadBindingsSha256: sha256(threadBindingsAfter),
  });
}

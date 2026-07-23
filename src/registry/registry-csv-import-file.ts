import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { buildPacks } from "../packs/packs.ts";
import { buildRegistry } from "./registry.ts";

export type RegistryCsvImportFileErrorCode =
  | "repository_root_invalid"
  | "source_path_unsafe"
  | "stale_source_state"
  | "invalid_candidate"
  | "temporary_write_failed"
  | "source_replace_failed"
  | "post_apply_validation_failed"
  | "rollback_failed";

export class RegistryCsvImportFileError extends Error {
  readonly code: RegistryCsvImportFileErrorCode;

  constructor(code: RegistryCsvImportFileErrorCode, message: string) {
    super(message);
    this.name = "RegistryCsvImportFileError";
    this.code = code;
  }
}

export interface ApplyRegistryCsvImportFileOptions {
  readonly repositoryRoot: string;
  readonly expectedRegistrySha256: string;
  readonly expectedPacksSha256: string;
  readonly expectedChannelsSha256: string;
  readonly registryAfterBytes: Buffer;
  readonly packsAfterBytes: Buffer;
}

export interface ApplyRegistryCsvImportFileResult {
  readonly registrySha256: string;
  readonly packsSha256: string;
  readonly channelsSha256: string;
}

interface SourceSnapshot {
  readonly path: string;
  readonly relativePath: "definitions/registry.json" | "definitions/packs.json" | "config/channels.json";
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
    throw new RegistryCsvImportFileError("source_path_unsafe", `${relativePath} must be a regular non-symlink file.`);
  }
  const canonical = await realpath(requested);
  if (!isInside(root, canonical)) throw new RegistryCsvImportFileError("source_path_unsafe", `${relativePath} escapes the repository root.`);
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

async function validateCandidate(registryBytes: Buffer, packsBytes: Buffer, channelsBytes: Buffer): Promise<void> {
  try {
    const rawRegistry = JSON.parse(registryBytes.toString("utf8")) as Record<string, Record<string, unknown>>;
    const rawPacks = JSON.parse(packsBytes.toString("utf8")) as unknown;
    const rawChannels = JSON.parse(channelsBytes.toString("utf8")) as Record<string, unknown>;
    const registry = buildRegistry(rawRegistry, rawChannels);
    buildPacks(rawPacks, new Set(registry.all().map((asset) => asset.id)), new Set(Object.keys(rawChannels)));
  } catch (error) {
    throw new RegistryCsvImportFileError("invalid_candidate", `CSV import candidate is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function cleanup(replacements: readonly Replacement[]): Promise<void> {
  await Promise.all(replacements.flatMap((replacement) => [replacement.temporary, replacement.backup]).map(async (path) => unlink(path).catch(() => undefined)));
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

export async function applyRegistryCsvImportFile(options: ApplyRegistryCsvImportFileOptions): Promise<ApplyRegistryCsvImportFileResult> {
  let root: string;
  try {
    const requested = resolve(options.repositoryRoot);
    const rootStat = await lstat(requested);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("repository root must be an explicit non-symlink directory");
    root = await realpath(requested);
  } catch (error) {
    throw new RegistryCsvImportFileError("repository_root_invalid", error instanceof Error ? error.message : String(error));
  }

  const registry = await readSource(root, "definitions/registry.json");
  const packs = await readSource(root, "definitions/packs.json");
  const channels = await readSource(root, "config/channels.json");
  if (
    registry.sha256 !== options.expectedRegistrySha256 ||
    packs.sha256 !== options.expectedPacksSha256 ||
    channels.sha256 !== options.expectedChannelsSha256
  ) {
    throw new RegistryCsvImportFileError("stale_source_state", "Registry, Pack, or channel source changed after CSV review.");
  }
  await validateCandidate(options.registryAfterBytes, options.packsAfterBytes, channels.bytes);

  const changes = [
    { source: registry, after: options.registryAfterBytes },
    { source: packs, after: options.packsAfterBytes },
  ].filter((entry) => !entry.source.bytes.equals(entry.after));
  const replacements: Replacement[] = [];
  try {
    for (const change of changes) {
      const token = randomBytes(12).toString("hex");
      const directory = dirname(change.source.path);
      const temporary = join(directory, `.${basename(change.source.path)}.${token}.csv-import.tmp`);
      const backup = join(directory, `.${basename(change.source.path)}.${token}.csv-import.rollback`);
      await writeExclusive(temporary, change.after, change.source.mode);
      await link(change.source.path, backup);
      replacements.push({ source: change.source, after: change.after, temporary, backup, replaced: false });
    }
  } catch (error) {
    await cleanup(replacements);
    throw new RegistryCsvImportFileError("temporary_write_failed", `Could not prepare CSV import transaction: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const source of [registry, packs, channels]) {
    if (sha256(await readFile(source.path)) !== source.sha256) {
      await cleanup(replacements);
      throw new RegistryCsvImportFileError("stale_source_state", "A canonical source changed before CSV import application.");
    }
  }

  let registryAfter: Buffer;
  let packsAfter: Buffer;
  let channelsAfter: Buffer;
  try {
    for (const replacement of replacements) {
      await rename(replacement.temporary, replacement.source.path);
      replacement.replaced = true;
      await syncDirectory(dirname(replacement.source.path));
    }
    registryAfter = await readFile(registry.path);
    packsAfter = await readFile(packs.path);
    channelsAfter = await readFile(channels.path);
    if (
      sha256(registryAfter) !== sha256(options.registryAfterBytes) ||
      sha256(packsAfter) !== sha256(options.packsAfterBytes) ||
      sha256(channelsAfter) !== channels.sha256
    ) {
      throw new RegistryCsvImportFileError("post_apply_validation_failed", "CSV import source hashes do not match the reviewed candidate.");
    }
    await validateCandidate(registryAfter, packsAfter, channelsAfter);
  } catch (error) {
    const restored = await rollback(replacements);
    if (!restored) throw new RegistryCsvImportFileError("rollback_failed", `CSV import failed and exact rollback could not be proven: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof RegistryCsvImportFileError) throw error;
    throw new RegistryCsvImportFileError("source_replace_failed", `CSV import failed and canonical sources were restored: ${error instanceof Error ? error.message : String(error)}`);
  }

  // At this point both canonical sources and their shared candidate have been
  // validated. Backup removal is housekeeping rather than part of the source
  // commit: failure to remove a hidden hard-link must not report that an
  // already-committed Registry import was rolled back.
  await Promise.all(replacements.map((replacement) => unlink(replacement.backup).catch(() => undefined)));
  for (const directory of new Set(replacements.map((replacement) => dirname(replacement.source.path)))) await syncDirectory(directory);
  return Object.freeze({ registrySha256: sha256(registryAfter), packsSha256: sha256(packsAfter), channelsSha256: sha256(channelsAfter) });
}

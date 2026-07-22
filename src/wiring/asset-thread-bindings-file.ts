import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";

import {
  AssetThreadsError,
  bindAssetThread,
  parseAssetThreadBindings,
  serializeAssetThreadBindings,
  type AssetThreadBindings,
} from "./asset-threads.ts";

interface FileSnapshot {
  readonly bytes: Buffer;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly mode: number;
}

export interface BindAssetThreadFileResult {
  readonly changed: boolean;
  readonly bindings: AssetThreadBindings;
  readonly bytes: Buffer;
}

export interface BindAssetThreadFileHooks {
  readonly beforeReplace?: () => Promise<void>;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameIdentity(
  left: FileSnapshot,
  right: FileSnapshot,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds ===
      right.modifiedNanoseconds &&
    left.bytes.equals(right.bytes)
  );
}

async function readRegularSnapshot(
  path: string,
): Promise<FileSnapshot> {
  let listed;

  try {
    listed = await lstat(path, { bigint: true });
  } catch (error) {
    throw new AssetThreadsError(
      `could not inspect ${path}: ${errorDetail(error)}`,
    );
  }

  if (listed.isSymbolicLink() || !listed.isFile()) {
    throw new AssetThreadsError(
      `${path} must be a regular non-symlink file`,
    );
  }

  let handle;

  try {
    handle = await open(path, fsConstants.O_RDONLY);
    const before = await handle.stat({ bigint: true });

    if (
      !before.isFile() ||
      before.dev !== listed.dev ||
      before.ino !== listed.ino
    ) {
      throw new AssetThreadsError(
        `${path} changed while it was being opened`,
      );
    }

    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });

    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new AssetThreadsError(
        `${path} changed while it was being read`,
      );
    }

    return Object.freeze({
      bytes,
      device: after.dev,
      inode: after.ino,
      size: after.size,
      modifiedNanoseconds: after.mtimeNs,
      mode: Number(after.mode & 0o777n),
    });
  } catch (error) {
    if (error instanceof AssetThreadsError) {
      throw error;
    }

    throw new AssetThreadsError(
      `could not read ${path}: ${errorDetail(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseSnapshot(
  path: string,
  snapshot: FileSnapshot,
): AssetThreadBindings {
  let parsed: unknown;

  try {
    parsed = JSON.parse(
      snapshot.bytes.toString("utf8"),
    ) as unknown;
  } catch (error) {
    throw new AssetThreadsError(
      `could not parse ${path}: ${errorDetail(error)}`,
    );
  }

  return parseAssetThreadBindings(parsed);
}

async function writeTemporary(
  directory: string,
  name: string,
  bytes: Buffer,
  mode: number,
): Promise<string> {
  const temporary = join(
    directory,
    `.${name}.${randomBytes(12).toString("hex")}.tmp`,
  );

  const handle = await open(
    temporary,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY,
    mode,
  );

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw new AssetThreadsError(
      `could not prepare binding update: ${errorDetail(error)}`,
    );
  } finally {
    await handle.close().catch(() => undefined);
  }

  return temporary;
}

async function syncDirectory(
  directory: string,
): Promise<void> {
  const handle = await open(
    directory,
    fsConstants.O_RDONLY,
  );

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomically add one installation-owned Asset-thread binding.
 *
 * The source is snapshotted before planning and verified again immediately
 * before replacement. Exact repetition is idempotent and performs no write.
 * Conflicting rebinding is rejected by bindAssetThread().
 */
export async function bindAssetThreadFile(
  bindingsPath: string,
  packId: string,
  assetId: string,
  threadId: string,
  hooks: BindAssetThreadFileHooks = {},
): Promise<BindAssetThreadFileResult> {
  const path = resolve(bindingsPath);
  const source = await readRegularSnapshot(path);
  const current = parseSnapshot(path, source);
  const next = bindAssetThread(
    current,
    packId,
    assetId,
    threadId,
  );

  if (next === current) {
    return Object.freeze({
      changed: false,
      bindings: current,
      bytes: source.bytes,
    });
  }

  const nextBytes =
    serializeAssetThreadBindings(next);
  const directory = dirname(path);
  const temporary = await writeTemporary(
    directory,
    basename(path),
    nextBytes,
    source.mode,
  );

  try {
    await hooks.beforeReplace?.();

    const verified = await readRegularSnapshot(path);
    if (!sameIdentity(source, verified)) {
      throw new AssetThreadsError(
        `${path} changed during binding update`,
      );
    }

    await rename(temporary, path);
    await syncDirectory(directory);

    const final = await readRegularSnapshot(path);
    if (!final.bytes.equals(nextBytes)) {
      throw new AssetThreadsError(
        `${path} did not retain the exact binding bytes`,
      );
    }

    return Object.freeze({
      changed: true,
      bindings: next,
      bytes: final.bytes,
    });
  } finally {
    await rm(temporary, { force: true });
  }
}

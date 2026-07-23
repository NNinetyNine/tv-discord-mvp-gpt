import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import {
  join,
  resolve,
} from "node:path";

import {
  validateAssetLogo,
  type ValidatedAssetLogo,
} from "./asset-logo.ts";

const SAFE_ASSET_ID =
  /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export type AssetLogoFileErrorCode =
  | "invalid_asset_id"
  | "repository_root_invalid"
  | "logo_directory_unsafe"
  | "logo_not_found"
  | "logo_path_unsafe"
  | "logo_changed"
  | "invalid_asset_logo"
  | "logo_state_conflict"
  | "logo_write_failed";

export class AssetLogoFileError extends Error {
  constructor(
    readonly code: AssetLogoFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssetLogoFileError";
  }
}

export interface CanonicalAssetLogo {
  readonly path: string;
  readonly bytes: Buffer;
  readonly evidence: ValidatedAssetLogo;
}

export interface ReadCanonicalAssetLogoHooks {
  readonly afterRead?: () => Promise<void>;
}

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function errorCode(
  error: unknown,
): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

export function canonicalAssetLogoPath(
  repositoryRoot: string,
  assetId: string,
): string {
  if (!SAFE_ASSET_ID.test(assetId)) {
    throw new AssetLogoFileError(
      "invalid_asset_id",
      `Asset ID "${assetId}" is not safe for canonical logo custody.`,
    );
  }

  return join(
    resolve(repositoryRoot),
    "assets",
    "asset-logos",
    `${assetId}.png`,
  );
}

async function requireDirectory(
  path: string,
  code:
    | "repository_root_invalid"
    | "logo_directory_unsafe",
  label: string,
): Promise<void> {
  let stat;

  try {
    stat = await lstat(path);
  } catch (error) {
    throw new AssetLogoFileError(
      code,
      `${label} could not be inspected: ${errorDetail(error)}`,
    );
  }

  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory()
  ) {
    throw new AssetLogoFileError(
      code,
      `${label} must be a regular non-symlink directory.`,
    );
  }
}

/**
 * Read and validate one canonical Asset logo without following symlinks.
 *
 * The file identity and size/mtime facts must remain stable across the complete
 * read. The returned bytes are then validated through the same deterministic
 * PNG policy used by Pack Builder.
 */
export async function readCanonicalAssetLogo(
  repositoryRoot: string,
  assetId: string,
  hooks: ReadCanonicalAssetLogoHooks = {},
): Promise<CanonicalAssetLogo> {
  const root = resolve(repositoryRoot);
  const assetsDirectory = join(
    root,
    "assets",
  );
  const logoDirectory = join(
    assetsDirectory,
    "asset-logos",
  );
  const path = canonicalAssetLogoPath(
    root,
    assetId,
  );

  await requireDirectory(
    root,
    "repository_root_invalid",
    "Repository root",
  );
  await requireDirectory(
    assetsDirectory,
    "logo_directory_unsafe",
    "Canonical assets directory",
  );
  await requireDirectory(
    logoDirectory,
    "logo_directory_unsafe",
    "Canonical Asset-logo directory",
  );

  let listed;

  try {
    listed = await lstat(path, {
      bigint: true,
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new AssetLogoFileError(
        "logo_not_found",
        `Canonical Asset logo was not found for "${assetId}".`,
      );
    }

    throw new AssetLogoFileError(
      "logo_path_unsafe",
      `Canonical Asset logo could not be inspected: ${errorDetail(error)}`,
    );
  }

  if (
    listed.isSymbolicLink() ||
    !listed.isFile()
  ) {
    throw new AssetLogoFileError(
      "logo_path_unsafe",
      `Canonical Asset logo for "${assetId}" must be a regular non-symlink file.`,
    );
  }

  let handle;

  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY,
    );

    const before = await handle.stat({
      bigint: true,
    });

    if (
      !before.isFile() ||
      before.dev !== listed.dev ||
      before.ino !== listed.ino
    ) {
      throw new AssetLogoFileError(
        "logo_changed",
        `Canonical Asset logo for "${assetId}" changed while it was being opened.`,
      );
    }

    const bytes = await handle.readFile();

    await hooks.afterRead?.();

    const after = await handle.stat({
      bigint: true,
    });

    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new AssetLogoFileError(
        "logo_changed",
        `Canonical Asset logo for "${assetId}" changed while it was being read.`,
      );
    }

    const validation =
      await validateAssetLogo(bytes);

    if (!validation.ok) {
      throw new AssetLogoFileError(
        "invalid_asset_logo",
        `Canonical Asset logo for "${assetId}" is invalid: ${validation.detail}`,
      );
    }

    return Object.freeze({
      path,
      bytes,
      evidence: validation,
    });
  } catch (error) {
    if (error instanceof AssetLogoFileError) {
      throw error;
    }

    throw new AssetLogoFileError(
      "logo_path_unsafe",
      `Canonical Asset logo for "${assetId}" could not be read: ${errorDetail(error)}`,
    );
  } finally {
    await handle?.close().catch(
      () => undefined,
    );
  }
}


export interface CanonicalAssetLogoStatus {
  readonly exists: boolean;
  readonly path: string;
  readonly evidence: ValidatedAssetLogo | null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureCanonicalLogoDirectory(repositoryRoot: string): Promise<string> {
  const root = resolve(repositoryRoot);
  const assetsDirectory = join(root, "assets");
  const logoDirectory = join(assetsDirectory, "asset-logos");
  await requireDirectory(root, "repository_root_invalid", "Repository root");
  await requireDirectory(assetsDirectory, "logo_directory_unsafe", "Canonical assets directory");
  if (!(await pathExists(logoDirectory))) {
    try {
      await mkdir(logoDirectory, { mode: 0o755 });
      await syncDirectory(assetsDirectory);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new AssetLogoFileError("logo_write_failed", `Canonical Asset-logo directory could not be created: ${errorDetail(error)}`);
      }
    }
  }
  await requireDirectory(logoDirectory, "logo_directory_unsafe", "Canonical Asset-logo directory");
  const canonicalRoot = await realpath(root);
  const canonicalAssetsDirectory = await realpath(assetsDirectory);
  if (canonicalAssetsDirectory !== join(canonicalRoot, "assets")) {
    throw new AssetLogoFileError("logo_directory_unsafe", "Canonical assets directory must remain directly beneath the repository root.");
  }
  const canonicalLogoDirectory = await realpath(logoDirectory);
  if (canonicalLogoDirectory !== join(canonicalAssetsDirectory, "asset-logos")) {
    throw new AssetLogoFileError("logo_directory_unsafe", "Canonical Asset-logo directory must remain directly beneath the canonical assets directory.");
  }
  return canonicalLogoDirectory;
}

export async function inspectCanonicalAssetLogo(
  repositoryRoot: string,
  assetId: string,
): Promise<CanonicalAssetLogoStatus> {
  const path = canonicalAssetLogoPath(repositoryRoot, assetId);
  if (!(await pathExists(path))) return Object.freeze({ exists: false, path, evidence: null });
  const logo = await readCanonicalAssetLogo(repositoryRoot, assetId);
  return Object.freeze({ exists: true, path: logo.path, evidence: logo.evidence });
}

export async function writeCanonicalAssetLogo(
  repositoryRoot: string,
  assetId: string,
  bytes: Buffer,
  expectedCurrentSha256: string | null,
): Promise<CanonicalAssetLogo> {
  const validation = await validateAssetLogo(bytes);
  if (!validation.ok) {
    throw new AssetLogoFileError("invalid_asset_logo", `Canonical Asset logo for "${assetId}" is invalid: ${validation.detail}`);
  }
  const directory = await ensureCanonicalLogoDirectory(repositoryRoot);
  const destination = canonicalAssetLogoPath(repositoryRoot, assetId);
  let current: CanonicalAssetLogoStatus;
  try {
    current = await inspectCanonicalAssetLogo(repositoryRoot, assetId);
  } catch (error) {
    if (error instanceof AssetLogoFileError && error.code === "logo_directory_unsafe") {
      current = Object.freeze({ exists: false, path: destination, evidence: null });
    } else {
      throw error;
    }
  }
  const currentSha = current.evidence?.sha256 ?? null;
  if (currentSha !== expectedCurrentSha256) {
    throw new AssetLogoFileError(
      "logo_state_conflict",
      `Canonical Asset logo state changed for "${assetId}" (expected ${expectedCurrentSha256 ?? "no logo"}, found ${currentSha ?? "no logo"}).`,
    );
  }
  if (await pathExists(destination)) {
    const stat = await lstat(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AssetLogoFileError("logo_path_unsafe", `Canonical Asset logo for "${assetId}" must be a regular non-symlink file.`);
    }
  }
  const temporary = join(directory, `.${assetId}.${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const latest = await inspectCanonicalAssetLogo(repositoryRoot, assetId);
    const latestSha = latest.evidence?.sha256 ?? null;
    if (latestSha !== expectedCurrentSha256) {
      throw new AssetLogoFileError(
        "logo_state_conflict",
        `Canonical Asset logo state changed for "${assetId}" before replacement.`,
      );
    }
    await rename(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof AssetLogoFileError) throw error;
    throw new AssetLogoFileError("logo_write_failed", `Canonical Asset logo for "${assetId}" could not be stored: ${errorDetail(error)}`);
  }
  const stored = await readCanonicalAssetLogo(repositoryRoot, assetId);
  if (stored.evidence.sha256 !== validation.sha256) {
    throw new AssetLogoFileError("logo_write_failed", `Canonical Asset logo for "${assetId}" did not verify after replacement.`);
  }
  return stored;
}

export async function deleteCanonicalAssetLogo(
  repositoryRoot: string,
  assetId: string,
  expectedCurrentSha256: string,
): Promise<void> {
  const current = await readCanonicalAssetLogo(repositoryRoot, assetId);
  if (current.evidence.sha256 !== expectedCurrentSha256) {
    throw new AssetLogoFileError("logo_state_conflict", `Canonical Asset logo state changed for "${assetId}".`);
  }
  try {
    await unlink(current.path);
    await syncDirectory(join(resolve(repositoryRoot), "assets", "asset-logos"));
  } catch (error) {
    throw new AssetLogoFileError("logo_write_failed", `Canonical Asset logo for "${assetId}" could not be removed: ${errorDetail(error)}`);
  }
}

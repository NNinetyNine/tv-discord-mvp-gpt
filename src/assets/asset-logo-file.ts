import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
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
  | "invalid_asset_logo";

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

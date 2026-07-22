import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  validateAssetLogo,
  type ValidatedAssetLogo,
} from "../assets/asset-logo.ts";
import type { CanonicalAssetLogo } from "../assets/asset-logo-file.ts";
import { AdminError } from "./admin-types.ts";

const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function directory(parent: string, name: string): Promise<string> {
  const requested = join(parent, name);
  if (await exists(requested)) {
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AdminError("workspace_path_unsafe", "Thread-provisioning workspace must contain only regular directories.");
    }
  } else {
    await mkdir(requested, { mode: 0o700 });
  }
  const canonical = await realpath(requested);
  if (!pathInside(parent, canonical)) {
    throw new AdminError("workspace_path_unsafe", "Thread-provisioning workspace escapes its parent.");
  }
  return canonical;
}

async function writeReplace(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

export interface AdminThreadProvisioningLogoSummary {
  readonly packId: string;
  readonly assetId: string;
  readonly evidence: ValidatedAssetLogo;
}

/**
 * Local custody for an explicitly uploaded forum-post starter logo.
 *
 * Files are keyed by the canonical Pack/Asset identity, atomically replaced,
 * and never written to repository-owned Asset-logo custody. The confirmed
 * provisioning request must repeat the staged SHA-256 before these bytes can
 * cross the Discord boundary.
 */
export class AdminThreadProvisioningWorkspace {
  readonly root: string;

  private constructor(root: string) { this.root = root; }

  static async open(workspaceRoot: string): Promise<AdminThreadProvisioningWorkspace> {
    const canonicalWorkspace = await realpath(resolve(workspaceRoot));
    const root = await directory(canonicalWorkspace, "thread-provisioning");
    return new AdminThreadProvisioningWorkspace(root);
  }

  async #logoPath(packId: string, assetId: string, create: boolean): Promise<string> {
    if (!IDENTIFIER.test(packId) || !IDENTIFIER.test(assetId)) {
      throw new AdminError("invalid_request", "Pack and Asset IDs must be lowercase safe slugs.");
    }
    const packDirectory = create
      ? await directory(this.root, packId)
      : join(this.root, packId);
    if (!create) {
      try {
        const stat = await lstat(packDirectory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe");
      } catch {
        throw new AdminError("thread_provisioning_logo_not_found", "No staged provisioning logo exists for this Pack Asset.", 404);
      }
    }
    const path = join(packDirectory, `${assetId}.png`);
    if (!pathInside(packDirectory, path)) {
      throw new AdminError("workspace_path_unsafe", "Thread-provisioning logo escapes its Pack workspace.");
    }
    return path;
  }

  async saveLogo(packId: string, assetId: string, bytes: Buffer): Promise<AdminThreadProvisioningLogoSummary> {
    const evidence = await validateAssetLogo(bytes);
    if (!evidence.ok) {
      throw new AdminError("invalid_asset_logo", evidence.detail, 400, { reason: evidence.reason });
    }
    const path = await this.#logoPath(packId, assetId, true);
    if (await exists(path)) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new AdminError("workspace_path_unsafe", "Staged provisioning logo must be a regular non-symlink file.");
      }
    }
    try { await writeReplace(path, bytes); }
    catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError("temporary_write_failed", "Could not stage the provisioning logo.");
    }
    return Object.freeze({ packId, assetId, evidence });
  }

  async readLogo(packId: string, assetId: string, expectedSha256: string): Promise<CanonicalAssetLogo> {
    if (!SHA256.test(expectedSha256)) {
      throw new AdminError("thread_provisioning_logo_mismatch", "Provisioning requires the exact staged logo SHA-256.", 409);
    }
    const path = await this.#logoPath(packId, assetId, false);
    let bytes: Buffer;
    let handle;
    try {
      const listed = await lstat(path, { bigint: true });
      if (listed.isSymbolicLink() || !listed.isFile()) {
        throw new AdminError("workspace_path_unsafe", "Staged provisioning logo must be a regular non-symlink file.");
      }
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino) {
        throw new AdminError("thread_provisioning_logo_mismatch", "The staged provisioning logo changed while it was opened.", 409);
      }
      bytes = await handle.readFile();
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError("thread_provisioning_logo_not_found", "No staged provisioning logo exists for this Pack Asset.", 404);
    } finally {
      await handle?.close();
    }
    const evidence = await validateAssetLogo(bytes);
    if (!evidence.ok) {
      throw new AdminError("invalid_asset_logo", "The staged provisioning logo is no longer valid.", 409, { reason: evidence.reason });
    }
    if (evidence.sha256 !== expectedSha256) {
      throw new AdminError("thread_provisioning_logo_mismatch", "The staged provisioning logo changed after operator review.", 409);
    }
    return Object.freeze({ path, bytes, evidence });
  }
}

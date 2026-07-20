import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, link, mkdir, open, readFile, realpath, readdir, rm, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { AdminError } from "./admin-types.ts";

export const ASSET_REGISTRATION_ARTIFACT_NAMES = Object.freeze([
  "registration-input.json",
  "asset-proposal.json",
  "planning-authorization.json",
  "asset-application-plan.json",
  "asset-source.patch",
  "asset-source-change.json",
  "asset-review-decision.json",
  "asset-source-review.json",
  "asset-application-authorization.json",
  "asset-source-application.json",
] as const);

export type AssetRegistrationArtifactName = (typeof ASSET_REGISTRATION_ARTIFACT_NAMES)[number];

const REGISTRATION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
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

async function writeTemporary(directory: string, label: string, bytes: Buffer): Promise<string> {
  const path = join(directory, `.${label}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

export interface AdminAssetRegistrationArtifactSummary {
  readonly name: AssetRegistrationArtifactName;
  readonly sha256: string;
  readonly bytes: number;
}

export class AdminAssetRegistrationWorkspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(workspaceRoot: string): Promise<AdminAssetRegistrationWorkspace> {
    const requestedWorkspaceRoot = resolve(workspaceRoot);
    if (await exists(requestedWorkspaceRoot)) {
      const stat = await lstat(requestedWorkspaceRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AdminError("workspace_path_unsafe", "Workspace root must be a non-symlink directory.");
      }
    } else {
      await mkdir(requestedWorkspaceRoot, { recursive: true, mode: 0o700 });
    }
    const canonicalWorkspaceRoot = await realpath(requestedWorkspaceRoot);
    const requested = join(canonicalWorkspaceRoot, "asset-registrations");
    if (await exists(requested)) {
      const stat = await lstat(requested);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AdminError("workspace_path_unsafe", "Asset registration directory must be a non-symlink directory.");
      }
    } else {
      await mkdir(requested, { mode: 0o700 });
    }
    const root = await realpath(requested);
    if (!pathInside(canonicalWorkspaceRoot, root)) {
      throw new AdminError("workspace_path_unsafe", "Asset registration directory escapes the workspace root.");
    }
    return new AdminAssetRegistrationWorkspace(root);
  }

  validateRegistrationId(registrationId: string): void {
    if (!REGISTRATION_ID.test(registrationId)) {
      throw new AdminError("invalid_asset_registration_input", "Registration id must be a safe lowercase slug of 1 to 64 characters.");
    }
  }

  #registrationDirectory(registrationId: string): string {
    this.validateRegistrationId(registrationId);
    const path = join(this.root, registrationId);
    if (!pathInside(this.root, path)) {
      throw new AdminError("workspace_path_unsafe", "Asset registration path escapes the workspace root.");
    }
    return path;
  }

  async #ensureDirectory(registrationId: string): Promise<string> {
    const requested = this.#registrationDirectory(registrationId);
    if (await exists(requested)) {
      const stat = await lstat(requested);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AdminError("workspace_path_unsafe", "Asset registration workspace must be a non-symlink directory.");
      }
    } else {
      await mkdir(requested, { mode: 0o700 });
    }
    const canonical = await realpath(requested);
    if (!pathInside(this.root, canonical)) {
      throw new AdminError("workspace_path_unsafe", "Asset registration workspace escapes its root.");
    }
    return canonical;
  }

  async artifactPath(
    registrationId: string,
    name: AssetRegistrationArtifactName,
    createDirectory = true,
  ): Promise<string> {
    if (!ASSET_REGISTRATION_ARTIFACT_NAMES.includes(name)) {
      throw new AdminError("workspace_path_unsafe", "Asset registration artifact name is unsupported.");
    }
    const directory = createDirectory
      ? await this.#ensureDirectory(registrationId)
      : this.#registrationDirectory(registrationId);
    if (!createDirectory && !(await exists(directory))) {
      throw new AdminError("asset_registration_not_found", "Asset registration workspace was not found.", 404);
    }
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new AdminError("workspace_path_unsafe", "Asset registration workspace must be a non-symlink directory.");
    }
    const canonicalDirectory = await realpath(directory);
    if (!pathInside(this.root, canonicalDirectory)) {
      throw new AdminError("workspace_path_unsafe", "Asset registration workspace escapes its root.");
    }
    const path = join(canonicalDirectory, name);
    if (await exists(path)) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new AdminError("workspace_path_unsafe", "Asset registration artifact must be a regular non-symlink file.");
      }
      const canonical = await realpath(path);
      if (!pathInside(canonicalDirectory, canonical)) {
        throw new AdminError("workspace_path_unsafe", "Asset registration artifact escapes its workspace.");
      }
      return canonical;
    }
    return path;
  }

  async writeArtifact(
    registrationId: string,
    name: AssetRegistrationArtifactName,
    bytes: Buffer,
  ): Promise<AdminAssetRegistrationArtifactSummary> {
    const destination = await this.artifactPath(registrationId, name);
    if (await exists(destination)) {
      throw new AdminError("output_already_exists", `Asset registration artifact ${name} already exists.`, 409);
    }
    const directory = await realpath(this.#registrationDirectory(registrationId));
    const temporary = await writeTemporary(directory, name.replace(/[^a-z0-9]+/giu, "-"), bytes);
    try {
      await link(temporary, destination);
      await syncDirectory(directory);
      await unlink(temporary);
    } catch (error) {
      await rm(temporary, { force: true });
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "EEXIST") {
        throw new AdminError("output_already_exists", `Asset registration artifact ${name} already exists.`, 409);
      }
      throw new AdminError("finalize_failed", `Could not finalize Asset registration artifact ${name}.`);
    }
    return Object.freeze({ name, sha256: sha256(bytes), bytes: bytes.length });
  }

  async removeArtifact(registrationId: string, name: AssetRegistrationArtifactName): Promise<void> {
    const path = await this.artifactPath(registrationId, name, false);
    await rm(path, { force: true });
  }

  async readArtifact(registrationId: string, name: AssetRegistrationArtifactName): Promise<Buffer> {
    const path = await this.artifactPath(registrationId, name, false);
    try {
      return await readFile(path);
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError("asset_registration_artifact_not_found", `Asset registration artifact ${name} was not found.`, 404);
    }
  }

  async listArtifacts(registrationId: string): Promise<readonly AdminAssetRegistrationArtifactSummary[]> {
    const directory = this.#registrationDirectory(registrationId);
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AdminError("workspace_path_unsafe", "Asset registration workspace must be a non-symlink directory.");
      }
      const names = await readdir(directory);
      const summaries: AdminAssetRegistrationArtifactSummary[] = [];
      for (const name of ASSET_REGISTRATION_ARTIFACT_NAMES) {
        if (!names.includes(name)) continue;
        const bytes = await this.readArtifact(registrationId, name);
        summaries.push(Object.freeze({ name, sha256: sha256(bytes), bytes: bytes.length }));
      }
      return Object.freeze(summaries);
    } catch (error) {
      if (error instanceof AdminError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return Object.freeze([]);
      }
      throw new AdminError("asset_registration_not_found", "Asset registration workspace was not found.", 404);
    }
  }
}

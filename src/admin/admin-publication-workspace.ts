import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { AdminError } from "./admin-types.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function safeDirectory(parent: string, name: string): Promise<string> {
  const requested = join(parent, name);
  if (await exists(requested)) {
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AdminError("workspace_path_unsafe", `${name} must be a non-symlink directory.`);
    }
  } else {
    await mkdir(requested, { mode: 0o700 });
  }
  const canonical = await realpath(requested);
  if (!pathInside(parent, canonical)) {
    throw new AdminError("workspace_path_unsafe", `${name} escapes the administration workspace.`);
  }
  return canonical;
}

/**
 * Installation-owned publication custody for the Administration application.
 *
 * Pack capture state and staging already live below the supplied administration
 * workspace. Releases produced by that same UI must remain beside that state,
 * rather than silently using the repository-root CLI archive.
 */
export class AdminPublicationWorkspace {
  readonly root: string;
  readonly archiveRoot: string;

  private constructor(root: string, archiveRoot: string) {
    this.root = root;
    this.archiveRoot = archiveRoot;
  }

  static async open(workspaceRoot: string): Promise<AdminPublicationWorkspace> {
    const canonicalWorkspace = await realpath(resolve(workspaceRoot));
    const root = await safeDirectory(canonicalWorkspace, "publication");
    const archiveRoot = await safeDirectory(root, "archive");
    return new AdminPublicationWorkspace(root, archiveRoot);
  }
}

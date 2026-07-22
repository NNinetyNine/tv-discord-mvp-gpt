import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { AdminError } from "./admin-types.ts";

const RENDER_ID = /^[a-f0-9]{32}$/u;
const SOURCE_FILENAME = /^[^\u0000-\u001f\u007f/\\]{1,240}\.png$/iu;

export type StandaloneRenderArtifactName = "publication.png" | "receipt.json";

export interface StandaloneRenderTask {
  readonly renderId: string;
  readonly directory: string;
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly receiptPath: string;
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

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class AdminStandaloneRenderWorkspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(workspaceRoot: string): Promise<AdminStandaloneRenderWorkspace> {
    const requestedRoot = resolve(workspaceRoot);
    const rootStat = await lstat(requestedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new AdminError("workspace_path_unsafe", "Standalone render workspace root must be a non-symlink directory.");
    }
    const canonicalRoot = await realpath(requestedRoot);
    const requested = join(canonicalRoot, "standalone-renders");
    if (await exists(requested)) {
      const stat = await lstat(requested);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AdminError("workspace_path_unsafe", "Standalone render workspace must be a non-symlink directory.");
      }
    } else {
      await mkdir(requested, { mode: 0o700 });
    }
    const root = await realpath(requested);
    if (!pathInside(canonicalRoot, root)) {
      throw new AdminError("workspace_path_unsafe", "Standalone render workspace escapes the administration workspace.");
    }
    return new AdminStandaloneRenderWorkspace(root);
  }

  async createTask(sourceFilename: string, sourceBytes: Buffer): Promise<StandaloneRenderTask> {
    if (
      !SOURCE_FILENAME.test(sourceFilename) ||
      basename(sourceFilename) !== sourceFilename ||
      sourceFilename === ".png"
    ) {
      throw new AdminError(
        "invalid_standalone_render",
        "Source filename must be one safe TradingView PNG filename.",
      );
    }
    if (sourceBytes.length === 0) {
      throw new AdminError("invalid_standalone_render", "Source PNG must not be empty.");
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const renderId = randomBytes(16).toString("hex");
      const directory = join(this.root, renderId);
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
        throw new AdminError("temporary_write_failed", "Could not create the standalone render workspace.");
      }
      if (!pathInside(this.root, directory)) {
        await rm(directory, { recursive: true, force: true });
        throw new AdminError("workspace_path_unsafe", "Standalone render task escapes its workspace.");
      }

      const directoryStat = await lstat(directory);
      const canonicalDirectory = await realpath(directory);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        !pathInside(this.root, canonicalDirectory)
      ) {
        await rm(directory, { recursive: true, force: true });
        throw new AdminError("workspace_path_unsafe", "Standalone render task must be a local non-symlink directory.");
      }

      const sourcePath = join(canonicalDirectory, sourceFilename);
      try {
        await writeExclusive(sourcePath, sourceBytes);
      } catch {
        await rm(directory, { recursive: true, force: true });
        throw new AdminError("temporary_write_failed", "Could not preserve the standalone render source.");
      }
      return Object.freeze({
        renderId,
        directory: canonicalDirectory,
        sourcePath,
        outputPath: join(canonicalDirectory, "publication.png"),
        receiptPath: join(canonicalDirectory, "receipt.json"),
      });
    }
    throw new AdminError("temporary_write_failed", "Could not allocate a unique standalone render ID.");
  }

  async discardTask(renderId: string): Promise<void> {
    if (!RENDER_ID.test(renderId)) return;
    await rm(join(this.root, renderId), { recursive: true, force: true });
  }

  async readArtifact(renderId: string, artifact: StandaloneRenderArtifactName): Promise<Buffer> {
    if (!RENDER_ID.test(renderId)) {
      throw new AdminError("standalone_render_not_found", "Standalone render was not found.", 404);
    }
    const taskDirectory = join(this.root, renderId);
    try {
      const taskStat = await lstat(taskDirectory);
      if (taskStat.isSymbolicLink() || !taskStat.isDirectory()) {
        throw new AdminError("workspace_path_unsafe", "Standalone render task must be a non-symlink directory.");
      }
      const canonicalTask = await realpath(taskDirectory);
      if (!pathInside(this.root, canonicalTask)) {
        throw new AdminError("workspace_path_unsafe", "Standalone render task escapes its workspace.");
      }
    } catch (error) {
      if (error instanceof AdminError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw new AdminError("standalone_render_not_found", "Standalone render was not found.", 404);
      }
      throw new AdminError("standalone_render_not_found", "Standalone render could not be read.", 404);
    }
    const requested = join(taskDirectory, artifact);
    if (!pathInside(this.root, requested)) {
      throw new AdminError("workspace_path_unsafe", "Standalone render artifact escapes its workspace.");
    }
    try {
      const stat = await lstat(requested);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new AdminError("workspace_path_unsafe", "Standalone render artifact must be a regular non-symlink file.");
      }
      const canonical = await realpath(requested);
      if (!pathInside(this.root, canonical)) {
        throw new AdminError("workspace_path_unsafe", "Standalone render artifact escapes its workspace.");
      }
      return await readFile(canonical);
    } catch (error) {
      if (error instanceof AdminError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw new AdminError("standalone_render_artifact_not_found", "Standalone render artifact was not found.", 404);
      }
      throw new AdminError("standalone_render_artifact_not_found", "Standalone render artifact could not be read.", 404);
    }
  }
}

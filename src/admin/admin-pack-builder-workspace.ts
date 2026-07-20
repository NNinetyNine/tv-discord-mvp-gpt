import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { AdminError } from "./admin-types.ts";

const PACK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
export const PACK_BUILDER_INPUT_FILENAME = "input.json" as const;
export const PACK_BUILDER_PREVIEW_FILENAME = "preview.json" as const;
export const PACK_BUILDER_RECEIPT_FILENAME = "receipt.json" as const;

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

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(code)) throw error;
  } finally { await handle?.close(); }
}

async function writeReplace(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  await syncDirectory(dirname(path));
}

export class AdminPackBuilderWorkspace {
  readonly root: string;

  private constructor(root: string) { this.root = root; }

  static async open(workspaceRoot: string): Promise<AdminPackBuilderWorkspace> {
    const canonicalRoot = await realpath(resolve(workspaceRoot));
    const requested = join(canonicalRoot, "pack-builder");
    if (await exists(requested)) {
      const stat = await lstat(requested);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AdminError("workspace_path_unsafe", "Pack-builder workspace must be a non-symlink directory.");
    } else {
      await mkdir(requested, { mode: 0o700 });
    }
    const root = await realpath(requested);
    if (!pathInside(canonicalRoot, root)) throw new AdminError("workspace_path_unsafe", "Pack-builder workspace escapes the administration workspace.");
    return new AdminPackBuilderWorkspace(root);
  }

  async taskDirectory(packId: string): Promise<string> {
    if (!PACK_ID.test(packId)) throw new AdminError("invalid_request", "Pack ID must be a lowercase safe slug.");
    const requested = join(this.root, packId);
    if (await exists(requested)) {
      const stat = await lstat(requested);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AdminError("workspace_path_unsafe", "Pack-builder task directory must be a non-symlink directory.");
    } else {
      await mkdir(requested, { mode: 0o700 });
    }
    const canonical = await realpath(requested);
    if (!pathInside(this.root, canonical)) throw new AdminError("workspace_path_unsafe", "Pack-builder task directory escapes its workspace.");
    return canonical;
  }

  async paths(packId: string): Promise<{
    readonly directory: string;
    readonly input: string;
    readonly preview: string;
    readonly receipt: string;
  }> {
    const directory = await this.taskDirectory(packId);
    return Object.freeze({
      directory,
      input: join(directory, PACK_BUILDER_INPUT_FILENAME),
      preview: join(directory, PACK_BUILDER_PREVIEW_FILENAME),
      receipt: join(directory, PACK_BUILDER_RECEIPT_FILENAME),
    });
  }

  async savePreview(packId: string, inputBytes: Buffer, previewBytes: Buffer): Promise<void> {
    const paths = await this.paths(packId);
    for (const path of [paths.input, paths.preview]) {
      if (await exists(path)) {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new AdminError("workspace_path_unsafe", "Pack-builder artifacts must be regular non-symlink files.");
      }
    }
    await writeReplace(paths.input, inputBytes);
    await writeReplace(paths.preview, previewBytes);
  }

  async readState(packId: string): Promise<{
    readonly input?: unknown;
    readonly preview?: unknown;
    readonly receipt?: unknown;
  }> {
    const paths = await this.paths(packId);
    const result: { input?: unknown; preview?: unknown; receipt?: unknown } = {};
    for (const [key, path] of [["input", paths.input], ["preview", paths.preview], ["receipt", paths.receipt]] as const) {
      if (!await exists(path)) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new AdminError("workspace_path_unsafe", "Pack-builder artifacts must be regular non-symlink files.");
      const canonical = await realpath(path);
      if (!pathInside(paths.directory, canonical)) throw new AdminError("workspace_path_unsafe", "Pack-builder artifact escapes its task directory.");
      try { result[key] = JSON.parse((await readFile(canonical)).toString("utf8")) as unknown; }
      catch { throw new AdminError("invalid_request", `Stored Pack-builder ${key} is invalid JSON.`); }
    }
    return Object.freeze(result);
  }
}

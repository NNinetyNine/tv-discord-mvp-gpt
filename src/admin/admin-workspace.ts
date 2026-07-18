import {
  constants as fsConstants,
  type FileHandle,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

import {
  AdminError,
  type PackDraft,
  isValidPackDraftId,
  parsePackDraft,
  serializePackDraft,
} from "./admin-types.ts";

export interface AdminWorkspaceOptions {
  readonly workspaceRoot: string;
}

export interface DraftUpdateInput {
  readonly expectedRevision: number;
  readonly draft: PackDraft;
}

export interface DraftDeleteInput {
  readonly expectedRevision: number;
}

export interface AdminWorkspaceDependencies {
  readonly beforeFinalize?: (draftId: string) => Promise<void>;
  readonly syncDirectory?: (directory: string) => Promise<void>;
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

async function createExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function nextTemporaryPath(directory: string, draftId: string): string {
  return join(directory, `.${draftId}.${randomBytes(12).toString("hex")}.tmp`);
}

export class AdminWorkspace {
  readonly root: string;
  readonly draftsDirectory: string;
  readonly #dependencies: AdminWorkspaceDependencies;
  readonly #locks = new Map<string, Promise<void>>();

  private constructor(root: string, draftsDirectory: string, dependencies: AdminWorkspaceDependencies) {
    this.root = root;
    this.draftsDirectory = draftsDirectory;
    this.#dependencies = dependencies;
  }

  static async open(
    options: AdminWorkspaceOptions,
    dependencies: AdminWorkspaceDependencies = {},
  ): Promise<AdminWorkspace> {
    const requested = resolve(options.workspaceRoot);
    try {
      if (await exists(requested)) {
        const rootStat = await lstat(requested);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
          throw new AdminError("workspace_root_invalid", "Workspace root must be a non-symlink directory.");
        }
      } else {
        await mkdir(requested, { recursive: true, mode: 0o700 });
      }
      const root = await realpath(requested);
      const draftsRequested = join(root, "pack-drafts");
      if (await exists(draftsRequested)) {
        const draftStat = await lstat(draftsRequested);
        if (draftStat.isSymbolicLink() || !draftStat.isDirectory()) {
          throw new AdminError("workspace_path_unsafe", "Pack draft directory must be a non-symlink directory.");
        }
      } else {
        await mkdir(draftsRequested, { mode: 0o700 });
      }
      const draftsDirectory = await realpath(draftsRequested);
      if (!pathInside(root, draftsDirectory)) {
        throw new AdminError("workspace_path_unsafe", "Pack draft directory escapes the workspace root.");
      }
      return new AdminWorkspace(root, draftsDirectory, dependencies);
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError(
        "workspace_root_invalid",
        `Workspace root is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #draftPath(draftId: string): string {
    if (!isValidPackDraftId(draftId)) {
      throw new AdminError("draft_id_invalid", "Draft id is not a valid safe slug.");
    }
    const path = join(this.draftsDirectory, `${draftId}.json`);
    if (!pathInside(this.draftsDirectory, path)) {
      throw new AdminError("workspace_path_unsafe", "Draft path escapes the workspace root.");
    }
    return path;
  }

  async #withLock<T>(draftId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(draftId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const queued = prior.then(() => current);
    this.#locks.set(draftId, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(draftId) === queued) this.#locks.delete(draftId);
    }
  }

  async listDrafts(validAssetIds?: ReadonlySet<string>): Promise<readonly PackDraft[]> {
    let entries;
    try {
      entries = await readdir(this.draftsDirectory, { withFileTypes: true });
    } catch (error) {
      throw new AdminError("workspace_root_invalid", `Could not list Pack drafts: ${error instanceof Error ? error.message : String(error)}`);
    }
    const drafts: PackDraft[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const draftId = entry.name.slice(0, -5);
      drafts.push(await this.readDraft(draftId, validAssetIds));
    }
    return Object.freeze(drafts);
  }

  async readDraft(draftId: string, validAssetIds?: ReadonlySet<string>): Promise<PackDraft> {
    const path = this.#draftPath(draftId);
    let bytes: Buffer;
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new AdminError("workspace_path_unsafe", "Draft file must be a regular non-symlink file.");
      }
      const canonical = await realpath(path);
      if (!pathInside(this.draftsDirectory, canonical)) {
        throw new AdminError("workspace_path_unsafe", "Draft file escapes the workspace root.");
      }
      bytes = await readFile(canonical);
    } catch (error) {
      if (error instanceof AdminError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw new AdminError("draft_not_found", `Pack draft ${draftId} was not found.`, 404, { draftId });
      }
      throw new AdminError("invalid_pack_draft", `Could not read Pack draft ${draftId}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new AdminError("invalid_pack_draft", `Pack draft ${draftId} is not valid JSON.`);
    }
    const draft = parsePackDraft(parsed, validAssetIds);
    if (draft.id !== draftId) {
      throw new AdminError("invalid_pack_draft", "Draft file name and embedded id do not match.");
    }
    if (!bytes.equals(serializePackDraft(draft))) {
      throw new AdminError("invalid_pack_draft", "Draft bytes are not in canonical serialization form.");
    }
    return draft;
  }

  async exportDraft(draftId: string, validAssetIds?: ReadonlySet<string>): Promise<Buffer> {
    const draft = await this.readDraft(draftId, validAssetIds);
    return serializePackDraft(draft);
  }

  async createDraft(draft: PackDraft, validAssetIds: ReadonlySet<string>): Promise<PackDraft> {
    parsePackDraft(draft, validAssetIds);
    if (draft.revision !== 1) {
      throw new AdminError("invalid_pack_draft", "A new Pack draft must begin at revision 1.");
    }
    return this.#withLock(draft.id, async () => {
      const path = this.#draftPath(draft.id);
      if (await exists(path)) {
        throw new AdminError("draft_already_exists", `Pack draft ${draft.id} already exists.`, 409, { draftId: draft.id });
      }
      await this.#writeDraft(path, draft, false);
      return draft;
    });
  }

  async updateDraft(input: DraftUpdateInput, validAssetIds: ReadonlySet<string>): Promise<PackDraft> {
    const submitted = parsePackDraft(input.draft, validAssetIds);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new AdminError("invalid_request", "expectedRevision must be a positive safe integer.");
    }
    return this.#withLock(submitted.id, async () => {
      const current = await this.readDraft(submitted.id, validAssetIds);
      if (current.revision !== input.expectedRevision) {
        throw new AdminError(
          "draft_revision_conflict",
          "The draft has changed since it was loaded.",
          409,
          { expectedRevision: input.expectedRevision, actualRevision: current.revision },
        );
      }
      if (submitted.revision !== input.expectedRevision) {
        throw new AdminError("invalid_pack_draft", "Submitted draft revision must equal expectedRevision.");
      }
      const next = Object.freeze({ ...submitted, revision: input.expectedRevision + 1 }) as PackDraft;
      await this.#writeDraft(this.#draftPath(submitted.id), next, true, serializePackDraft(current));
      return next;
    });
  }

  async deleteDraft(input: DraftDeleteInput & { readonly draftId: string }, validAssetIds: ReadonlySet<string>): Promise<void> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new AdminError("invalid_request", "expectedRevision must be a positive safe integer.");
    }
    await this.#withLock(input.draftId, async () => {
      const current = await this.readDraft(input.draftId, validAssetIds);
      if (current.revision !== input.expectedRevision) {
        throw new AdminError(
          "draft_revision_conflict",
          "The draft has changed since it was loaded.",
          409,
          { expectedRevision: input.expectedRevision, actualRevision: current.revision },
        );
      }
      const path = this.#draftPath(input.draftId);
      const originalBytes = serializePackDraft(current);
      const backup = nextTemporaryPath(this.draftsDirectory, `${input.draftId}.delete`);
      let moved = false;
      try {
        await rename(path, backup);
        moved = true;
        await (this.#dependencies.syncDirectory ?? syncDirectory)(this.draftsDirectory);
        await unlink(backup);
        moved = false;
        await (this.#dependencies.syncDirectory ?? syncDirectory)(this.draftsDirectory);
      } catch (error) {
        let restored = false;
        try {
          if (moved) {
            await rename(backup, path);
          } else if (!(await exists(path))) {
            const temporary = nextTemporaryPath(this.draftsDirectory, `${input.draftId}.restore`);
            await createExclusive(temporary, originalBytes);
            await rename(temporary, path);
          }
          restored = (await readFile(path)).equals(originalBytes);
          await rm(backup, { force: true });
        } catch {
          restored = false;
        }
        if (!restored) {
          throw new AdminError("draft_delete_failed", `Could not delete Pack draft ${input.draftId} and restoration could not be proven.`);
        }
        throw new AdminError("draft_delete_failed", `Could not delete Pack draft ${input.draftId}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await rm(backup, { force: true }).catch(() => undefined);
      }
    });
  }

  async #writeDraft(path: string, draft: PackDraft, replace: boolean, expectedPrevious?: Buffer): Promise<void> {
    const bytes = serializePackDraft(draft);
    const directory = dirname(path);
    const temporary = nextTemporaryPath(directory, draft.id);
    const backup = nextTemporaryPath(directory, `${draft.id}.backup`);
    let destinationCreated = false;
    let destinationReplaced = false;
    let backupCreated = false;
    try {
      await createExclusive(temporary, bytes);
      await this.#dependencies.beforeFinalize?.(draft.id);
      if (!replace) {
        await link(temporary, path);
        destinationCreated = true;
        await unlink(temporary);
      } else {
        const currentStat = await lstat(path);
        if (currentStat.isSymbolicLink() || !currentStat.isFile()) {
          throw new AdminError("workspace_path_unsafe", "Draft destination must be a regular non-symlink file.");
        }
        if (expectedPrevious === undefined || !(await readFile(path)).equals(expectedPrevious)) {
          throw new AdminError("draft_revision_conflict", "The draft changed during update.", 409);
        }
        await link(path, backup);
        backupCreated = true;
        await rename(temporary, path);
        destinationReplaced = true;
      }
      await (this.#dependencies.syncDirectory ?? syncDirectory)(directory);
      if (backupCreated) await unlink(backup);
    } catch (error) {
      let rollbackOk = true;
      if (destinationReplaced && backupCreated) {
        try { await rename(backup, path); backupCreated = false; }
        catch { rollbackOk = false; }
      } else if (destinationCreated) {
        try { await unlink(path); }
        catch { rollbackOk = false; }
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      if (backupCreated) await rm(backup, { force: true }).catch(() => { rollbackOk = false; });
      if (!rollbackOk) throw new AdminError("draft_finalize_failed", `Could not safely finalize Pack draft ${draft.id}.`);
      if (error instanceof AdminError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "EEXIST") throw new AdminError("draft_already_exists", `Pack draft ${draft.id} already exists.`, 409);
      throw new AdminError(
        replace ? "draft_finalize_failed" : "temporary_write_failed",
        `Could not persist Pack draft ${draft.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rm(backup, { force: true }).catch(() => undefined);
    }
  }
}

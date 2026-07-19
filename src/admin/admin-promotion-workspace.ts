import { randomBytes } from "node:crypto";
import { constants as fsConstants, type FileHandle, lstat, link, mkdir, open, readFile, realpath, readdir, rm, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { AdminError, isValidPackDraftId } from "./admin-types.ts";
import { sha256 } from "../packs/pack-draft-promotion.ts";

export const PACK_PROMOTION_ARTIFACT_NAMES = Object.freeze([
  "promotion-request.json",
  "pack-proposal.json",
  "planning-authorization.json",
  "pack-application-plan.json",
  "pack-source.patch",
  "pack-source-change.json",
  "packs-after.json",
] as const);
export type PackPromotionArtifactName = (typeof PACK_PROMOTION_ARTIFACT_NAMES)[number];
const PROMOTION_ID = /^[a-f0-9]{64}$/u;

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false; throw error; }
}
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try { handle = await open(directory, fsConstants.O_RDONLY); await handle.sync(); }
  catch (error) { const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""; if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(code)) throw error; }
  finally { await handle?.close(); }
}
async function writeTemp(directory: string, label: string, bytes: Buffer): Promise<string> {
  const path = join(directory, `.${label}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return path;
}

export interface AdminPromotionArtifactSummary {
  readonly name: PackPromotionArtifactName;
  readonly sha256: string;
  readonly bytes: number;
}

export class AdminPromotionWorkspace {
  readonly root: string;
  private constructor(root: string) { this.root = root; }

  static async open(workspaceRoot: string): Promise<AdminPromotionWorkspace> {
    const requested = join(workspaceRoot, "pack-promotions");
    if (await exists(requested)) {
      const stat = await lstat(requested);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AdminError("workspace_path_unsafe", "Pack promotion directory must be a non-symlink directory.");
    } else await mkdir(requested, { mode: 0o700 });
    const root = await realpath(requested);
    if (!pathInside(workspaceRoot, root)) throw new AdminError("workspace_path_unsafe", "Pack promotion directory escapes the workspace root.");
    return new AdminPromotionWorkspace(root);
  }

  #promotionDirectory(draftId: string, promotionId: string): string {
    if (!isValidPackDraftId(draftId)) throw new AdminError("draft_id_invalid", "Draft id is not a valid safe slug.");
    if (!PROMOTION_ID.test(promotionId)) throw new AdminError("invalid_request", "Promotion id must be a lowercase SHA-256 digest.");
    const path = join(this.root, draftId, promotionId);
    if (!pathInside(this.root, path)) throw new AdminError("workspace_path_unsafe", "Promotion path escapes the workspace root.");
    return path;
  }

  async #ensureDirectory(draftId: string, promotionId: string): Promise<string> {
    const draftDirectory = join(this.root, draftId);
    if (await exists(draftDirectory)) {
      const stat = await lstat(draftDirectory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AdminError("workspace_path_unsafe", "Draft promotion directory must be a non-symlink directory.");
    } else await mkdir(draftDirectory, { mode: 0o700 });
    const promotionDirectory = this.#promotionDirectory(draftId, promotionId);
    if (await exists(promotionDirectory)) {
      const stat = await lstat(promotionDirectory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AdminError("workspace_path_unsafe", "Promotion directory must be a non-symlink directory.");
    } else await mkdir(promotionDirectory, { mode: 0o700 });
    const canonical = await realpath(promotionDirectory); if (!pathInside(this.root, canonical)) throw new AdminError("workspace_path_unsafe", "Promotion directory escapes the workspace root.");
    return canonical;
  }

  async writeArtifacts(draftId: string, promotionId: string, artifacts: Readonly<Record<PackPromotionArtifactName, Buffer> | Partial<Record<PackPromotionArtifactName, Buffer>>>): Promise<readonly AdminPromotionArtifactSummary[]> {
    const directory = await this.#ensureDirectory(draftId, promotionId);
    const entries = Object.entries(artifacts) as [PackPromotionArtifactName, Buffer][];
    for (const [name] of entries) if (!PACK_PROMOTION_ARTIFACT_NAMES.includes(name)) throw new AdminError("workspace_path_unsafe", "Promotion artifact name is unsupported.");
    for (const [name] of entries) if (await exists(join(directory, name))) throw new AdminError("output_already_exists", `Promotion artifact ${name} already exists.`, 409);
    const temps: string[] = []; const finals: string[] = [];
    try {
      for (const [name, bytes] of entries) temps.push(await writeTemp(directory, name.replace(/[^a-z0-9]+/giu, "-"), bytes));
      for (let index = 0; index < entries.length; index += 1) { const finalPath = join(directory, entries[index]![0]); await link(temps[index]!, finalPath); finals.push(finalPath); await unlink(temps[index]!); }
      await syncDirectory(directory);
      return Object.freeze(entries.map(([name, bytes]) => Object.freeze({ name, sha256: sha256(bytes), bytes: bytes.length })));
    } catch (error) {
      for (const path of finals.reverse()) await rm(path, { force: true });
      throw new AdminError("finalize_failed", `Could not finalize promotion artifacts: ${error instanceof Error ? error.message : String(error)}`);
    } finally { for (const path of temps) await rm(path, { force: true }); }
  }

  async readArtifact(draftId: string, promotionId: string, name: PackPromotionArtifactName): Promise<Buffer> {
    if (!PACK_PROMOTION_ARTIFACT_NAMES.includes(name)) throw new AdminError("route_not_found", "Promotion artifact was not found.", 404);
    const directory = this.#promotionDirectory(draftId, promotionId); const path = join(directory, name);
    try { const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new AdminError("workspace_path_unsafe", "Promotion artifact must be a regular non-symlink file."); const canonical = await realpath(path); if (!pathInside(directory, canonical)) throw new AdminError("workspace_path_unsafe", "Promotion artifact escapes its directory."); return await readFile(canonical); }
    catch (error) { if (error instanceof AdminError) throw error; throw new AdminError("draft_not_found", "Promotion artifact was not found.", 404); }
  }

  async listArtifacts(draftId: string, promotionId: string): Promise<readonly AdminPromotionArtifactSummary[]> {
    const directory = this.#promotionDirectory(draftId, promotionId);
    try {
      const names = await readdir(directory);
      const summaries: AdminPromotionArtifactSummary[] = [];
      for (const name of PACK_PROMOTION_ARTIFACT_NAMES) if (names.includes(name)) { const bytes = await this.readArtifact(draftId, promotionId, name); summaries.push(Object.freeze({ name, sha256: sha256(bytes), bytes: bytes.length })); }
      return Object.freeze(summaries);
    } catch (error) { if (error instanceof AdminError) throw error; throw new AdminError("draft_not_found", "Promotion was not found.", 404); }
  }
}

import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { Workspace } from "../packs/workspace.ts";
import type { Pack } from "../packs/packs.ts";
import {
  validateChartPublicationTimeframe,
  type ChartPublicationTimeframe,
} from "../application/chart-publication-preview.ts";
import type {
  ClaimedPackRenderPreview,
  CompletedPackRenderPreview,
} from "./admin-pack-render-workspace.ts";
import { AdminError } from "./admin-types.ts";

const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PREVIEW_ID = /^[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const REVISION_DIRECTORY = /^([1-9][0-9]*)-([a-f0-9]{32})$/u;
const RECORD_VERSION = 1 as const;

export type PackRevisionArtifactName = "publication.png" | "receipt.json";

export interface PackRevisionRecord {
  readonly schemaVersion: typeof RECORD_VERSION;
  readonly recordType: "visionx.pack-workspace-revision";
  readonly packId: string;
  readonly assetId: string;
  readonly revision: number;
  readonly previewId: string;
  readonly acceptedAt: string;
  readonly sourceBasename: string;
  readonly timeframe: ChartPublicationTimeframe;
  readonly dataAsOf: string;
  readonly outputSha256: string;
  readonly sourceSha256: string;
  readonly receiptSha256: string;
}

export interface PackRevisionEntry extends PackRevisionRecord {
  readonly directory: string;
  readonly publicationPath: string;
  readonly receiptPath: string;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new AdminError("invalid_pack_revision", `${label} is invalid.`);
  }
}

function safeRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AdminError("invalid_pack_revision", "Revision must be a positive safe integer.");
  }
}

function parseRecord(value: unknown): PackRevisionRecord {
  if (!isRecord(value)) {
    throw new AdminError("invalid_pack_revision", "Pack revision record is invalid.");
  }
  const keys = [
    "acceptedAt",
    "assetId",
    "dataAsOf",
    "outputSha256",
    "packId",
    "previewId",
    "receiptSha256",
    "recordType",
    "revision",
    "schemaVersion",
    "sourceBasename",
    "sourceSha256",
    "timeframe",
  ];
  if (Object.keys(value).sort().join("\0") !== keys.sort().join("\0")) {
    throw new AdminError("invalid_pack_revision", "Pack revision record has an invalid shape.");
  }
  const timeframe = validateChartPublicationTimeframe(value.timeframe);
  if (
    value.schemaVersion !== RECORD_VERSION ||
    value.recordType !== "visionx.pack-workspace-revision" ||
    typeof value.packId !== "string" || !IDENTIFIER.test(value.packId) ||
    typeof value.assetId !== "string" || !IDENTIFIER.test(value.assetId) ||
    typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    typeof value.previewId !== "string" || !PREVIEW_ID.test(value.previewId) ||
    typeof value.acceptedAt !== "string" || !Number.isFinite(Date.parse(value.acceptedAt)) ||
    typeof value.sourceBasename !== "string" || value.sourceBasename.length === 0 ||
    !timeframe.ok ||
    typeof value.dataAsOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.dataAsOf) ||
    typeof value.outputSha256 !== "string" || !HASH.test(value.outputSha256) ||
    typeof value.sourceSha256 !== "string" || !HASH.test(value.sourceSha256) ||
    typeof value.receiptSha256 !== "string" || !HASH.test(value.receiptSha256)
  ) {
    throw new AdminError("invalid_pack_revision", "Pack revision record contains invalid facts.");
  }
  return Object.freeze({
    schemaVersion: RECORD_VERSION,
    recordType: "visionx.pack-workspace-revision",
    packId: value.packId,
    assetId: value.assetId,
    revision: value.revision,
    previewId: value.previewId,
    acceptedAt: new Date(value.acceptedAt).toISOString(),
    sourceBasename: value.sourceBasename,
    timeframe: timeframe.timeframe,
    dataAsOf: value.dataAsOf,
    outputSha256: value.outputSha256,
    sourceSha256: value.sourceSha256,
    receiptSha256: value.receiptSha256,
  });
}

async function regularBytes(path: string, label: string): Promise<Buffer> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AdminError("invalid_pack_revision", `${label} must be a regular non-symlink file.`);
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError("invalid_pack_revision", `${label} is unavailable.`);
  }
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class AdminPackRevisionWorkspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(workspaceRoot: string): Promise<AdminPackRevisionWorkspace> {
    const canonicalWorkspace = await realpath(resolve(workspaceRoot));
    const requested = join(canonicalWorkspace, "pack-workspace", "revisions");
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const root = await realpath(requested);
    if (!pathInside(canonicalWorkspace, root)) {
      throw new AdminError("workspace_path_unsafe", "Pack revisions escape the administration workspace.");
    }
    return new AdminPackRevisionWorkspace(root);
  }

  #assetRoot(packId: string, assetId: string): string {
    safeIdentifier(packId, "Pack ID");
    safeIdentifier(assetId, "Asset ID");
    const path = join(this.root, packId, assetId);
    if (!pathInside(this.root, path)) {
      throw new AdminError("workspace_path_unsafe", "Pack revision path escapes its workspace.");
    }
    return path;
  }

  async #readEntry(directory: string): Promise<PackRevisionEntry> {
    const record = parseRecord(JSON.parse((await regularBytes(join(directory, "revision.json"), "Pack revision record")).toString("utf8")));
    const publicationPath = join(directory, "publication.png");
    const receiptPath = join(directory, "receipt.json");
    const sourcePath = join(directory, "source.png");
    const [publication, receipt, source] = await Promise.all([
      regularBytes(publicationPath, "Pack revision publication"),
      regularBytes(receiptPath, "Pack revision receipt"),
      regularBytes(sourcePath, "Pack revision source"),
    ]);
    if (
      sha256(publication) !== record.outputSha256 ||
      sha256(receipt) !== record.receiptSha256 ||
      sha256(source) !== record.sourceSha256
    ) {
      throw new AdminError("invalid_pack_revision", "Pack revision evidence changed after acceptance.");
    }
    return Object.freeze({ ...record, directory, publicationPath, receiptPath });
  }

  async list(packId: string, assetId: string): Promise<readonly PackRevisionEntry[]> {
    const assetRoot = this.#assetRoot(packId, assetId);
    let entries;
    try {
      entries = await readdir(assetRoot, { withFileTypes: true });
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const revisions: PackRevisionEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !REVISION_DIRECTORY.test(entry.name)) continue;
      const revision = await this.#readEntry(join(assetRoot, entry.name));
      if (revision.packId !== packId || revision.assetId !== assetId || entry.name !== `${revision.revision}-${revision.previewId}`) {
        throw new AdminError("invalid_pack_revision", "Pack revision directory identity does not match its record.");
      }
      revisions.push(revision);
    }
    revisions.sort((left, right) => left.revision - right.revision);
    return Object.freeze(revisions);
  }

  async commit(
    claimed: ClaimedPackRenderPreview,
    revision: number,
    acceptedAt: string,
  ): Promise<PackRevisionEntry> {
    safeRevision(revision);
    const record = claimed.record;
    const accepted = new Date(acceptedAt);
    if (!Number.isFinite(accepted.getTime())) {
      throw new AdminError("invalid_pack_revision", "Revision acceptance time is invalid.");
    }
    const assetRoot = this.#assetRoot(record.packId, record.assetId);
    await mkdir(assetRoot, { recursive: true, mode: 0o700 });
    const finalDirectory = join(assetRoot, `${revision}-${record.previewId}`);
    const existing = await this.list(record.packId, record.assetId);
    if (existing.some((entry) => entry.revision === revision || entry.previewId === record.previewId)) {
      throw new AdminError("pack_revision_state_conflict", `Revision ${revision} already exists for ${record.assetId}.`, 409);
    }
    const temporary = join(assetRoot, `.pending-${randomBytes(12).toString("hex")}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await Promise.all([
        copyFile(claimed.task.sourcePath, join(temporary, "source.png")),
        copyFile(claimed.task.outputPath, join(temporary, "publication.png")),
        copyFile(claimed.task.receiptPath, join(temporary, "receipt.json")),
      ]);
      const revisionRecord: PackRevisionRecord = Object.freeze({
        schemaVersion: RECORD_VERSION,
        recordType: "visionx.pack-workspace-revision",
        packId: record.packId,
        assetId: record.assetId,
        revision,
        previewId: record.previewId,
        acceptedAt: accepted.toISOString(),
        sourceBasename: record.sourceBasename,
        timeframe: record.timeframe,
        dataAsOf: record.dataAsOf,
        outputSha256: record.outputSha256,
        sourceSha256: record.sourceSha256,
        receiptSha256: record.receiptSha256,
      });
      await writeExclusive(join(temporary, "revision.json"), Buffer.from(`${JSON.stringify(revisionRecord, null, 2)}\n`, "utf8"));
      await rename(temporary, finalDirectory);
      return await this.#readEntry(finalDirectory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (error instanceof AdminError) throw error;
      throw new AdminError("pack_revision_write_failed", "Could not preserve accepted Pack revision evidence.", 500);
    }
  }

  async readArtifact(
    packId: string,
    assetId: string,
    revision: number,
    artifact: PackRevisionArtifactName,
  ): Promise<Buffer> {
    safeRevision(revision);
    const entry = (await this.list(packId, assetId)).find((candidate) => candidate.revision === revision);
    if (entry === undefined) {
      throw new AdminError("pack_revision_not_found", `Revision ${revision} was not found.`, 404);
    }
    return regularBytes(
      artifact === "publication.png" ? entry.publicationPath : entry.receiptPath,
      artifact === "publication.png" ? "Pack revision publication" : "Pack revision receipt",
    );
  }

  async delete(packId: string, assetId: string, revision: number): Promise<PackRevisionEntry> {
    safeRevision(revision);
    const entry = (await this.list(packId, assetId)).find((candidate) => candidate.revision === revision);
    if (entry === undefined) {
      throw new AdminError("pack_revision_not_found", `Revision ${revision} was not found.`, 404);
    }
    await rm(entry.directory, { recursive: true, force: false });
    return entry;
  }

  async clearAsset(packId: string, assetId: string): Promise<void> {
    await rm(this.#assetRoot(packId, assetId), { recursive: true, force: true });
  }

  async clearPack(pack: Pack): Promise<void> {
    await Promise.all(pack.assets.map((assetId) => this.clearAsset(pack.id, assetId)));
  }

  async reconcile(
    workspace: Workspace,
    accepted: readonly CompletedPackRenderPreview[],
  ): Promise<void> {
    for (const pack of workspace.packs()) {
      for (const assetId of pack.assets) {
        const capture = workspace.captureOf(assetId);
        if (capture === null || (await this.list(pack.id, assetId)).length > 0) continue;
        const candidates = accepted
          .filter((item) => item.record.packId === pack.id && item.record.assetId === assetId)
          .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
          .slice(-capture.revisions);
        if (candidates.length !== capture.revisions) continue;
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          if (candidate === undefined) continue;
          await this.commit(candidate, index + 1, candidate.completedAt);
        }
      }
    }
  }
}

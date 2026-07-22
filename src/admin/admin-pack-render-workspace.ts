import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  validateChartPublicationTimeframe,
  type ChartPublicationTimeframe,
} from "../application/chart-publication-preview.ts";
import { AdminError } from "./admin-types.ts";

const PREVIEW_ID = /^[a-f0-9]{32}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SOURCE_FILENAME = /^[^\u0000-\u001f\u007f/\\]{1,240}\.png$/iu;
const RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "recordType",
  "previewId",
  "packId",
  "assetId",
  "sourceBasename",
  "timeframe",
  "dataAsOf",
  "outputSha256",
  "sourceSha256",
  "receiptSha256",
  "registrySourceSha256",
  "packSourceSha256",
  "channelConfigurationSha256",
] as const);

type PreviewArea = "previews" | "accepting" | "accepted";
export type PackRenderPreviewArtifactName = "publication.png" | "receipt.json";

export interface PackRenderPreviewTask {
  readonly previewId: string;
  readonly directory: string;
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly recordPath: string;
}

export interface PackRenderPreviewRecord {
  readonly schemaVersion: 1;
  readonly recordType: "visionx.pack-render-preview";
  readonly previewId: string;
  readonly packId: string;
  readonly assetId: string;
  readonly sourceBasename: string;
  readonly timeframe: ChartPublicationTimeframe;
  readonly dataAsOf: string;
  readonly outputSha256: string;
  readonly sourceSha256: string;
  readonly receiptSha256: string;
  readonly registrySourceSha256: string;
  readonly packSourceSha256: string;
  readonly channelConfigurationSha256: string;
}

export interface ClaimedPackRenderPreview {
  readonly task: PackRenderPreviewTask;
  readonly record: PackRenderPreviewRecord;
}

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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function readRegularEvidence(path: string, label: string): Promise<Buffer> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AdminError("invalid_pack_render_preview", `${label} must be a regular non-symlink file.`);
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError("invalid_pack_render_preview", `${label} is unavailable.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown, expectedPreviewId: string): PackRenderPreviewRecord {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...RECORD_FIELDS].sort().join("\0")) {
    throw new AdminError("invalid_pack_render_preview", "Pack render preview record has an invalid shape.");
  }
  const timeframe = validateChartPublicationTimeframe(value.timeframe);
  if (
    value.schemaVersion !== 1 ||
    value.recordType !== "visionx.pack-render-preview" ||
    value.previewId !== expectedPreviewId ||
    typeof value.previewId !== "string" || !PREVIEW_ID.test(value.previewId) ||
    typeof value.packId !== "string" || !IDENTIFIER.test(value.packId) ||
    typeof value.assetId !== "string" || !IDENTIFIER.test(value.assetId) ||
    typeof value.sourceBasename !== "string" || !SOURCE_FILENAME.test(value.sourceBasename) || basename(value.sourceBasename) !== value.sourceBasename ||
    !timeframe.ok ||
    typeof value.dataAsOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.dataAsOf) ||
    typeof value.outputSha256 !== "string" || !HASH.test(value.outputSha256) ||
    typeof value.sourceSha256 !== "string" || !HASH.test(value.sourceSha256) ||
    typeof value.receiptSha256 !== "string" || !HASH.test(value.receiptSha256) ||
    typeof value.registrySourceSha256 !== "string" || !HASH.test(value.registrySourceSha256) ||
    typeof value.packSourceSha256 !== "string" || !HASH.test(value.packSourceSha256) ||
    typeof value.channelConfigurationSha256 !== "string" || !HASH.test(value.channelConfigurationSha256)
  ) {
    throw new AdminError("invalid_pack_render_preview", "Pack render preview record contains invalid facts.");
  }
  return Object.freeze({
    schemaVersion: 1,
    recordType: "visionx.pack-render-preview",
    previewId: value.previewId,
    packId: value.packId,
    assetId: value.assetId,
    sourceBasename: value.sourceBasename,
    timeframe: timeframe.timeframe,
    dataAsOf: value.dataAsOf,
    outputSha256: value.outputSha256,
    sourceSha256: value.sourceSha256,
    receiptSha256: value.receiptSha256,
    registrySourceSha256: value.registrySourceSha256,
    packSourceSha256: value.packSourceSha256,
    channelConfigurationSha256: value.channelConfigurationSha256,
  });
}

export class AdminPackRenderWorkspace {
  readonly root: string;
  readonly sessionPath: string;
  readonly stagingRoot: string;
  readonly #areas: Readonly<Record<PreviewArea, string>>;

  private constructor(
    root: string,
    sessionPath: string,
    stagingRoot: string,
    areas: Readonly<Record<PreviewArea, string>>,
  ) {
    this.root = root;
    this.sessionPath = sessionPath;
    this.stagingRoot = stagingRoot;
    this.#areas = areas;
  }

  static async open(workspaceRoot: string): Promise<AdminPackRenderWorkspace> {
    const canonicalWorkspace = await realpath(resolve(workspaceRoot));
    const root = await AdminPackRenderWorkspace.#directory(canonicalWorkspace, "pack-workspace");
    const previews = await AdminPackRenderWorkspace.#directory(root, "previews");
    const accepting = await AdminPackRenderWorkspace.#directory(root, "accepting");
    const accepted = await AdminPackRenderWorkspace.#directory(root, "accepted");
    const stagingRoot = await AdminPackRenderWorkspace.#directory(root, "staging");
    return new AdminPackRenderWorkspace(
      root,
      join(root, "workspace.json"),
      stagingRoot,
      Object.freeze({ previews, accepting, accepted }),
    );
  }

  static async #directory(parent: string, name: string): Promise<string> {
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
    if (!pathInside(parent, canonical)) throw new AdminError("workspace_path_unsafe", `${name} escapes its workspace.`);
    return canonical;
  }

  #task(area: PreviewArea, previewId: string, sourceBasename: string): PackRenderPreviewTask {
    if (!PREVIEW_ID.test(previewId) || !SOURCE_FILENAME.test(sourceBasename) || basename(sourceBasename) !== sourceBasename) {
      throw new AdminError("invalid_pack_render_preview", "Pack render preview identity is invalid.");
    }
    const directory = join(this.#areas[area], previewId);
    if (!pathInside(this.#areas[area], directory)) throw new AdminError("workspace_path_unsafe", "Pack render preview escapes its workspace.");
    return Object.freeze({
      previewId,
      directory,
      sourcePath: join(directory, sourceBasename),
      outputPath: join(directory, "publication.png"),
      receiptPath: join(directory, "receipt.json"),
      recordPath: join(directory, "preview.json"),
    });
  }

  async createPreview(sourceBasename: string, sourceBytes: Buffer): Promise<PackRenderPreviewTask> {
    if (!SOURCE_FILENAME.test(sourceBasename) || basename(sourceBasename) !== sourceBasename || sourceBytes.length === 0) {
      throw new AdminError("invalid_pack_render_preview", "Pack preview requires one safe nonempty TradingView PNG.");
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const previewId = randomBytes(16).toString("hex");
      const task = this.#task("previews", previewId, sourceBasename);
      try { await mkdir(task.directory, { mode: 0o700 }); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
        throw new AdminError("temporary_write_failed", "Could not create the Pack preview workspace.");
      }
      try { await writeExclusive(task.sourcePath, sourceBytes); }
      catch {
        await rm(task.directory, { recursive: true, force: true });
        throw new AdminError("temporary_write_failed", "Could not preserve the Pack preview source.");
      }
      return task;
    }
    throw new AdminError("temporary_write_failed", "Could not allocate a unique Pack preview ID.");
  }

  async finalizePreview(
    task: PackRenderPreviewTask,
    facts: Omit<PackRenderPreviewRecord, "schemaVersion" | "recordType" | "previewId" | "sourceSha256" | "receiptSha256">,
  ): Promise<PackRenderPreviewRecord> {
    const [source, output, receipt] = await Promise.all([
      readRegularEvidence(task.sourcePath, "Pack preview source"),
      readRegularEvidence(task.outputPath, "Pack preview publication"),
      readRegularEvidence(task.receiptPath, "Pack preview receipt"),
    ]);
    if (sha256(output) !== facts.outputSha256) {
      throw new AdminError("invalid_pack_render_preview", "Rendered preview hash does not match its output.");
    }
    const record = parseRecord({
      schemaVersion: 1,
      recordType: "visionx.pack-render-preview",
      previewId: task.previewId,
      ...facts,
      sourceSha256: sha256(source),
      receiptSha256: sha256(receipt),
    }, task.previewId);
    await writeExclusive(task.recordPath, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
    return record;
  }

  async discardPreview(previewId: string): Promise<void> {
    if (!PREVIEW_ID.test(previewId)) throw new AdminError("pack_render_preview_not_found", "Pack render preview was not found.", 404);
    const directory = join(this.#areas.previews, previewId);
    if (!await exists(directory)) throw new AdminError("pack_render_preview_not_found", "Pack render preview was not found.", 404);
    await rm(directory, { recursive: true, force: true });
  }

  async #read(area: PreviewArea, previewId: string): Promise<ClaimedPackRenderPreview> {
    if (!PREVIEW_ID.test(previewId)) throw new AdminError("pack_render_preview_not_found", "Pack render preview was not found.", 404);
    const directory = join(this.#areas[area], previewId);
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AdminError("invalid_pack_render_preview", "Pack render preview workspace is unsafe.");
      }
    } catch (error) {
      if (error instanceof AdminError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw new AdminError("pack_render_preview_not_found", "Pack render preview was not found.", 404);
      }
      throw new AdminError("invalid_pack_render_preview", "Pack render preview workspace is unreadable.");
    }
    const recordPath = join(directory, "preview.json");
    let parsed: unknown;
    try { parsed = JSON.parse((await readRegularEvidence(recordPath, "Pack preview record")).toString("utf8")) as unknown; }
    catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError("invalid_pack_render_preview", "Pack render preview record is unreadable.");
    }
    const record = parseRecord(parsed, previewId);
    const task = this.#task(area, previewId, record.sourceBasename);
    const [source, output, receipt] = await Promise.all([
      readRegularEvidence(task.sourcePath, "Pack preview source"),
      readRegularEvidence(task.outputPath, "Pack preview publication"),
      readRegularEvidence(task.receiptPath, "Pack preview receipt"),
    ]);
    if (
      sha256(source) !== record.sourceSha256 ||
      sha256(output) !== record.outputSha256 ||
      sha256(receipt) !== record.receiptSha256
    ) {
      throw new AdminError("invalid_pack_render_preview", "Pack render preview evidence changed after rendering.");
    }
    return Object.freeze({ task, record });
  }

  async readPreviewArtifact(previewId: string, artifact: PackRenderPreviewArtifactName): Promise<Buffer> {
    const claimed = await this.#read("previews", previewId);
    return readRegularEvidence(
      artifact === "publication.png" ? claimed.task.outputPath : claimed.task.receiptPath,
      artifact === "publication.png" ? "Pack preview publication" : "Pack preview receipt",
    );
  }

  async claimPreview(previewId: string): Promise<ClaimedPackRenderPreview> {
    if (!PREVIEW_ID.test(previewId)) throw new AdminError("pack_render_preview_not_found", "Pack render preview was not found.", 404);
    const source = join(this.#areas.previews, previewId);
    const destination = join(this.#areas.accepting, previewId);
    try { await rename(source, destination); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw new AdminError("pack_render_preview_not_found", "Pack render preview was not found or is already being accepted.", 404);
      }
      throw new AdminError("pack_render_preview_state_conflict", "Pack render preview could not enter acceptance.", 409);
    }
    try { return await this.#read("accepting", previewId); }
    catch (error) {
      await rename(destination, source).catch(() => undefined);
      throw error;
    }
  }

  async releaseClaim(previewId: string): Promise<void> {
    await rename(join(this.#areas.accepting, previewId), join(this.#areas.previews, previewId));
  }

  async completeClaim(previewId: string): Promise<void> {
    await rename(join(this.#areas.accepting, previewId), join(this.#areas.accepted, previewId));
  }
}

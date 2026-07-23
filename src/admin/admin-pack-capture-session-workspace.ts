import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import type { Pack } from "../packs/packs.ts";
import type { Resolver } from "../resolver/index.ts";
import { AdminError } from "./admin-types.ts";

const SESSION_ID = /^[a-f0-9]{32}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PNG_NAME = /^[^\u0000-\u001f\u007f/\\]{1,240}\.png$/iu;
const EXPORT_STAMP = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.png$/iu;
const SESSION_VERSION = 1 as const;
const DEFAULT_MAX_SPAN_MS = 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

interface BaselineFile {
  readonly sha256: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}

export interface PackCaptureCandidate {
  readonly assetId: string;
  readonly filename: string;
  readonly sourceSha256: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly exportedAt: string;
  readonly previewId: string;
  readonly state: "pending" | "accepted";
  readonly acceptedAt: string | null;
  readonly acceptedRevision: number | null;
}

interface StoredSession {
  readonly schemaVersion: typeof SESSION_VERSION;
  readonly recordType: "visionx.pack-capture-session";
  readonly sessionId: string;
  readonly packId: string;
  readonly startedAt: string;
  readonly maxSpanMs: number;
  readonly baseline: Readonly<Record<string, BaselineFile>>;
  readonly candidates: Readonly<Record<string, PackCaptureCandidate>>;
}

export interface PackCaptureSessionState {
  readonly configured: boolean;
  readonly downloadsFolder: string | null;
  readonly active: boolean;
  readonly sessionId: string | null;
  readonly packId: string;
  readonly startedAt: string | null;
  readonly maxSpanMinutes: number;
  readonly candidateCount: number;
  readonly acceptedCount: number;
  readonly pendingCount: number;
  readonly missingAssetIds: readonly string[];
  readonly exportSpanMinutes: number | null;
  readonly publishReady: boolean;
  readonly readinessReason:
    | "downloads_folder_not_configured"
    | "session_not_started"
    | "assets_missing"
    | "previews_pending"
    | "export_window_exceeded"
    | "ready";
  readonly candidates: readonly PackCaptureCandidate[];
}

export interface PlannedPackCapture {
  readonly assetId: string;
  readonly filename: string;
  readonly sourcePath: string;
  readonly sourceBytes: Buffer;
  readonly sourceSha256: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly exportedAt: string;
}

export interface PackCaptureScanPlan {
  readonly sessionId: string;
  readonly packId: string;
  readonly scannedAt: string;
  readonly queued: readonly PlannedPackCapture[];
  readonly unchangedAssetIds: readonly string[];
  readonly ignored: readonly {
    readonly filename: string;
    readonly reason:
      | "baseline_unchanged"
      | "unparseable_filename"
      | "unknown_asset"
      | "asset_not_in_pack"
      | "outside_session_window"
      | "not_newer_than_current";
  }[];
}

export interface QueuedPackCapture {
  readonly assetId: string;
  readonly filename: string;
  readonly sourceSha256: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly exportedAt: string;
  readonly previewId: string;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function parseIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AdminError("invalid_pack_capture_session", `${label} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function exportTimestamp(filename: string): number | null {
  const match = EXPORT_STAMP.exec(filename);
  if (match === null) return null;
  const values = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = values;
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined || minute === undefined || second === undefined
  ) return null;
  const local = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day ||
    local.getHours() !== hour ||
    local.getMinutes() !== minute ||
    local.getSeconds() !== second
  ) return null;
  return local.getTime();
}

function parseBaseline(value: unknown): Readonly<Record<string, BaselineFile>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdminError("invalid_pack_capture_session", "Capture-session baseline is invalid.");
  }
  const result: Record<string, BaselineFile> = {};
  for (const [filename, item] of Object.entries(value)) {
    if (
      !PNG_NAME.test(filename) ||
      typeof item !== "object" || item === null || Array.isArray(item)
    ) throw new AdminError("invalid_pack_capture_session", "Capture-session baseline contains invalid evidence.");
    const record = item as Record<string, unknown>;
    if (
      typeof record.sha256 !== "string" || !HASH.test(record.sha256) ||
      typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size <= 0 ||
      typeof record.modifiedAtMs !== "number" || !Number.isFinite(record.modifiedAtMs)
    ) throw new AdminError("invalid_pack_capture_session", "Capture-session baseline contains invalid file facts.");
    result[filename] = Object.freeze({
      sha256: record.sha256,
      size: record.size,
      modifiedAtMs: record.modifiedAtMs,
    });
  }
  return Object.freeze(result);
}

function parseCandidate(assetId: string, value: unknown): PackCaptureCandidate {
  if (
    !IDENTIFIER.test(assetId) ||
    typeof value !== "object" || value === null || Array.isArray(value)
  ) throw new AdminError("invalid_pack_capture_session", "Capture-session candidate is invalid.");
  const item = value as Record<string, unknown>;
  const modifiedAt = parseIso(item.modifiedAt, "candidate modifiedAt");
  const exportedAt = parseIso(item.exportedAt, "candidate exportedAt");
  const acceptedAt = item.acceptedAt === null ? null : parseIso(item.acceptedAt, "candidate acceptedAt");
  if (
    item.assetId !== assetId ||
    typeof item.filename !== "string" || !PNG_NAME.test(item.filename) ||
    typeof item.sourceSha256 !== "string" || !HASH.test(item.sourceSha256) ||
    typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size <= 0 ||
    typeof item.previewId !== "string" || !SESSION_ID.test(item.previewId) ||
    (item.state !== "pending" && item.state !== "accepted") ||
    (item.acceptedRevision !== null && (
      typeof item.acceptedRevision !== "number" ||
      !Number.isInteger(item.acceptedRevision) ||
      item.acceptedRevision < 1
    )) ||
    (item.state === "pending" && (acceptedAt !== null || item.acceptedRevision !== null)) ||
    (item.state === "accepted" && (acceptedAt === null || item.acceptedRevision === null))
  ) throw new AdminError("invalid_pack_capture_session", "Capture-session candidate contains invalid facts.");
  return Object.freeze({
    assetId,
    filename: item.filename,
    sourceSha256: item.sourceSha256,
    size: item.size,
    modifiedAt,
    exportedAt,
    previewId: item.previewId,
    state: item.state,
    acceptedAt,
    acceptedRevision: item.acceptedRevision as number | null,
  });
}

function parseSession(value: unknown, expectedPackId: string): StoredSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdminError("invalid_pack_capture_session", "Capture-session file is invalid.");
  }
  const item = value as Record<string, unknown>;
  if (
    item.schemaVersion !== SESSION_VERSION ||
    item.recordType !== "visionx.pack-capture-session" ||
    typeof item.sessionId !== "string" || !SESSION_ID.test(item.sessionId) ||
    item.packId !== expectedPackId ||
    typeof item.startedAt !== "string" ||
    typeof item.maxSpanMs !== "number" ||
    !Number.isSafeInteger(item.maxSpanMs) ||
    item.maxSpanMs < 60_000 ||
    item.maxSpanMs > 24 * 60 * 60 * 1000 ||
    typeof item.candidates !== "object" || item.candidates === null || Array.isArray(item.candidates)
  ) throw new AdminError("invalid_pack_capture_session", "Capture-session file contains invalid facts.");
  const startedAt = parseIso(item.startedAt, "session startedAt");
  const candidates: Record<string, PackCaptureCandidate> = {};
  for (const [assetId, candidate] of Object.entries(item.candidates)) {
    candidates[assetId] = parseCandidate(assetId, candidate);
  }
  return Object.freeze({
    schemaVersion: SESSION_VERSION,
    recordType: "visionx.pack-capture-session",
    sessionId: item.sessionId,
    packId: expectedPackId,
    startedAt,
    maxSpanMs: item.maxSpanMs,
    baseline: parseBaseline(item.baseline),
    candidates: Object.freeze(candidates),
  });
}

async function writeAtomic(path: string, value: StoredSession): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class AdminPackCaptureSessionWorkspace {
  readonly root: string;
  readonly downloadsRoot: string | null;

  private constructor(root: string, downloadsRoot: string | null) {
    this.root = root;
    this.downloadsRoot = downloadsRoot;
  }

  static async open(workspaceRoot: string, downloadsRoot?: string): Promise<AdminPackCaptureSessionWorkspace> {
    const canonicalWorkspace = await realpath(resolve(workspaceRoot));
    const root = join(canonicalWorkspace, "pack-workspace", "capture-sessions");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    if (!pathInside(canonicalWorkspace, canonicalRoot)) {
      throw new AdminError("workspace_path_unsafe", "Capture sessions escape the administration workspace.");
    }
    if (downloadsRoot === undefined) {
      return new AdminPackCaptureSessionWorkspace(canonicalRoot, null);
    }
    let stat;
    try { stat = await lstat(resolve(downloadsRoot)); }
    catch { throw new AdminError("chart_downloads_root_invalid", "Chart Downloads folder is unavailable."); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AdminError("chart_downloads_root_invalid", "Chart Downloads folder must be a non-symlink directory.");
    }
    const canonicalDownloads = await realpath(resolve(downloadsRoot));
    if (pathInside(canonicalWorkspace, canonicalDownloads) || pathInside(canonicalDownloads, canonicalWorkspace)) {
      throw new AdminError("path_collision", "Chart Downloads folder and administration workspace must be separate.");
    }
    return new AdminPackCaptureSessionWorkspace(canonicalRoot, canonicalDownloads);
  }

  #path(packId: string): string {
    if (!IDENTIFIER.test(packId)) {
      throw new AdminError("invalid_pack_capture_session", "Pack capture-session identity is invalid.");
    }
    return join(this.root, `${packId}.json`);
  }

  async #read(packId: string): Promise<StoredSession | null> {
    try {
      return parseSession(JSON.parse(await readFile(this.#path(packId), "utf8")), packId);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return null;
      }
      if (error instanceof AdminError) throw error;
      throw new AdminError("invalid_pack_capture_session", "Capture-session file is unreadable.");
    }
  }

  async #snapshot(): Promise<Readonly<Record<string, BaselineFile>>> {
    if (this.downloadsRoot === null) {
      throw new AdminError("chart_downloads_not_configured", "Configure a Chart Downloads folder before starting a capture session.");
    }
    const result: Record<string, BaselineFile> = {};
    for (const entry of await readdir(this.downloadsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !PNG_NAME.test(entry.name)) continue;
      const path = join(this.downloadsRoot, entry.name);
      const canonical = await realpath(path);
      if (!pathInside(this.downloadsRoot, canonical)) continue;
      const stat = await lstat(canonical);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) continue;
      const bytes = await readFile(canonical);
      result[entry.name] = Object.freeze({
        sha256: sha256(bytes),
        size: bytes.length,
        modifiedAtMs: stat.mtimeMs,
      });
    }
    return Object.freeze(result);
  }

  async start(pack: Pack, now = new Date()): Promise<PackCaptureSessionState> {
    if (this.downloadsRoot === null) {
      throw new AdminError("chart_downloads_not_configured", "Configure a Chart Downloads folder before starting a capture session.");
    }
    const session: StoredSession = Object.freeze({
      schemaVersion: SESSION_VERSION,
      recordType: "visionx.pack-capture-session",
      sessionId: randomBytes(16).toString("hex"),
      packId: pack.id,
      startedAt: now.toISOString(),
      maxSpanMs: DEFAULT_MAX_SPAN_MS,
      baseline: await this.#snapshot(),
      candidates: Object.freeze({}),
    });
    await writeAtomic(this.#path(pack.id), session);
    return this.#publicState(pack, session);
  }

  async state(pack: Pack): Promise<PackCaptureSessionState> {
    return this.#publicState(pack, await this.#read(pack.id));
  }

  #publicState(pack: Pack, session: StoredSession | null): PackCaptureSessionState {
    if (session === null) {
      return Object.freeze({
        configured: this.downloadsRoot !== null,
        downloadsFolder: this.downloadsRoot,
        active: false,
        sessionId: null,
        packId: pack.id,
        startedAt: null,
        maxSpanMinutes: DEFAULT_MAX_SPAN_MS / 60_000,
        candidateCount: 0,
        acceptedCount: 0,
        pendingCount: 0,
        missingAssetIds: Object.freeze([...pack.assets]),
        exportSpanMinutes: null,
        publishReady: false,
        readinessReason: this.downloadsRoot === null
          ? "downloads_folder_not_configured"
          : "session_not_started",
        candidates: Object.freeze([]),
      });
    }
    const candidates = pack.assets
      .map((assetId) => session.candidates[assetId])
      .filter((candidate): candidate is PackCaptureCandidate => candidate !== undefined);
    const accepted = candidates.filter((candidate) => candidate.state === "accepted");
    const pending = candidates.filter((candidate) => candidate.state === "pending");
    const missing = pack.assets.filter((assetId) => session.candidates[assetId] === undefined);
    const exportTimes = accepted.map((candidate) => Date.parse(candidate.exportedAt));
    const spanMs = exportTimes.length < 2 ? 0 : Math.max(...exportTimes) - Math.min(...exportTimes);
    const ready = missing.length === 0 && pending.length === 0 &&
      accepted.length === pack.assets.length && spanMs <= session.maxSpanMs;
    const readinessReason = missing.length > 0
      ? "assets_missing"
      : pending.length > 0
        ? "previews_pending"
        : spanMs > session.maxSpanMs
          ? "export_window_exceeded"
          : "ready";
    return Object.freeze({
      configured: this.downloadsRoot !== null,
      downloadsFolder: this.downloadsRoot,
      active: true,
      sessionId: session.sessionId,
      packId: pack.id,
      startedAt: session.startedAt,
      maxSpanMinutes: session.maxSpanMs / 60_000,
      candidateCount: candidates.length,
      acceptedCount: accepted.length,
      pendingCount: pending.length,
      missingAssetIds: Object.freeze(missing),
      exportSpanMinutes: accepted.length === 0 ? null : Math.round((spanMs / 60_000) * 100) / 100,
      publishReady: ready,
      readinessReason,
      candidates: Object.freeze(candidates),
    });
  }

  async planScan(pack: Pack, resolver: Resolver, now = new Date()): Promise<PackCaptureScanPlan> {
    if (this.downloadsRoot === null) {
      throw new AdminError("chart_downloads_not_configured", "Configure a Chart Downloads folder before scanning.");
    }
    const session = await this.#read(pack.id);
    if (session === null) {
      throw new AdminError("pack_capture_session_not_started", "Start a new Pack capture session before scanning.");
    }
    const startedAtMs = Date.parse(session.startedAt);
    const scannedAtMs = now.getTime();
    const packAssets = new Set(pack.assets);
    const ignored: PackCaptureScanPlan["ignored"][number][] = [];
    const eligible = new Map<string, PlannedPackCapture>();

    for (const entry of await readdir(this.downloadsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !PNG_NAME.test(entry.name)) continue;
      const sourcePath = join(this.downloadsRoot, entry.name);
      const canonical = await realpath(sourcePath);
      if (!pathInside(this.downloadsRoot, canonical)) continue;
      const stat = await lstat(canonical);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) continue;
      const sourceBytes = await readFile(canonical);
      const sourceSha256 = sha256(sourceBytes);
      const baseline = session.baseline[entry.name];
      if (baseline?.sha256 === sourceSha256) {
        ignored.push(Object.freeze({ filename: entry.name, reason: "baseline_unchanged" }));
        continue;
      }
      const exportedAtMs = exportTimestamp(entry.name);
      if (exportedAtMs === null) {
        ignored.push(Object.freeze({ filename: entry.name, reason: "unparseable_filename" }));
        continue;
      }
      if (
        exportedAtMs < startedAtMs - CLOCK_TOLERANCE_MS ||
        exportedAtMs > scannedAtMs + CLOCK_TOLERANCE_MS
      ) {
        ignored.push(Object.freeze({ filename: entry.name, reason: "outside_session_window" }));
        continue;
      }
      const resolved = resolver.resolve(entry.name);
      if (!resolved.ok) {
        ignored.push(Object.freeze({
          filename: entry.name,
          reason: resolved.reason === "unparseable_filename" ? "unparseable_filename" : "unknown_asset",
        }));
        continue;
      }
      if (!packAssets.has(resolved.asset.id)) {
        ignored.push(Object.freeze({ filename: entry.name, reason: "asset_not_in_pack" }));
        continue;
      }
      const current = session.candidates[resolved.asset.id];
      if (
        current !== undefined &&
        (current.sourceSha256 === sourceSha256 || exportedAtMs <= Date.parse(current.exportedAt))
      ) {
        ignored.push(Object.freeze({ filename: entry.name, reason: "not_newer_than_current" }));
        continue;
      }
      const planned: PlannedPackCapture = Object.freeze({
        assetId: resolved.asset.id,
        filename: entry.name,
        sourcePath: canonical,
        sourceBytes,
        sourceSha256,
        size: sourceBytes.length,
        modifiedAt: iso(stat.mtimeMs),
        exportedAt: iso(exportedAtMs),
      });
      const prior = eligible.get(resolved.asset.id);
      if (
        prior === undefined ||
        Date.parse(planned.exportedAt) > Date.parse(prior.exportedAt) ||
        (
          planned.exportedAt === prior.exportedAt &&
          Date.parse(planned.modifiedAt) > Date.parse(prior.modifiedAt)
        )
      ) eligible.set(resolved.asset.id, planned);
    }

    const queued = pack.assets
      .map((assetId) => eligible.get(assetId))
      .filter((candidate): candidate is PlannedPackCapture => candidate !== undefined);
    const unchangedAssetIds = pack.assets.filter((assetId) => {
      const current = session.candidates[assetId];
      return current !== undefined && !eligible.has(assetId);
    });
    return Object.freeze({
      sessionId: session.sessionId,
      packId: pack.id,
      scannedAt: now.toISOString(),
      queued: Object.freeze(queued),
      unchangedAssetIds: Object.freeze(unchangedAssetIds),
      ignored: Object.freeze(ignored),
    });
  }

  async commitScan(pack: Pack, sessionId: string, queued: readonly QueuedPackCapture[]): Promise<PackCaptureSessionState> {
    const current = await this.#read(pack.id);
    if (current === null || current.sessionId !== sessionId) {
      throw new AdminError("pack_capture_session_state_conflict", "Pack capture session changed while charts were being rendered.", 409);
    }
    const candidates: Record<string, PackCaptureCandidate> = { ...current.candidates };
    for (const item of queued) {
      if (
        !pack.assets.includes(item.assetId) ||
        !PNG_NAME.test(item.filename) ||
        !HASH.test(item.sourceSha256) ||
        !SESSION_ID.test(item.previewId)
      ) throw new AdminError("invalid_pack_capture_session", "Queued Pack capture evidence is invalid.");
      candidates[item.assetId] = Object.freeze({
        assetId: item.assetId,
        filename: item.filename,
        sourceSha256: item.sourceSha256,
        size: item.size,
        modifiedAt: parseIso(item.modifiedAt, "queued modifiedAt"),
        exportedAt: parseIso(item.exportedAt, "queued exportedAt"),
        previewId: item.previewId,
        state: "pending",
        acceptedAt: null,
        acceptedRevision: null,
      });
    }
    const updated: StoredSession = Object.freeze({
      ...current,
      candidates: Object.freeze(candidates),
    });
    await writeAtomic(this.#path(pack.id), updated);
    return this.#publicState(pack, updated);
  }

  async markAccepted(previewId: string, revision: number, acceptedAt = new Date()): Promise<void> {
    if (!SESSION_ID.test(previewId) || !Number.isInteger(revision) || revision < 1) return;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const packId = basename(entry.name, ".json");
      if (!IDENTIFIER.test(packId)) continue;
      const session = await this.#read(packId);
      if (session === null) continue;
      const match = Object.values(session.candidates).find((candidate) => candidate.previewId === previewId);
      if (match === undefined || match.state === "accepted") continue;
      const candidates = {
        ...session.candidates,
        [match.assetId]: Object.freeze({
          ...match,
          state: "accepted" as const,
          acceptedAt: acceptedAt.toISOString(),
          acceptedRevision: revision,
        }),
      };
      await writeAtomic(this.#path(packId), Object.freeze({
        ...session,
        candidates: Object.freeze(candidates),
      }));
      return;
    }
  }

  async removePendingPreview(previewId: string): Promise<void> {
    if (!SESSION_ID.test(previewId)) return;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const packId = basename(entry.name, ".json");
      if (!IDENTIFIER.test(packId)) continue;
      const session = await this.#read(packId);
      if (session === null) continue;
      const match = Object.values(session.candidates).find((candidate) =>
        candidate.previewId === previewId && candidate.state === "pending"
      );
      if (match === undefined) continue;
      const candidates = { ...session.candidates };
      delete candidates[match.assetId];
      await writeAtomic(this.#path(packId), Object.freeze({
        ...session,
        candidates: Object.freeze(candidates),
      }));
      return;
    }
  }
}

import {
  mkdirSync,
  copyFileSync,
  renameSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Release store — the durable archive of Releases. One Release = one pack
 * publish: an immutable record of "the complete <Pack> thesis at <moment>",
 * holding its own copies of every chart image plus a release.json describing
 * exactly what was posted where.
 *
 * RESPONSIBILITY: persistence and record integrity ONLY. The store exposes
 * policy-free facts (create/get/list/imagePath/recordPost/markPublished) and
 * enforces its own invariants (no posts on published records, no double
 * posts, no publish with unposted analyses). It contains NO workflow policy:
 * what counts as "interrupted", "superseded", or "resumable" is decided ABOVE
 * the store, by pure policy over the records it returns.
 *
 * Lifecycle (v1):   publishing -> published — DERIVED, never stored.
 *   - publishedAt === null:  the Release is in flight (or was interrupted).
 *     Message identities are recorded incrementally as each post succeeds, so
 *     an interrupted record states exactly which messages exist.
 *   - publishedAt !== null:  every analysis posted; the Release is the
 *     historical record.
 * There is deliberately NO stored state field: "published" MEANS "there is a
 * moment at which it was published", so the fact carries the lifecycle and a
 * separate state could only agree with it or corrupt it. Everything else
 * ("interrupted", "superseded") is likewise derived by policy from facts.
 *
 * Identity vs. metadata: releaseId is an OPAQUE generated identifier with no
 * semantic meaning (rls_<hex>). startedAt/publishedAt/postedAt are historical
 * facts. Nothing derives identity or structure from time; lifecycle derivation
 * reads only the PRESENCE of the publishedAt fact, never its value.
 *
 * Custody: createRelease() COPIES images from their source paths into the
 * release directory as part of the SAME transactional write that creates the
 * record — a Release record must never exist without custody of its artifacts
 * (archive-before-reset depends on it). The store takes source PATHS and knows
 * nothing about staging as a concept; choosing which files to archive is the
 * caller's job, taking custody of them is the store's. imagePath() is the one
 * definition of where an archived artifact lives; a record whose artifact is
 * missing is a violated invariant (corruption), so imagePath fails LOUD.
 *
 * Durability discipline:
 *   - release.json writes are atomic (temp file + rename), because a torn
 *     record mid-publish would lose message identities that are unrecoverable.
 *   - image copies use the same temp+rename pattern.
 *   - all reads fail LOUD on corrupt/unsupported records (never silently skip).
 *
 * Time is metadata: every timestamp is injected by the caller; the store never
 * reads a clock (releaseId generation uses randomness, not time).
 *
 * Layout:
 *   <archiveDir>/<packId>/<releaseId>/release.json
 *   <archiveDir>/<packId>/<releaseId>/<assetId>.png
 */

export class ReleaseError extends Error {
  constructor(message: string) {
    super(`Release error: ${message}`);
    this.name = "ReleaseError";
  }
}

export interface ReleaseAnalysis {
  readonly assetId: string;
  readonly display: string;
  readonly capturedAt: string;
  /** Image filename within the release directory (e.g. "btc.png"). */
  readonly imageFile: string;
  readonly discordMessageId: string | null;
  readonly postedAt: string | null;
}

export interface ReleaseRecord {
  readonly version: 1;
  readonly releaseId: string;
  readonly packId: string;
  readonly packDisplay: string;
  readonly channelId: string;
  readonly startedAt: string;
  /** null while publishing is in flight; set exactly once when complete. */
  readonly publishedAt: string | null;
  /** Canonical pack order; this array IS the pack-membership snapshot. */
  readonly analyses: readonly ReleaseAnalysis[];
  /** Reserved from v1; accretes in the corrections phase. */
  readonly corrections: readonly unknown[];
}

export interface CreateReleaseAnalysisInput {
  readonly assetId: string;
  readonly display: string;
  readonly capturedAt: string;
  /** Image to take custody of; copied into the archive. */
  readonly sourceImagePath: string;
}

export interface CreateReleaseInput {
  readonly packId: string;
  readonly packDisplay: string;
  readonly channelId: string;
  /** Injected by the caller (ISO-8601). Metadata only — never identity. */
  readonly startedAt: string;
  /** In canonical pack order. */
  readonly analyses: readonly CreateReleaseAnalysisInput[];
}

export interface ReleaseStore {
  /** Take custody of all images and write the record (publishedAt: null). */
  createRelease(input: CreateReleaseInput): ReleaseRecord;
  getRelease(packId: string, releaseId: string): ReleaseRecord;
  /** ALL release records for a pack, unordered. Policy-free facts. */
  listReleases(packId: string): readonly ReleaseRecord[];
  /**
   * Absolute path of an archived image belonging to a release. Throws if the
   * file is missing: a record without custody of its artifacts is a violated
   * invariant (corruption), not an operational outcome.
   */
  imagePath(packId: string, releaseId: string, imageFile: string): string;
  /** Record one successful Discord post (incremental, atomic). */
  recordPost(
    packId: string,
    releaseId: string,
    assetId: string,
    discordMessageId: string,
    postedAt: string,
  ): ReleaseRecord;
  /** Set publishedAt. Requires every analysis to have been posted. */
  markPublished(packId: string, releaseId: string, publishedAt: string): ReleaseRecord;
}

const VERSION = 1 as const;

// Conservative safe-id charset (same rule as staging; duplicated deliberately —
// second use, and importing from wiring/ would invert layering).
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeId(kind: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseError(`${kind} must be a non-empty string`);
  }
  if (value === "." || value === "..") {
    throw new ReleaseError(`${kind} "${value}" is not a valid path segment`);
  }
  if (!SAFE_ID.test(value)) {
    throw new ReleaseError(`${kind} "${value}" contains unsafe characters (allowed: A-Z a-z 0-9 . _ -)`);
  }
}

/** Opaque release identity: no semantic meaning, no time involvement. */
function generateReleaseId(): string {
  return `rls_${randomBytes(8).toString("hex")}`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/**
 * Validate raw parsed JSON into a ReleaseRecord, or throw a clear error.
 *
 * Every field is bound to a LOCAL before validation: TypeScript does not
 * narrow repeated indexed accesses (o["x"]) under noUncheckedIndexedAccess,
 * so each value is read once, guarded, and then used from its narrowed local.
 */
function parseRecord(raw: unknown, sourcePath: string): ReleaseRecord {
  const corrupt = (why: string): ReleaseError =>
    new ReleaseError(`corrupt release record at ${sourcePath}: ${why}`);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw corrupt("not an object");
  }
  const o = raw as Record<string, unknown>;

  const version = o["version"];
  if (version !== VERSION) throw corrupt(`unsupported version: ${String(version)}`);

  const releaseId = o["releaseId"];
  if (!isNonEmptyString(releaseId)) throw corrupt("releaseId must be a non-empty string");

  const packId = o["packId"];
  if (!isNonEmptyString(packId)) throw corrupt("packId must be a non-empty string");

  const packDisplay = o["packDisplay"];
  if (!isNonEmptyString(packDisplay)) throw corrupt("packDisplay must be a non-empty string");

  const channelId = o["channelId"];
  if (!isNonEmptyString(channelId)) throw corrupt("channelId must be a non-empty string");

  const startedAt = o["startedAt"];
  if (!isNonEmptyString(startedAt)) throw corrupt("startedAt must be a non-empty string");

  const publishedAt = o["publishedAt"];
  if (!isStringOrNull(publishedAt)) throw corrupt("publishedAt must be a string or null");

  const analysesRaw = o["analyses"];
  if (!Array.isArray(analysesRaw)) throw corrupt("analyses must be an array");

  const correctionsRaw = o["corrections"];
  if (!Array.isArray(correctionsRaw)) throw corrupt("corrections must be an array");

  const analyses: ReleaseAnalysis[] = [];
  for (const item of analysesRaw) {
    if (typeof item !== "object" || item === null) throw corrupt("analysis entry is not an object");
    const a = item as Record<string, unknown>;

    const assetId = a["assetId"];
    if (!isNonEmptyString(assetId)) throw corrupt("analysis assetId must be a non-empty string");

    const display = a["display"];
    if (!isNonEmptyString(display)) throw corrupt("analysis display must be a non-empty string");

    const capturedAt = a["capturedAt"];
    if (!isNonEmptyString(capturedAt)) throw corrupt("analysis capturedAt must be a non-empty string");

    const imageFile = a["imageFile"];
    if (!isNonEmptyString(imageFile)) throw corrupt("analysis imageFile must be a non-empty string");

    const discordMessageId = a["discordMessageId"];
    if (!isStringOrNull(discordMessageId)) throw corrupt("analysis discordMessageId must be string or null");

    const postedAt = a["postedAt"];
    if (!isStringOrNull(postedAt)) throw corrupt("analysis postedAt must be string or null");

    analyses.push({ assetId, display, capturedAt, imageFile, discordMessageId, postedAt });
  }

  return {
    version: VERSION,
    releaseId,
    packId,
    packDisplay,
    channelId,
    startedAt,
    publishedAt,
    analyses,
    corrections: [...correctionsRaw],
  };
}

export function createReleaseStore(archiveDir: string): ReleaseStore {
  const root = resolve(archiveDir);

  function packDir(packId: string): string {
    assertSafeId("packId", packId);
    const dir = resolve(root, packId);
    if (dir !== join(root, packId)) {
      throw new ReleaseError(`packId "${packId}" resolves outside the archive root`);
    }
    return dir;
  }

  function releaseDir(packId: string, releaseId: string): string {
    const pdir = packDir(packId);
    assertSafeId("releaseId", releaseId);
    const dir = resolve(pdir, releaseId);
    if (dir !== join(pdir, releaseId)) {
      throw new ReleaseError(`releaseId "${releaseId}" resolves outside the pack directory`);
    }
    return dir;
  }

  /** THE one definition of where a release record lives. */
  function recordPath(packId: string, releaseId: string): string {
    return join(releaseDir(packId, releaseId), "release.json");
  }

  /** Atomic record write: temp file in the same dir, then rename into place. */
  function writeRecord(record: ReleaseRecord): void {
    const dir = releaseDir(record.packId, record.releaseId);
    const dest = recordPath(record.packId, record.releaseId);
    const tmp = join(dir, `.release.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
      renameSync(tmp, dest);
    } catch (e) {
      try {
        if (existsSync(tmp)) rmSync(tmp);
      } catch {
        /* ignore cleanup error */
      }
      throw new ReleaseError(
        `failed to write release record ${record.packId}/${record.releaseId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function readRecord(packId: string, releaseId: string): ReleaseRecord {
    const path = recordPath(packId, releaseId);
    if (!existsSync(path)) {
      throw new ReleaseError(`no release record at ${path}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ReleaseError(
        `corrupt release record at ${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    return parseRecord(raw, path);
  }

  return {
    createRelease(input: CreateReleaseInput): ReleaseRecord {
      if (!isNonEmptyString(input.packDisplay)) {
        throw new ReleaseError("packDisplay must be a non-empty string");
      }
      if (!isNonEmptyString(input.channelId)) {
        throw new ReleaseError("channelId must be a non-empty string");
      }
      if (!isNonEmptyString(input.startedAt)) {
        throw new ReleaseError("startedAt must be a non-empty ISO-8601 string");
      }
      if (input.analyses.length === 0) {
        throw new ReleaseError("cannot create a release with no analyses");
      }

      // Pre-flight EVERYTHING before creating anything: a failure here must
      // leave zero side effects (no half-born release directories).
      const seen = new Set<string>();
      for (const a of input.analyses) {
        assertSafeId("assetId", a.assetId);
        if (seen.has(a.assetId)) {
          throw new ReleaseError(`duplicate assetId "${a.assetId}" in release input`);
        }
        seen.add(a.assetId);
        if (!isNonEmptyString(a.display)) {
          throw new ReleaseError(`analysis "${a.assetId}": display must be a non-empty string`);
        }
        if (!isNonEmptyString(a.capturedAt)) {
          throw new ReleaseError(`analysis "${a.assetId}": capturedAt must be a non-empty string`);
        }
        if (!existsSync(a.sourceImagePath)) {
          throw new ReleaseError(
            `analysis "${a.assetId}": source image does not exist: ${a.sourceImagePath}`,
          );
        }
      }

      // Opaque identity, collision-retried against the directory (vanishingly
      // unlikely, but generation must never silently reuse an existing id).
      let releaseId = generateReleaseId();
      let dir = releaseDir(input.packId, releaseId);
      while (existsSync(dir)) {
        releaseId = generateReleaseId();
        dir = releaseDir(input.packId, releaseId);
      }

      mkdirSync(dir, { recursive: true });

      // Take custody: copy every image in (temp+rename per file). Custody is
      // part of the transactional write — a record never exists without it.
      for (const a of input.analyses) {
        const dest = join(dir, `${a.assetId}.png`);
        const tmp = join(dir, `.${a.assetId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
        try {
          copyFileSync(a.sourceImagePath, tmp);
          renameSync(tmp, dest);
        } catch (e) {
          try {
            if (existsSync(tmp)) rmSync(tmp);
          } catch {
            /* ignore cleanup error */
          }
          throw new ReleaseError(
            `failed to archive image for "${a.assetId}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const record: ReleaseRecord = {
        version: VERSION,
        releaseId,
        packId: input.packId,
        packDisplay: input.packDisplay,
        channelId: input.channelId,
        startedAt: input.startedAt,
        publishedAt: null,
        analyses: input.analyses.map((a) => ({
          assetId: a.assetId,
          display: a.display,
          capturedAt: a.capturedAt,
          imageFile: `${a.assetId}.png`,
          discordMessageId: null,
          postedAt: null,
        })),
        corrections: [],
      };

      writeRecord(record);
      return record;
    },

    getRelease(packId: string, releaseId: string): ReleaseRecord {
      return readRecord(packId, releaseId);
    },

    listReleases(packId: string): readonly ReleaseRecord[] {
      const dir = packDir(packId);
      if (!existsSync(dir)) return [];
      const out: ReleaseRecord[] = [];
      for (const entry of readdirSync(dir)) {
        const candidate = join(dir, entry);
        if (!statSync(candidate).isDirectory()) continue;
        if (!existsSync(recordPath(packId, entry))) continue;
        // Fail LOUD on a corrupt record: silently skipping could let policy
        // above conclude "nothing interrupted" over a record we failed to read.
        out.push(readRecord(packId, entry));
      }
      return out;
    },

    imagePath(packId: string, releaseId: string, imageFile: string): string {
      assertSafeId("imageFile", imageFile);
      const dir = releaseDir(packId, releaseId);
      const path = resolve(dir, imageFile);
      if (path !== join(dir, imageFile)) {
        throw new ReleaseError(`imageFile "${imageFile}" resolves outside the release directory`);
      }
      if (!existsSync(path)) {
        throw new ReleaseError(
          `archived image missing for ${packId}/${releaseId}: ${imageFile} — a release record must never exist without custody of its artifacts`,
        );
      }
      return path;
    },

    recordPost(
      packId: string,
      releaseId: string,
      assetId: string,
      discordMessageId: string,
      postedAt: string,
    ): ReleaseRecord {
      if (!isNonEmptyString(discordMessageId)) {
        throw new ReleaseError("discordMessageId must be a non-empty string");
      }
      if (!isNonEmptyString(postedAt)) {
        throw new ReleaseError("postedAt must be a non-empty string");
      }
      const record = readRecord(packId, releaseId);
      if (record.publishedAt !== null) {
        throw new ReleaseError(
          `cannot record a post on release ${packId}/${releaseId} — it is already published`,
        );
      }
      const target = record.analyses.find((a) => a.assetId === assetId);
      if (target === undefined) {
        throw new ReleaseError(`release ${packId}/${releaseId} has no analysis for asset "${assetId}"`);
      }
      if (target.discordMessageId !== null) {
        throw new ReleaseError(
          `analysis "${assetId}" in release ${packId}/${releaseId} was already posted (message ${target.discordMessageId}) — double post`,
        );
      }
      const updated: ReleaseRecord = {
        ...record,
        analyses: record.analyses.map((a) =>
          a.assetId === assetId ? { ...a, discordMessageId, postedAt } : a,
        ),
      };
      writeRecord(updated);
      return updated;
    },

    markPublished(packId: string, releaseId: string, publishedAt: string): ReleaseRecord {
      if (!isNonEmptyString(publishedAt)) {
        throw new ReleaseError("publishedAt must be a non-empty string");
      }
      const record = readRecord(packId, releaseId);
      if (record.publishedAt !== null) {
        throw new ReleaseError(
          `cannot mark release ${packId}/${releaseId} published — it is already published`,
        );
      }
      const unposted = record.analyses.filter((a) => a.discordMessageId === null);
      if (unposted.length > 0) {
        throw new ReleaseError(
          `cannot mark release ${packId}/${releaseId} published: ${unposted.length} analysis(es) not posted (${unposted
            .map((a) => a.assetId)
            .join(", ")})`,
        );
      }
      const updated: ReleaseRecord = { ...record, publishedAt };
      writeRecord(updated);
      return updated;
    },
  };
}
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Pack loader + validator.
 *
 * Packs are defined as an ORDERED array in definitions/packs.json; the array order
 * IS the publishing/workflow order. Each pack lists internal asset IDs (e.g.
 * "btc"), NOT TradingView symbols — so packs are insulated from filename
 * reconciliation. Every asset ID is validated against the registry on load.
 *
 * CHANNEL ASSIGNMENT IS PACK-OWNED (Constitution §2.1, §5.3): each pack names
 * its Discord channel by channel NAME. The name must exist in the
 * installation's channels config (definition COHERENCE, checked here);
 * whether that name has a provisioned Discord ID is publish's concern
 * (fail-closed there), never load's.
 *
 * Validated loudly (throws PackError) on:
 *   - non-array or empty packs file
 *   - missing / duplicate pack id
 *   - missing display
 *   - missing channel / channel name not present in the channels config
 *   - empty assets array
 *   - duplicate asset id WITHIN a pack
 *   - asset id not found in the registry
 *
 * CROSS-PACK REUSE: an asset MAY appear in more than one pack. This is allowed
 * deliberately — packs are published one at a time, so the same asset belonging
 * to (say) both a "Morning Crypto" and an "Evening Crypto" pack is a valid
 * future use. We therefore do NOT check for the same asset id across different
 * packs; only duplicates *within a single pack* are rejected.
 *
 * WRITE SIDE: createPack (Constitution §5.3) persists a new Pack with its
 * initial membership, validate-before-write through buildPacks (reused
 * unchanged), byte-preservingly. Loading and the other §5.2/§5.3/§5.4 Pack
 * edits are separate concerns; only creation is implemented here.
 */

export interface Pack {
  readonly id: string;
  readonly display: string;
  /** Assigned channel NAME (Pack-owned; channels config maps name -> Discord ID). */
  readonly channel: string;
  readonly assets: readonly string[]; // internal asset IDs, in workflow order
}

export class PackError extends Error {
  constructor(message: string) {
    super(`Pack error: ${message}`);
    this.name = "PackError";
  }
}

interface RawPack {
  id?: unknown;
  display?: unknown;
  channel?: unknown;
  assets?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Build a validated, ordered list of Packs from already-parsed data. Pure (no
 * I/O) so tests inject their own packs + valid-id set + channel-name set.
 *
 * @param raw           parsed packs.json (must be an array)
 * @param validIds      set of asset IDs known to the registry
 * @param channelNames  set of channel NAMES known to the channels config.
 *                      Membership is definition coherence; whether a name has
 *                      a provisioned Discord ID is publish's concern.
 */
export function buildPacks(
  raw: unknown,
  validIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
): readonly Pack[] {
  if (!Array.isArray(raw)) {
    throw new PackError("packs.json must be a JSON array (array order = publishing order)");
  }
  if (raw.length === 0) {
    throw new PackError("packs.json is empty — at least one pack is required");
  }

  const packs: Pack[] = [];
  const seenPackIds = new Set<string>();

  raw.forEach((entry: RawPack, index) => {
    const where = `pack[${index}]`;

    if (typeof entry !== "object" || entry === null) {
      throw new PackError(`${where} is not an object`);
    }
    if (!isNonEmptyString(entry.id)) {
      throw new PackError(`${where}.id must be a non-empty string`);
    }
    if (seenPackIds.has(entry.id)) {
      throw new PackError(`duplicate pack id: "${entry.id}"`);
    }
    if (!isNonEmptyString(entry.display)) {
      throw new PackError(`pack "${entry.id}".display must be a non-empty string`);
    }
    if (!isNonEmptyString(entry.channel)) {
      throw new PackError(`pack "${entry.id}".channel must be a non-empty string`);
    }
    if (!channelNames.has(entry.channel)) {
      throw new PackError(
        `pack "${entry.id}".channel "${entry.channel}" not found in channels config`,
      );
    }
    if (!Array.isArray(entry.assets) || entry.assets.length === 0) {
      throw new PackError(`pack "${entry.id}".assets must be a non-empty array`);
    }

    const seenAssets = new Set<string>();
    for (const assetId of entry.assets) {
      if (!isNonEmptyString(assetId)) {
        throw new PackError(`pack "${entry.id}" has a non-string asset id`);
      }
      if (seenAssets.has(assetId)) {
        throw new PackError(`pack "${entry.id}" lists duplicate asset id "${assetId}"`);
      }
      if (!validIds.has(assetId)) {
        throw new PackError(`pack "${entry.id}" references unknown asset id "${assetId}" (not in registry)`);
      }
      seenAssets.add(assetId);
    }

    seenPackIds.add(entry.id);
    packs.push({ id: entry.id, display: entry.display, channel: entry.channel, assets: [...entry.assets] });
  });

  return packs;
}

/**
 * Load + validate packs from the supplied file on disk, checking asset IDs
 * against the supplied registry-derived valid-id set and channel assignments
 * against the supplied channel-name universe. Location and both dependencies
 * are injected — this store reads only its own file, decides no filesystem
 * paths, and performs no hidden loads (the composition root supplies all
 * three; the dependency shapes are the ones buildPacks declares).
 */
export function loadPacks(
  packsPath: string,
  validIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
): readonly Pack[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packsPath, "utf8"));
  } catch (e) {
    throw new PackError(`could not read/parse ${packsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return buildPacks(raw, validIds, channelNames);
}
/**
 * Input for createPack: the new Pack's id, display, channel assignment, and its
 * INITIAL membership (Constitution §5.3 Create Pack; per the ratified operator
 * ruling a Pack is created WITH its members — an asset-less Pack is not a valid
 * definition, so `assets` must be non-empty, exactly as buildPacks already
 * requires). Members are internal asset ids, in workflow order.
 */
export interface CreatePackInput {
  readonly id: string;
  readonly display: string;
  readonly channel: string;
  readonly assets: readonly string[];
}

/**
 * Create a new Pack definition through Pack-owned persistence (Constitution
 * §5.3 Create Pack: "ungated, in any state, unconfirmed"). This store owns the
 * packs file; creation is validate-before-write over the WHOLE candidate.
 *
 * INITIAL MEMBERSHIP (ratified operator ruling): a Pack is created WITH its
 * members. `buildPacks` is reused UNCHANGED — its existing non-empty-membership
 * rule stands; no validator relaxation is part of this boundary. Subsequent
 * membership changes are §5.2's concern (not implemented here).
 *
 * VALIDATE-BEFORE-WRITE: the complete candidate pack array (every existing pack
 * plus the new one) is validated with buildPacks — the SAME validator the load
 * path trusts — before a byte is written. Duplicate pack id, unknown/blank
 * channel, empty/duplicate/unknown assets all fail loudly here exactly as they
 * would on load. The registry-derived valid-id set and channel-name universe
 * are injected (delivery supplies them, as for loadPacks); this store reads
 * only its own file and decides no filesystem paths.
 *
 * BYTE-PRESERVING APPEND: packs.json is operator-owned data recovered via
 * version control (Constitution §2.2.1). The writer never re-serializes the
 * file: it inserts one pack object before the closing "]" and leaves every
 * existing byte — each pack's fields, order, and formatting — verbatim,
 * preserving the file's own trailing convention. As a final guard the new text
 * is re-parsed and compared to the validated candidate; on ANY divergence it
 * throws with nothing written.
 *
 * @param packsPath     location of the packs file (array of pack objects)
 * @param validIds      set of asset ids known to the registry
 * @param channelNames  set of channel names known to the channels config
 * @param input         the new pack definition, with initial membership
 * @returns the created Pack as validated within the candidate array
 */
export function createPack(
  packsPath: string,
  validIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
  input: CreatePackInput,
): Pack {
  // Read the current definition of record: raw TEXT (for the byte-preserving
  // append) and parsed array (for validation).
  let packsText: string;
  let rawPacks: unknown;
  try {
    packsText = readFileSync(packsPath, "utf8");
    rawPacks = JSON.parse(packsText);
  } catch (e) {
    throw new PackError(`could not read/parse ${packsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(rawPacks)) {
    throw new PackError("packs.json must be a JSON array (array order = publishing order)");
  }
  const current = rawPacks as RawPack[];

  // Creation-specific identity guard: refuse a duplicate pack id loudly BEFORE
  // building the candidate (buildPacks would also catch it, but this names the
  // creation intent precisely).
  if (!isNonEmptyString(input.id)) {
    throw new PackError("pack id must be a non-empty string");
  }
  for (const p of current) {
    if (p !== null && typeof p === "object" && (p as RawPack).id === input.id) {
      throw new PackError(`pack id "${input.id}" already exists`);
    }
  }

  // The new pack entry, fields in the file's canonical order. The COMPLETE
  // candidate pack array is current ∪ { new } — validated as a whole below.
  const entry: RawPack = {
    id: input.id,
    display: input.display,
    channel: input.channel,
    assets: [...input.assets],
  };
  const candidate: unknown[] = [...current, entry];

  // Validate-before-write: the whole candidate through the load-path validator
  // (reused unchanged — non-empty membership required).
  const validated = buildPacks(candidate, validIds, channelNames);

  // Byte-preserving append. Keep everything up to the final closing "]" verbatim;
  // insert one pack object; restore the file's own trailing convention.
  const hadTrailingNewline = /\n$/.test(packsText);
  const trimmedEnd = packsText.replace(/\s+$/u, "");
  if (!trimmedEnd.endsWith("]")) {
    throw new PackError(`packs file at ${packsPath} does not end with "]" — refusing to write`);
  }
  const body = trimmedEnd.slice(0, -1).replace(/\s+$/u, "");
  const isEmptyArray = body.replace(/\s+$/u, "").endsWith("[");
  const separator = isEmptyArray ? "\n" : ",\n";
  const assetsList = input.assets.map((a) => JSON.stringify(a)).join(", ");
  const entryBlock =
    `  {\n` +
    `    "id": ${JSON.stringify(input.id)},\n` +
    `    "display": ${JSON.stringify(input.display)},\n` +
    `    "channel": ${JSON.stringify(input.channel)},\n` +
    `    "assets": [${assetsList}]\n` +
    `  }`;
  const newText = `${body}${separator}${entryBlock}\n]${hadTrailingNewline ? "\n" : ""}`;

  // Final guard: the appended text must re-parse to EXACTLY the validated
  // candidate. Any divergence means the textual splice was unsafe; throw with
  // nothing written.
  if (JSON.stringify(JSON.parse(newText)) !== JSON.stringify(candidate)) {
    throw new PackError(
      "internal: appended packs text does not match the validated candidate — nothing written",
    );
  }

  writeFileSync(packsPath, newText);

  const created = validated.find((p) => p.id === input.id);
  if (created === undefined) {
    throw new PackError(`internal: created pack "${input.id}" missing from validated packs`);
  }
  return created;
}
import { readFileSync } from "node:fs";

/**
 * Pack loader + validator.
 *
 * Packs are defined as an ORDERED array in config/packs.json; the array order
 * IS the publishing/workflow order. Each pack lists internal asset IDs (e.g.
 * "btc"), NOT TradingView symbols — so packs are insulated from filename
 * reconciliation. Every asset ID is validated against the registry on load.
 *
 * Validated loudly (throws PackError) on:
 *   - non-array or empty packs file
 *   - missing / duplicate pack id
 *   - missing display
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
 * Phase 2A scope: loader/validator only. Nothing here is wired into the running
 * app, the session model, persistence, the UI, staging, or publishing.
 */

export interface Pack {
  readonly id: string;
  readonly display: string;
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
  assets?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Build a validated, ordered list of Packs from already-parsed data. Pure (no
 * I/O) so tests inject their own packs + valid-id set.
 *
 * @param raw       parsed packs.json (must be an array)
 * @param validIds  set of asset IDs known to the registry
 */
export function buildPacks(raw: unknown, validIds: ReadonlySet<string>): readonly Pack[] {
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
    packs.push({ id: entry.id, display: entry.display, assets: [...entry.assets] });
  });

  return packs;
}

/**
 * Load + validate packs from the supplied file on disk, checking asset IDs
 * against the supplied registry-derived valid-id set. Location and registry
 * dependency are injected — this store reads only its own file, decides no
 * filesystem paths, and performs no hidden registry load (the composition
 * root supplies both; the dependency shape is the one buildPacks declares).
 */
export function loadPacks(packsPath: string, validIds: ReadonlySet<string>): readonly Pack[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packsPath, "utf8"));
  } catch (e) {
    throw new PackError(`could not read/parse ${packsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return buildPacks(raw, validIds);
}
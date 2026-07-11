import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Pack } from "./packs.ts";
import { createWorkspace, type Workspace, type AssetCapture } from "./workspace.ts";

/**
 * Persistent working state — the WORKSPACE, persisted. The one durable store
 * is the Workspace's complete fact set (Constitution §2.1, §3-Workspace,
 * §4.1); every pack view is derived from it, so the file contains NO pack
 * structure at all — there is nothing positional to restore and no definition
 * change it can fail on.
 *
 * Durable format (version 3):
 *   { version: 3, captures: AssetCapture[] }
 * The captures array is the Workspace's complete fact set (assetId,
 * capturedAt, revisions). Revision counts are persisted so §7.3's Rev-2
 * indicator survives restart.
 *
 * MIGRATIONS (one-time, demolition-scheduled — Architecture §6): earlier
 * shapes are migrated on load and the file is immediately REWRITTEN in
 * version-3 form; the old shapes are never written again.
 *   - version 1 ({ version: 1, completedPackIds, captured: [{assetId,
 *     capturedAt}] }): captures carry over with revisions: 1 (the honest
 *     floor — v1 never recorded revision history, and history that was never
 *     recorded cannot be invented).
 *   - version 2 ({ version: 2, completedPackIds, captures }): captures carry
 *     over verbatim.
 * In both, completedPackIds — the dead session model's cursor — is DISCARDED:
 * it was bookkeeping of a traversal that no longer exists, and "was this pack
 * published" is the Archive's fact, not working state's. Migration validation
 * is STRUCTURAL only (version token, well-formed capture entries); the old
 * replay-era checks (cursor prefix, active-pack membership) protected a
 * restore-by-replay mechanism that seeding replaced, and they fired on
 * legitimate definition change — the exact failure mode this phase removes.
 * Both migrations are deletable once the production file is confirmed
 * version 3; at the latest, at the runtime flip.
 *
 * Fail closed: any corrupt, unsupported, or malformed saved file throws
 * PersistenceError. Progress is never silently discarded.
 *
 * Auto-save happens after every successful state mutation (capture,
 * resetPack). Writes use the same plain-write discipline as before —
 * durability behavior is unchanged.
 *
 * No singleton, no runtime imports, no UI. Packs and the file path are
 * injected. A pack list of ANY size is legal — zero packs is a legitimate
 * Workspace (§5's bidirectional scaling); existing captures simply become
 * held work (§4.6).
 */

export class PersistenceError extends Error {
  constructor(message: string) {
    super(`Persistence error: ${message}`);
    this.name = "PersistenceError";
  }
}

const VERSION = 3 as const;

interface PersistedState {
  readonly version: typeof VERSION;
  readonly captures: readonly AssetCapture[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Structural validation of one capture entry (v2/v3 shape). */
function parseCapture(item: unknown): AssetCapture {
  if (typeof item !== "object" || item === null) {
    throw new PersistenceError("saved working state: each captures entry must be an object");
  }
  const r = item as Record<string, unknown>;
  const assetId = r["assetId"];
  const capturedAt = r["capturedAt"];
  const revisions = r["revisions"];
  if (!isNonEmptyString(assetId) || !isNonEmptyString(capturedAt)) {
    throw new PersistenceError("saved working state: each captures entry needs string assetId and capturedAt");
  }
  if (typeof revisions !== "number" || !Number.isInteger(revisions) || revisions < 1) {
    throw new PersistenceError(
      `saved working state: captures entry "${assetId}" has invalid revisions (must be an integer >= 1)`,
    );
  }
  return { assetId, capturedAt, revisions };
}

/**
 * TRANSITIONAL — DEMOLITION-SCHEDULED (see module header). Parse + migrate a
 * version-1 file. Structural validation only; the cursor is discarded.
 */
function migrateV1(o: Record<string, unknown>): PersistedState {
  if (!Array.isArray(o["captured"])) {
    throw new PersistenceError("saved working state: captured must be an array");
  }
  const captures: AssetCapture[] = [];
  for (const item of o["captured"]) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>)["assetId"] !== "string" ||
      typeof (item as Record<string, unknown>)["capturedAt"] !== "string"
    ) {
      throw new PersistenceError("saved working state: each captured entry needs string assetId and capturedAt");
    }
    const r = item as { assetId: string; capturedAt: string };
    // revisions: 1 — the honest floor; v1 never recorded revision history.
    captures.push({ assetId: r.assetId, capturedAt: r.capturedAt, revisions: 1 });
  }
  return { version: VERSION, captures };
}

/**
 * TRANSITIONAL — DEMOLITION-SCHEDULED (see module header). Parse + migrate a
 * version-2 file: captures carry over verbatim; the cursor is discarded.
 */
function migrateV2(o: Record<string, unknown>): PersistedState {
  if (!Array.isArray(o["captures"])) {
    throw new PersistenceError("saved working state: captures must be an array");
  }
  return { version: VERSION, captures: o["captures"].map(parseCapture) };
}

/** Parse a version-3 file. */
function parseV3(o: Record<string, unknown>): PersistedState {
  if (!Array.isArray(o["captures"])) {
    throw new PersistenceError("saved working state: captures must be an array");
  }
  return { version: VERSION, captures: o["captures"].map(parseCapture) };
}

/** Parse raw JSON into persisted state, migrating v1/v2 -> v3. Fail loud. */
function parseState(raw: unknown): { state: PersistedState; migrated: boolean } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PersistenceError("saved working state is not an object");
  }
  const o = raw as Record<string, unknown>;
  const version = o["version"];
  if (version === 1) {
    return { state: migrateV1(o), migrated: true };
  }
  if (version === 2) {
    return { state: migrateV2(o), migrated: true };
  }
  if (version === VERSION) {
    return { state: parseV3(o), migrated: false };
  }
  throw new PersistenceError(`unsupported saved working state version: ${String(version)}`);
}

function writeState(path: string, state: PersistedState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

/**
 * The auto-saving Workspace surface: reads delegate to the shared instance;
 * the two mutations persist through the shared save().
 */
function makePersistedWorkspace(workspace: Workspace, save: () => void): Workspace {
  return {
    packs: () => workspace.packs(),
    pack: (packId) => workspace.pack(packId),
    capture(assetId: string, capturedAt: string): AssetCapture {
      const fact = workspace.capture(assetId, capturedAt);
      save(); // save only on successful mutation
      return fact;
    },
    captureOf: (assetId) => workspace.captureOf(assetId),
    captures: () => workspace.captures(),
    packState: (packId) => workspace.packState(packId),
    pendingAssets: (packId) => workspace.pendingAssets(packId),
    capturedFor: (packId) => workspace.capturedFor(packId),
    resetPack(packId: string): void {
      workspace.resetPack(packId);
      save();
    },
  };
}

/**
 * Create the persisted Workspace at `path`.
 *  - file missing          -> fresh state, written to disk
 *  - version-1/2 file      -> migrated, immediately rewritten as version 3
 *  - version-3 file        -> restored (fail-closed on corrupt/malformed)
 */
export function createPersistentWorkspace(opts: {
  packs: readonly Pack[];
  path: string;
}): Workspace {
  const { packs, path } = opts;

  let workspace: Workspace;

  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new PersistenceError(
        `saved working state is corrupt (invalid JSON): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const { state, migrated } = parseState(raw);
    workspace = createWorkspace(packs, state.captures);
    if (migrated) {
      // Rewrite migrated state in the new format immediately: the old shapes
      // are never read twice and never written again.
      writeState(path, { version: VERSION, captures: workspace.captures() });
    }
  } else {
    workspace = createWorkspace(packs);
    writeState(path, { version: VERSION, captures: [] }); // persist fresh state immediately
  }

  const save = (): void => {
    writeState(path, { version: VERSION, captures: workspace.captures() });
  };

  return makePersistedWorkspace(workspace, save);
}
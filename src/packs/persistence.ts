import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Pack } from "./packs.ts";
import {
  SessionError,
  type PackSession,
  type CaptureOutcome,
  type CaptureRecord,
  type Progress,
  type PublishPlan,
} from "./session.ts";
import { createWorkspace, type Workspace, type AssetCapture } from "./workspace.ts";

/**
 * Persistent working state — ONE persisted Workspace, exposed through TWO
 * surfaces over the SAME instance and the SAME save discipline (Session
 * Evolution step 4):
 *
 *   - `workspace`: the constitutional surface (asset-attached capture facts;
 *     derived pack views — Constitution §2.1, §3-Workspace, §4.1). Its two
 *     mutations (capture, resetPack) auto-save.
 *   - `session`: the legacy PackSession COMPATIBILITY surface, byte-for-byte
 *     behavior-compatible with the old session (same outcomes, rejections,
 *     error messages, save timing). Publish/resume still consume it.
 *
 * Both surfaces read and write the one underlying Workspace: a capture
 * through either is immediately visible through the other, and every accepted
 * mutation persists through the one shared save().
 *
 * TRANSITIONAL — DEMOLITION-SCHEDULED (Architecture §6): the cursor
 * (completedPackIds, and with it the entire PackSession surface: activePack/
 * nextPack/advance/isComplete and the capture gates) is COMPATIBILITY-LAYER
 * state, not Workspace state. The Constitution has no cursor (§4.1). It is
 * deleted in the step that removes the PackSession surface, at which point
 * the durable format reaches its ratified final form (no pack structure at
 * all — Session Evolution Ruling 2) and the prefix validation below dies with
 * it. createPersistentSession() is part of that surface and dies with it.
 *
 * Durable format (version 2):
 *   { version: 2, completedPackIds: string[], captures: AssetCapture[] }
 * The captures array is the Workspace's complete fact set (assetId,
 * capturedAt, revisions). Revision counts are persisted so §7.3's Rev-2
 * indicator survives restart.
 *
 * MIGRATION (one-time, demolition-scheduled — Architecture §6): a version-1
 * file ({ version: 1, completedPackIds, captured: [{assetId, capturedAt}] })
 * is migrated on load: captures carry over with revisions: 1 (the honest
 * floor — v1 never recorded revision history, and history that was never
 * recorded cannot be invented), the cursor carries over, and the file is
 * immediately REWRITTEN in version-2 form. The v1 shape is never written
 * again. Migration validates v1 files with the old replay-era checks (cursor
 * prefix; captures must belong to the cursor's active pack) because a v1 file
 * violating them could not have been written by the system and is corrupt.
 * Deletable once the production session.json is confirmed rewritten; at the
 * latest, at the runtime flip.
 *
 * Version-2 validation: the cursor prefix is still checked (the cursor's
 * coherence must hold while the cursor exists), but capture membership is
 * NOT — the Workspace models captures for any asset (held work, §4.6), and a
 * membership check here would rebuild Fossil 1 in the new format.
 *
 * Fail closed: any corrupt, unsupported, malformed, or incompatible saved
 * file throws PersistenceError. Progress is never silently discarded.
 *
 * Auto-save happens only after a successful state mutation. A rejected compat
 * capture does not write. Writes use the same plain-write discipline as
 * before — durability behavior is unchanged by explicit ruling.
 *
 * No singleton, no runtime imports, no UI. Packs and the file path are
 * injected.
 */

export class PersistenceError extends Error {
  constructor(message: string) {
    super(`Session persistence error: ${message}`);
    this.name = "PersistenceError";
  }
}

const VERSION = 2 as const;

interface PersistedState {
  readonly version: typeof VERSION;
  readonly completedPackIds: readonly string[];
  readonly captures: readonly AssetCapture[];
}

/** The two surfaces over one persisted Workspace. */
export interface PersistentWorkspace {
  /** The constitutional surface; capture()/resetPack() auto-save. */
  readonly workspace: Workspace;
  /** TRANSITIONAL compatibility surface (legacy PackSession); dies with the cursor. */
  readonly session: PackSession;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Validate the transitional cursor against the injected packs: completed ids
 * must be a prefix of the pack sequence. This is cursor coherence, not
 * workspace validation; it is deleted with the cursor.
 */
function validateCursor(packs: readonly Pack[], completedPackIds: readonly string[]): void {
  if (completedPackIds.length > packs.length) {
    throw new PersistenceError("saved session lists more completed packs than exist — packs changed");
  }
  for (let i = 0; i < completedPackIds.length; i++) {
    const expected = packs[i] as Pack;
    const got = completedPackIds[i] as string;
    if (expected.id !== got) {
      throw new PersistenceError(
        `saved session completed-pack mismatch ("${expected.id}" vs "${got}") — packs changed`,
      );
    }
  }
}

/** Parse + migrate a version-1 file (one-time; demolition-scheduled). */
function migrateV1(o: Record<string, unknown>, packs: readonly Pack[]): PersistedState {
  if (!isStringArray(o["completedPackIds"])) {
    throw new PersistenceError("saved session: completedPackIds must be an array of strings");
  }
  if (!Array.isArray(o["captured"])) {
    throw new PersistenceError("saved session: captured must be an array");
  }
  const completedPackIds = o["completedPackIds"];
  validateCursor(packs, completedPackIds);

  // The v1 replay-era invariant: every capture belongs to the cursor's active
  // pack (v1 cleared captures on advance, so anything else is corruption).
  const active = completedPackIds.length < packs.length ? (packs[completedPackIds.length] as Pack) : null;

  const captures: AssetCapture[] = [];
  for (const item of o["captured"]) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>)["assetId"] !== "string" ||
      typeof (item as Record<string, unknown>)["capturedAt"] !== "string"
    ) {
      throw new PersistenceError("saved session: each captured entry needs string assetId and capturedAt");
    }
    const r = item as { assetId: string; capturedAt: string };
    if (active === null || !active.assets.includes(r.assetId)) {
      throw new PersistenceError(
        `saved session capture "${r.assetId}" is not valid for the active pack — packs changed`,
      );
    }
    // revisions: 1 — the honest floor; v1 never recorded revision history.
    captures.push({ assetId: r.assetId, capturedAt: r.capturedAt, revisions: 1 });
  }

  return { version: VERSION, completedPackIds, captures };
}

/** Parse a version-2 file. */
function parseV2(o: Record<string, unknown>, packs: readonly Pack[]): PersistedState {
  if (!isStringArray(o["completedPackIds"])) {
    throw new PersistenceError("saved session: completedPackIds must be an array of strings");
  }
  if (!Array.isArray(o["captures"])) {
    throw new PersistenceError("saved session: captures must be an array");
  }
  validateCursor(packs, o["completedPackIds"]);

  const captures: AssetCapture[] = [];
  for (const item of o["captures"]) {
    if (typeof item !== "object" || item === null) {
      throw new PersistenceError("saved session: each captures entry must be an object");
    }
    const r = item as Record<string, unknown>;
    const assetId = r["assetId"];
    const capturedAt = r["capturedAt"];
    const revisions = r["revisions"];
    if (!isNonEmptyString(assetId) || !isNonEmptyString(capturedAt)) {
      throw new PersistenceError("saved session: each captures entry needs string assetId and capturedAt");
    }
    if (typeof revisions !== "number" || !Number.isInteger(revisions) || revisions < 1) {
      throw new PersistenceError(
        `saved session: captures entry "${assetId}" has invalid revisions (must be an integer >= 1)`,
      );
    }
    captures.push({ assetId, capturedAt, revisions });
  }

  return { version: VERSION, completedPackIds: o["completedPackIds"], captures };
}

/** Parse raw JSON into persisted state, migrating v1 -> v2. Fail loud. */
function parseState(raw: unknown, packs: readonly Pack[]): { state: PersistedState; migrated: boolean } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PersistenceError("saved session is not an object");
  }
  const o = raw as Record<string, unknown>;
  const version = o["version"];
  if (version === 1) {
    return { state: migrateV1(o, packs), migrated: true };
  }
  if (version === VERSION) {
    return { state: parseV2(o, packs), migrated: false };
  }
  throw new PersistenceError(`unsupported saved session version: ${String(version)}`);
}

function writeState(path: string, state: PersistedState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

/**
 * The compatibility layer: the legacy PackSession surface over the shared
 * Workspace plus the transitional cursor. Behavior-identical to the old
 * session, including every rejection and error message. TRANSITIONAL —
 * dies with the cursor.
 */
function makeCompatSession(
  packs: readonly Pack[],
  workspace: Workspace,
  completed: string[],
  save: () => void,
): PackSession {
  function active(): Pack | null {
    return completed.length < packs.length ? (packs[completed.length] as Pack) : null;
  }

  function toRecord(c: AssetCapture): CaptureRecord {
    return { assetId: c.assetId, capturedAt: c.capturedAt };
  }

  return {
    activePack(): Pack | null {
      return active();
    },

    nextPack(): Pack | null {
      const n = completed.length + 1;
      return n < packs.length ? (packs[n] as Pack) : null;
    },

    isComplete(): boolean {
      return active() === null;
    },

    capture(assetId: string, capturedAt: string): CaptureOutcome {
      const pack = active();
      if (pack === null) {
        return { ok: false, reason: "no_active_pack" };
      }
      if (!pack.assets.includes(assetId)) {
        return { ok: false, reason: "not_in_active_pack", assetId };
      }
      const fact = workspace.capture(assetId, capturedAt);
      save(); // save only on accepted mutation
      return { ok: true, assetId, replaced: fact.revisions > 1 };
    },

    capturedAssets(): readonly CaptureRecord[] {
      const pack = active();
      return pack ? workspace.capturedFor(pack.id).map(toRecord) : [];
    },

    pendingAssets(): readonly string[] {
      const pack = active();
      return pack ? workspace.pendingAssets(pack.id) : [];
    },

    progress(): Progress | null {
      const pack = active();
      if (!pack) return null;
      return {
        packId: pack.id,
        packDisplay: pack.display,
        captured: workspace.capturedFor(pack.id).length,
        total: pack.assets.length,
        position: completed.length + 1,
        packCount: packs.length,
      };
    },

    publishPack(): PublishPlan {
      const pack = active();
      if (pack === null) {
        throw new SessionError("no active pack to publish (session complete)");
      }
      const captured = workspace.capturedFor(pack.id);
      if (captured.length === 0) {
        throw new SessionError(`pack "${pack.id}" has no captured assets to publish`);
      }
      return {
        packId: pack.id,
        toPublish: captured.map(toRecord),
        total: pack.assets.length,
        capturedCount: captured.length,
        isPartial: captured.length < pack.assets.length,
        pendingAssets: workspace.pendingAssets(pack.id),
      };
    },

    advance(): void {
      const pack = active();
      if (pack === null) {
        throw new SessionError("cannot advance: session already complete");
      }
      // Strictly forward, as before: the instance ends (workspace reset for
      // THIS pack's members) and the transitional cursor moves.
      completed.push(pack.id);
      workspace.resetPack(pack.id);
      save();
    },

    completedPackIds(): readonly string[] {
      return [...completed];
    },

    isAssetInActivePack(assetId: string): boolean {
      const pack = active();
      return pack !== null && pack.assets.includes(assetId);
    },

    hasCaptured(assetId: string): boolean {
      return workspace.captureOf(assetId) !== null;
    },
  };
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
 * Create the persisted working state at `path`: ONE Workspace, TWO surfaces.
 *  - file missing      -> fresh state, written to disk
 *  - version-1 file    -> migrated, immediately rewritten as version 2
 *  - version-2 file    -> restored (fail-closed on corrupt/incompatible)
 */
export function createPersistentWorkspace(opts: {
  packs: readonly Pack[];
  path: string;
}): PersistentWorkspace {
  const { packs, path } = opts;

  if (packs.length === 0) {
    // Same guard (and error type) the pure session enforced.
    throw new SessionError("cannot create a session with no packs");
  }

  let workspace: Workspace;
  let completed: string[];

  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new PersistenceError(
        `saved session is corrupt (invalid JSON): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const { state, migrated } = parseState(raw, packs);
    workspace = createWorkspace(packs, state.captures);
    completed = [...state.completedPackIds];
    if (migrated) {
      // Rewrite migrated state in the new format immediately: the v1 shape
      // is never read twice and never written again.
      writeState(path, { version: VERSION, completedPackIds: completed, captures: workspace.captures() });
    }
  } else {
    workspace = createWorkspace(packs);
    completed = [];
    writeState(path, { version: VERSION, completedPackIds: [], captures: [] }); // persist fresh state immediately
  }

  const save = (): void => {
    writeState(path, {
      version: VERSION,
      completedPackIds: [...completed],
      captures: workspace.captures(),
    });
  };

  return {
    workspace: makePersistedWorkspace(workspace, save),
    session: makeCompatSession(packs, workspace, completed, save),
  };
}

/**
 * TRANSITIONAL — legacy factory for consumers still on the PackSession
 * surface. Delegates to createPersistentWorkspace; dies with that surface.
 */
export function createPersistentSession(opts: { packs: readonly Pack[]; path: string }): PackSession {
  return createPersistentWorkspace(opts).session;
}
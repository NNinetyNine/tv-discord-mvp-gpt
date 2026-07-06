import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Pack } from "./packs.ts";
import {
  createSession,
  type PackSession,
  type CaptureOutcome,
  type CaptureRecord,
} from "./session.ts";

/**
 * Persistence wrapper around the PURE session model.
 *
 * The session model is unchanged and owns NO filesystem code. This wrapper owns
 * all I/O. It serializes using ONLY the session's public API
 * (completedPackIds(), capturedAssets()) and restores by replaying advance()/
 * capture() onto a fresh session — it never reaches into session internals.
 *
 * Only the minimum state is persisted: version, completedPackIds, captured.
 * Derived values (active pack, pending, progress, publish plan) are NEVER
 * persisted; they are always re-derived from the restored session.
 *
 * Fail closed: any corrupt, unsupported, malformed, or incompatible saved file
 * throws PersistenceError. Progress is never silently discarded.
 *
 * Auto-save happens only after a successful state mutation (an accepted capture
 * or an advance). A rejected capture does not write.
 *
 * No singleton, no runtime imports, no UI. Packs and the file path are injected.
 */

export class PersistenceError extends Error {
  constructor(message: string) {
    super(`Session persistence error: ${message}`);
    this.name = "PersistenceError";
  }
}

const VERSION = 1 as const;

interface SessionSnapshot {
  readonly version: typeof VERSION;
  readonly completedPackIds: readonly string[];
  readonly captured: readonly CaptureRecord[];
}

/** Read serializable state out of a live session (public API only). */
function serialize(session: PackSession): SessionSnapshot {
  return {
    version: VERSION,
    completedPackIds: [...session.completedPackIds()],
    captured: session.capturedAssets().map((c) => ({
      assetId: c.assetId,
      capturedAt: c.capturedAt,
    })),
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate raw parsed JSON into a SessionSnapshot, or throw a clear error. */
function parseSnapshot(raw: unknown): SessionSnapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PersistenceError("saved session is not an object");
  }
  const o = raw as Record<string, unknown>;

  if (o["version"] !== VERSION) {
    throw new PersistenceError(`unsupported saved session version: ${String(o["version"])}`);
  }
  if (!isStringArray(o["completedPackIds"])) {
    throw new PersistenceError("saved session: completedPackIds must be an array of strings");
  }
  if (!Array.isArray(o["captured"])) {
    throw new PersistenceError("saved session: captured must be an array");
  }

  const captured: CaptureRecord[] = [];
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
    captured.push({ assetId: r.assetId, capturedAt: r.capturedAt });
  }

  return { version: VERSION, completedPackIds: o["completedPackIds"], captured };
}

/**
 * Rehydrate a session from a snapshot by replaying onto a fresh session.
 * Fail-closed if the snapshot is incompatible with the injected packs.
 */
function restore(packs: readonly Pack[], snap: SessionSnapshot): PackSession {
  const session = createSession(packs);

  // Replay completed packs in order, verifying each matches the expected pack.
  for (const expectedId of snap.completedPackIds) {
    const active = session.activePack();
    if (active === null) {
      throw new PersistenceError("saved session lists more completed packs than exist — packs changed");
    }
    if (active.id !== expectedId) {
      throw new PersistenceError(
        `saved session completed-pack mismatch ("${active.id}" vs "${expectedId}") — packs changed`,
      );
    }
    session.advance();
  }

  // Re-apply captures to the (now) active pack; reject means packs changed.
  for (const rec of snap.captured) {
    const r: CaptureOutcome = session.capture(rec.assetId, rec.capturedAt);
    if (!r.ok) {
      throw new PersistenceError(
        `saved session capture "${rec.assetId}" is not valid for the active pack — packs changed`,
      );
    }
  }

  return session;
}

function writeSnapshot(path: string, session: PackSession): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(serialize(session), null, 2), "utf8");
}

/**
 * Wrap a session so accepted capture()/advance() auto-save to `path`.
 * Reads (activePack, progress, publishPack, etc.) delegate unchanged.
 */
function makePersistent(session: PackSession, path: string): PackSession {
  return {
    activePack: () => session.activePack(),
    nextPack: () => session.nextPack(),
    isComplete: () => session.isComplete(),
    capturedAssets: () => session.capturedAssets(),
    pendingAssets: () => session.pendingAssets(),
    progress: () => session.progress(),
    publishPack: () => session.publishPack(),
    completedPackIds: () => session.completedPackIds(),
    isAssetInActivePack: (assetId: string) => session.isAssetInActivePack(assetId),
    hasCaptured: (assetId: string) => session.hasCaptured(assetId),

    capture(assetId: string, capturedAt: string): CaptureOutcome {
      const r = session.capture(assetId, capturedAt);
      if (r.ok) writeSnapshot(path, session); // save only on accepted mutation
      return r;
    },

    advance(): void {
      session.advance();
      writeSnapshot(path, session);
    },
  };
}

/**
 * Create a persistent session for the given packs at `path`.
 *  - file missing -> fresh session, written to disk
 *  - file present -> restored (fail-closed on corrupt/incompatible)
 */
export function createPersistentSession(opts: { packs: readonly Pack[]; path: string }): PackSession {
  const { packs, path } = opts;

  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new PersistenceError(
        `saved session is corrupt (invalid JSON): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const snap = parseSnapshot(raw);
    const session = restore(packs, snap);
    return makePersistent(session, path);
  }

  const session = createSession(packs);
  const persistent = makePersistent(session, path);
  writeSnapshot(path, session); // persist the fresh session immediately
  return persistent;
}
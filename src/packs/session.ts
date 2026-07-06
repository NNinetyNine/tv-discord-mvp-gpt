import type { Pack } from "./packs.ts";

/**
 * Pure pack session state machine. No filesystem, no JSON, no persistence, no
 * singleton, no runtime wiring — packs are injected. Models one workflow run
 * over an ordered list of packs.
 *
 * Confirmed behaviour:
 *  - The ACTIVE pack is DERIVED from progress (the first not-yet-completed pack
 *    in order), never selected manually.
 *  - Captures are tracked for the ACTIVE pack only.
 *  - Capturing an asset not in the active pack is rejected (state unchanged).
 *  - Re-capturing the same asset REPLACES the prior capture (newest wins).
 *  - publishPack() reports a plan (what would publish, whether PARTIAL) and does
 *    NOT publish or advance — planning and advancing are separate operations.
 *  - advance() is STRICTLY FORWARD: it marks the active pack complete, clears
 *    that pack's captures, and moves to the next. There is no API to go back.
 */

export class SessionError extends Error {
  constructor(message: string) {
    super(`Session error: ${message}`);
    this.name = "SessionError";
  }
}

/** A captured asset within the active pack. (Image/staging refs attach later.) */
export interface CaptureRecord {
  readonly assetId: string;
  readonly capturedAt: string;
}

export interface Progress {
  readonly packId: string;
  readonly packDisplay: string;
  readonly captured: number;
  readonly total: number;
  readonly position: number; // 1-based index of the active pack in the sequence
  readonly packCount: number;
}

export interface PublishPlan {
  readonly packId: string;
  readonly toPublish: readonly CaptureRecord[]; // in canonical pack order
  readonly total: number;
  readonly capturedCount: number;
  readonly isPartial: boolean; // capturedCount < total
  readonly pendingAssets: readonly string[];
}

export type CaptureOutcome =
  | { readonly ok: true; readonly assetId: string; readonly replaced: boolean }
  | { readonly ok: false; readonly reason: "no_active_pack" }
  | { readonly ok: false; readonly reason: "not_in_active_pack"; readonly assetId: string };

export interface PackSession {
  activePack(): Pack | null;
  nextPack(): Pack | null;
  isComplete(): boolean;
  capture(assetId: string, capturedAt: string): CaptureOutcome;
  capturedAssets(): readonly CaptureRecord[]; // canonical pack order
  pendingAssets(): readonly string[]; // canonical pack order
  progress(): Progress | null; // null when complete
  publishPack(): PublishPlan;
  advance(): void;
  completedPackIds(): readonly string[];

  /** Read-only: is the asset a member of the current active pack? false when complete. */
  isAssetInActivePack(assetId: string): boolean;

  /** Read-only: has the asset been captured in the current active pack? */
  hasCaptured(assetId: string): boolean;
}

/**
 * Create a session over an ordered list of packs. The list order is the
 * workflow order; the active pack is derived from how many have been completed.
 */
export function createSession(packs: readonly Pack[]): PackSession {
  if (packs.length === 0) {
    throw new SessionError("cannot create a session with no packs");
  }

  const sequence = packs;
  let activeIndex = 0;
  // captures for the ACTIVE pack only (assetId -> record)
  let captured = new Map<string, CaptureRecord>();
  const completed: string[] = [];

  function active(): Pack | null {
    return activeIndex < sequence.length ? (sequence[activeIndex] as Pack) : null;
  }

  /** captured records ordered by the active pack's canonical asset order */
  function capturedOrdered(pack: Pack): CaptureRecord[] {
    const out: CaptureRecord[] = [];
    for (const assetId of pack.assets) {
      const rec = captured.get(assetId);
      if (rec) out.push(rec);
    }
    return out;
  }

  return {
    activePack(): Pack | null {
      return active();
    },

    nextPack(): Pack | null {
      const n = activeIndex + 1;
      return n < sequence.length ? (sequence[n] as Pack) : null;
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
      const replaced = captured.has(assetId);
      captured.set(assetId, { assetId, capturedAt });
      return { ok: true, assetId, replaced };
    },

    capturedAssets(): readonly CaptureRecord[] {
      const pack = active();
      return pack ? capturedOrdered(pack) : [];
    },

    pendingAssets(): readonly string[] {
      const pack = active();
      if (!pack) return [];
      return pack.assets.filter((a) => !captured.has(a));
    },

    progress(): Progress | null {
      const pack = active();
      if (!pack) return null;
      return {
        packId: pack.id,
        packDisplay: pack.display,
        captured: captured.size,
        total: pack.assets.length,
        position: activeIndex + 1,
        packCount: sequence.length,
      };
    },

    publishPack(): PublishPlan {
      const pack = active();
      if (pack === null) {
        throw new SessionError("no active pack to publish (session complete)");
      }
      const toPublish = capturedOrdered(pack);
      if (toPublish.length === 0) {
        throw new SessionError(`pack "${pack.id}" has no captured assets to publish`);
      }
      return {
        packId: pack.id,
        toPublish,
        total: pack.assets.length,
        capturedCount: toPublish.length,
        isPartial: toPublish.length < pack.assets.length,
        pendingAssets: pack.assets.filter((a) => !captured.has(a)),
      };
    },

    advance(): void {
      const pack = active();
      if (pack === null) {
        throw new SessionError("cannot advance: session already complete");
      }
      // strictly forward: mark complete, move on, clear captures for next pack
      completed.push(pack.id);
      activeIndex += 1;
      captured = new Map<string, CaptureRecord>();
    },

    completedPackIds(): readonly string[] {
      return [...completed];
    },

    isAssetInActivePack(assetId: string): boolean {
      const pack = active();
      return pack !== null && pack.assets.includes(assetId);
    },

    hasCaptured(assetId: string): boolean {
      return captured.has(assetId);
    },
  };
}
import type { Pack } from "./packs.ts";

/**
 * The Workspace — pure working-state model. Replaces the pack SESSION model
 * (Constitution §2.1, §3-Workspace, §4.1): working state is a set of
 * ASSET-ATTACHED capture facts, and every pack view is DERIVED from those
 * facts plus the injected definitions. No filesystem, no JSON, no clock —
 * packs are injected, timestamps are supplied by callers.
 *
 * Stored state is exactly ONE map: assetId -> AssetCapture. Everything else
 * is derived on demand:
 *   - per-pack state (empty | building | complete)  = definitions ∩ captures
 *   - pending assets                                 = definition − captures
 *   - the publish plan                               = capturedFor() in
 *     canonical order (a Complete pack's captures ARE the plan)
 *   - held work (§4.6)                               = captures whose asset is
 *     in no pack — derived by consumers filtering captures() against packs();
 *     never a flag, collection, or concept here
 *   - unknown-asset work                             = captures whose asset
 *     left the registry — same class; preserved inert, surfaced nowhere here
 *   - "replaced"                                     = revisions > 1; not a
 *     stored or returned field (one fact, one encoding)
 *
 * Deliberately ABSENT (each deleted by the ratified Session Evolution rulings
 * and the Workspace API audit):
 *   - no cursor / active pack: §4.1 has no targeting; packs are independent
 *   - no advance(): an instance ends only at publish or reset (§3-Workspace);
 *     the mechanism is resetPack()
 *   - no completedPackIds / terminal state: the workflow is cyclic; "was this
 *     pack published" is the Archive's fact, not working state's
 *   - no capture gates: a capture attaches to its Asset unconditionally;
 *     membership affects only what the capture counts toward
 *   - no hasCaptured(): captureOf() !== null is the same truth
 *   - no packsContaining(): under §9.1 disjointness a plural answer is a lie;
 *     membership questions are three lines over packs() at the consumer
 *   - no CaptureAccepted result type: capture() cannot fail and returns the
 *     one already-typed fact, the updated AssetCapture
 *
 * Revision counting: one current Analysis per Asset, newest wins (§2.1);
 * `revisions` exists solely because §7.3's Rev-2 indicator is inexpressible
 * without it. Reset clears revision history (§3-Revision).
 *
 * Disjointness: Constitution §9.1 defers multi-pack membership and ratifies
 * that today's model may rely on all packs being disjoint. That reliance is
 * asserted ONCE, loudly, at construction — not per capture, and with no
 * overlap machinery of any kind.
 *
 * captures() carries NO ordering guarantee: it is the complete set of stored
 * facts (the persistence contract — the captures map IS the entire durable
 * state); any ordering a consumer needs is that consumer's concern.
 */

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(`Workspace error: ${message}`);
    this.name = "WorkspaceError";
  }
}

/** THE stored fact: one asset's current capture. */
export interface AssetCapture {
  readonly assetId: string;
  /** Timestamp of the NEWEST capture (newest wins; §2.1-Revision). */
  readonly capturedAt: string;
  /** How many times this asset has been captured this instance (>= 1). */
  readonly revisions: number;
}

/** Derived per-pack instance state (Constitution §3-Workspace). */
export type PackState = "empty" | "building" | "complete";

export interface Workspace {
  /** The injected pack definitions, in their canonical order. */
  packs(): readonly Pack[];
  /** Definition lookup by id; null for an unknown pack. */
  pack(packId: string): Pack | null;

  /**
   * Record a capture for an asset. Always accepted (routing by identity has
   * no gates — §4.1); membership determines only what it counts toward.
   * Re-capture replaces: newest wins, revision count increments. Returns the
   * updated stored fact.
   */
  capture(assetId: string, capturedAt: string): AssetCapture;
  /** The stored fact for one asset; null when never captured this instance. */
  captureOf(assetId: string): AssetCapture | null;
  /** The complete set of stored facts. No ordering guarantee. */
  captures(): readonly AssetCapture[];

  /** Derived instance state for one pack. Throws on unknown packId (fail loud). */
  packState(packId: string): PackState;
  /** Definition members without a current capture, in canonical pack order. */
  pendingAssets(packId: string): readonly string[];
  /** Definition members WITH a current capture, in canonical pack order. */
  capturedFor(packId: string): readonly AssetCapture[];

  /**
   * Discard one Asset's current Analysis (§4.7), including its revision
   * history. Returns true when a capture existed and was removed.
   */
  resetAsset(assetId: string): boolean;

  /**
   * End one pack's instance (§4.7 reset / the post-publish workspace reset of
   * §4.5): clears captures — including revision history — for that pack's
   * definition members ONLY. Captures for other packs' assets, held work, and
   * unknown-asset work are untouched.
   */
  resetPack(packId: string): void;
}

function assertNonEmpty(kind: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceError(`${kind} must be a non-empty string`);
  }
}

/**
 * Create a Workspace over the injected pack definitions.
 *
 * Asserts pack disjointness at construction (see header). Optionally seeds
 * initial captures (the persistence restore path); seeding applies the same
 * validation as live captures and preserves revision counts.
 */
export function createWorkspace(
  packs: readonly Pack[],
  initialCaptures: readonly AssetCapture[] = [],
): Workspace {
  // §9.1 disjointness — asserted once, loudly, at construction.
  const memberOf = new Map<string, string>(); // assetId -> packId
  for (const pack of packs) {
    for (const assetId of pack.assets) {
      const already = memberOf.get(assetId);
      if (already !== undefined && already !== pack.id) {
        throw new WorkspaceError(
          `asset "${assetId}" belongs to both pack "${already}" and pack "${pack.id}" — ` +
            `multi-pack membership is deferred by Constitution §9.1 and the current model relies on disjoint packs; ` +
            `resolve the overlap in the pack definitions (or take the ruling through the Constitution's front door)`,
        );
      }
      memberOf.set(assetId, pack.id);
    }
  }

  const byId = new Map<string, Pack>(packs.map((p) => [p.id, p]));

  // THE stored state: assetId -> capture fact. Everything else is derived.
  const captured = new Map<string, AssetCapture>();

  for (const seed of initialCaptures) {
    assertNonEmpty("assetId", seed.assetId);
    assertNonEmpty("capturedAt", seed.capturedAt);
    if (!Number.isInteger(seed.revisions) || seed.revisions < 1) {
      throw new WorkspaceError(
        `capture for "${seed.assetId}" has invalid revision count ${String(seed.revisions)} (must be an integer >= 1)`,
      );
    }
    if (captured.has(seed.assetId)) {
      throw new WorkspaceError(`duplicate initial capture for asset "${seed.assetId}"`);
    }
    captured.set(seed.assetId, {
      assetId: seed.assetId,
      capturedAt: seed.capturedAt,
      revisions: seed.revisions,
    });
  }

  function requirePack(packId: string): Pack {
    const pack = byId.get(packId);
    if (pack === undefined) {
      throw new WorkspaceError(`unknown pack "${packId}"`);
    }
    return pack;
  }

  return {
    packs(): readonly Pack[] {
      return packs;
    },

    pack(packId: string): Pack | null {
      return byId.get(packId) ?? null;
    },

    capture(assetId: string, capturedAt: string): AssetCapture {
      assertNonEmpty("assetId", assetId);
      assertNonEmpty("capturedAt", capturedAt);
      const existing = captured.get(assetId);
      const updated: AssetCapture = {
        assetId,
        capturedAt,
        revisions: existing === undefined ? 1 : existing.revisions + 1,
      };
      captured.set(assetId, updated);
      return updated;
    },

    captureOf(assetId: string): AssetCapture | null {
      return captured.get(assetId) ?? null;
    },

    captures(): readonly AssetCapture[] {
      return [...captured.values()];
    },

    packState(packId: string): PackState {
      const pack = requirePack(packId);
      let count = 0;
      for (const assetId of pack.assets) {
        if (captured.has(assetId)) count++;
      }
      if (count === 0) return "empty";
      return count === pack.assets.length ? "complete" : "building";
    },

    pendingAssets(packId: string): readonly string[] {
      const pack = requirePack(packId);
      return pack.assets.filter((assetId) => !captured.has(assetId));
    },

    capturedFor(packId: string): readonly AssetCapture[] {
      const pack = requirePack(packId);
      const out: AssetCapture[] = [];
      for (const assetId of pack.assets) {
        const rec = captured.get(assetId);
        if (rec !== undefined) out.push(rec);
      }
      return out;
    },

    resetAsset(assetId: string): boolean {
      assertNonEmpty("assetId", assetId);
      return captured.delete(assetId);
    },

    resetPack(packId: string): void {
      const pack = requirePack(packId);
      for (const assetId of pack.assets) {
        captured.delete(assetId);
      }
    },
  };
}

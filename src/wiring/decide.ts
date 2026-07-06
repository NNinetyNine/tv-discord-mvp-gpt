import type { Asset, ResolveResult } from "../types.ts";
import type { PackSession } from "../packs/session.ts";

/**
 * Pure decision layer — workflow POLICY only. Given an already-computed
 * ResolveResult (from the Resolver) and a PackSession, it returns ONE
 * deterministic verdict: should this capture be accepted for the active pack,
 * or rejected?
 *
 * The Resolver is solely responsible for filename interpretation; Decision does
 * not depend on it. Decision evaluates only: did resolution succeed, is there an
 * active pack, is the resolved asset a member of it, and would it replace an
 * existing capture.
 *
 * This layer is a VERDICT, not an action. It performs NO mutation — it does not
 * call session.capture(). It asks the session read-only predicates and reports
 * what should happen.
 *
 * Purity: no filesystem, no resolver, no staging, no publishing, no Discord, no
 * UI, no persistence.
 */

/** Why a capture was rejected. Mirrors the resolver/session failure modes. */
export type RejectionReason =
  | { readonly kind: "unparseable_filename"; readonly filename: string }
  | { readonly kind: "unknown_symbol"; readonly symbol: string }
  | { readonly kind: "no_active_pack" }
  | { readonly kind: "not_in_active_pack"; readonly asset: Asset; readonly activePackId: string };

/** The verdict: accept this asset for the active pack, or reject with a reason. */
export type CaptureDecision =
  | {
      readonly accepted: true;
      readonly asset: Asset;
      readonly activePackId: string;
      /** true if this asset is already captured in the active pack (will replace). */
      readonly replacesExisting: boolean;
    }
  | { readonly accepted: false; readonly reason: RejectionReason };

/**
 * Decide whether an already-resolved capture should be accepted for the active
 * pack.
 *
 * Order of checks:
 *   1. did resolution succeed? (else unparseable / unknown_symbol)
 *   2. is there an active pack? (else no_active_pack)
 *   3. is the resolved asset a member of the active pack? (else not_in_active_pack)
 *   4. accepted — reporting whether it replaces an existing capture.
 *
 * Deterministic and side-effect-free: given the same resolve result and session
 * state, it always returns the same verdict and changes nothing.
 */
export function decide(resolved: ResolveResult, session: PackSession): CaptureDecision {
  if (!resolved.ok) {
    if (resolved.reason === "unparseable_filename") {
      return { accepted: false, reason: { kind: "unparseable_filename", filename: resolved.filename } };
    }
    return { accepted: false, reason: { kind: "unknown_symbol", symbol: resolved.symbol } };
  }

  const asset = resolved.asset;
  const pack = session.activePack();
  if (pack === null) {
    return { accepted: false, reason: { kind: "no_active_pack" } };
  }

  if (!session.isAssetInActivePack(asset.id)) {
    return {
      accepted: false,
      reason: { kind: "not_in_active_pack", asset, activePackId: pack.id },
    };
  }

  return { accepted: true, asset, activePackId: pack.id, replacesExisting: session.hasCaptured(asset.id) };
}
import type { Asset, CaptureResult, ValidationResult } from "../types.ts";
import type { Resolver } from "../resolver/index.ts";
import type { PackSession } from "../packs/session.ts";
import type { StagingStore } from "./staging.ts";
import { decide } from "./decide.ts";

/**
 * Capture-once orchestration. Coordinates the existing verified modules for ONE
 * capture attempt — it owns no business rules of its own.
 *
 * Flow: capture -> resolver.resolve -> decide -> validate -> stage -> session.capture().
 *   - the Resolver is solely responsible for filename interpretation;
 *     orchestration calls it and hands the ResolveResult to decide().
 *   - decide() evaluates workflow policy only (resolution success + active-pack
 *     membership). Orchestration never re-resolves or re-checks membership.
 *   - validation runs only AFTER an accept decision.
 *   - staging happens BEFORE session.capture(): a staged file with no session
 *     record is benign (working state is source of truth and reconciles),
 *     whereas a recorded capture with no image would be worse.
 *   - staging custody is ASSET-keyed (custody follows the asset, not the
 *     pack); the packId in the result comes from the decision, which owns
 *     membership.
 *   - persistence is automatic and invisible here: if `session` is the
 *     persistent wrapper, its capture() auto-saves.
 *
 * Normal operational outcomes are returned as a discriminated union, never
 * thrown. Exceptions are reserved for genuine programming/configuration faults
 * (e.g. the Session rejecting a capture that decide() already accepted).
 *
 * The dependency shapes for capturing and validating are declared INLINE in
 * CaptureOnceDeps rather than as exported interfaces; adapting the real
 * (ticker-driven) capture/validation code to these shapes is an internal wiring
 * concern handled at the runtime boundary in a later phase.
 */

export interface CaptureOnceDeps {
  /** Captures whatever chart is currently open (no ticker selection). */
  readonly capturer: { capture(): Promise<CaptureResult> };
  readonly resolver: Resolver;
  readonly session: PackSession; // pass the persistent wrapper for auto-save
  readonly staging: StagingStore;
  /** Validates a staged-candidate image by path. */
  readonly validate: (imagePath: string) => ValidationResult | Promise<ValidationResult>;
}

export type CaptureAttemptResult =
  | {
      readonly ok: true;
      readonly outcome: "staged";
      readonly asset: Asset;
      readonly packId: string;
      readonly stagedPath: string;
      readonly replaced: boolean;
    }
  | { readonly ok: false; readonly outcome: "capture_failed"; readonly detail: string }
  | { readonly ok: false; readonly outcome: "unparseable_filename"; readonly filename: string }
  | { readonly ok: false; readonly outcome: "unknown_symbol"; readonly symbol: string }
  | { readonly ok: false; readonly outcome: "no_active_pack" }
  | {
      readonly ok: false;
      readonly outcome: "not_in_active_pack";
      readonly asset: Asset;
      readonly activePackId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "validation_failed";
      readonly asset: Asset;
      readonly reason: string;
      readonly checks: Readonly<Record<string, boolean>>;
    }
  | { readonly ok: false; readonly outcome: "staging_failed"; readonly asset: Asset; readonly detail: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function captureOnce(deps: CaptureOnceDeps): Promise<CaptureAttemptResult> {
  const { capturer, resolver, session, staging, validate } = deps;

  // 1. Capture the current chart.
  let capture: CaptureResult;
  try {
    capture = await capturer.capture();
  } catch (e) {
    return { ok: false, outcome: "capture_failed", detail: errMsg(e) };
  }

  // 2. Resolve (Resolver owns filename interpretation), then decide (policy).
  const decision = decide(resolver.resolve(capture.suggestedFilename), session);
  if (!decision.accepted) {
    const r = decision.reason;
    if (r.kind === "unparseable_filename") {
      return { ok: false, outcome: "unparseable_filename", filename: r.filename };
    }
    if (r.kind === "unknown_symbol") {
      return { ok: false, outcome: "unknown_symbol", symbol: r.symbol };
    }
    if (r.kind === "no_active_pack") {
      return { ok: false, outcome: "no_active_pack" };
    }
    // remaining: not_in_active_pack
    return { ok: false, outcome: "not_in_active_pack", asset: r.asset, activePackId: r.activePackId };
  }

  const asset = decision.asset;
  const packId = decision.activePackId;

  // 3. Validate (only after deciding to accept).
  const validation = await validate(capture.imagePath);
  if (!validation.ok) {
    return {
      ok: false,
      outcome: "validation_failed",
      asset,
      reason: validation.reason ?? "validation failed",
      checks: validation.checks,
    };
  }

  // 4. Stage (before recording in the session). Custody is asset-keyed.
  let stagedPath: string;
  try {
    stagedPath = staging.stage(asset.id, capture.imagePath).path;
  } catch (e) {
    return { ok: false, outcome: "staging_failed", asset, detail: errMsg(e) };
  }

  // 5. Record in the session (auto-persists via the wrapper). Membership was
  //    already decided, so a rejection here is a genuine inconsistency.
  const recorded = session.capture(asset.id, capture.capturedAt);
  if (!recorded.ok) {
    throw new Error(
      `internal: session rejected an already-accepted capture for "${asset.id}" (${recorded.reason})`,
    );
  }

  return {
    ok: true,
    outcome: "staged",
    asset,
    packId,
    stagedPath,
    replaced: decision.replacesExisting,
  };
}
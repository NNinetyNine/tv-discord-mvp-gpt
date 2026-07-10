import type { Asset, CaptureResult, ValidationResult } from "../types.ts";
import type { Resolver } from "../resolver/index.ts";
import type { Workspace } from "../packs/workspace.ts";
import type { StagingStore } from "./staging.ts";

/**
 * Capture-once orchestration. Coordinates the existing verified modules for ONE
 * capture attempt — it owns no business rules of its own.
 *
 * Flow: capture -> resolver.resolve -> validate -> stage -> workspace.capture().
 *   - the Resolver is solely responsible for filename interpretation; its two
 *     failure modes map directly into capture outcomes — there is no policy
 *     layer between resolution and capture, because routing is BY IDENTITY
 *     (Constitution §4.1): a resolved Asset's capture is always accepted, and
 *     pack membership affects only what it counts toward (§4.6). The old
 *     active-pack gates do not exist in the model and do not exist here.
 *   - validation runs only AFTER successful resolution.
 *   - staging happens BEFORE workspace.capture(): a staged file with no
 *     recorded fact is benign (working state is source of truth and
 *     reconciles), whereas a recorded capture with no image would be worse.
 *   - staging custody is ASSET-keyed (custody follows the asset).
 *   - persistence is automatic and invisible here: pass the persisted
 *     Workspace surface and its capture() auto-saves.
 *
 * Normal operational outcomes are returned as a discriminated union, never
 * thrown. Exceptions are reserved for genuine programming/configuration
 * faults. (The old "workspace rejected an accepted capture" branch is gone:
 * the Workspace's capture() cannot reject, so the fault is unrepresentable.)
 *
 * The successful result carries the asset, the staged path, and the updated
 * revision count. It deliberately does NOT carry packId (membership is the
 * definitions' fact, derived by consumers from workspace.packs()) or a
 * `replaced` flag (replacement IS revisions > 1 — one fact, one encoding).
 */

export interface CaptureOnceDeps {
  /** Captures whatever chart is currently open (no ticker selection). */
  readonly capturer: { capture(): Promise<CaptureResult> };
  readonly resolver: Resolver;
  readonly workspace: Workspace; // pass the persisted surface for auto-save
  readonly staging: StagingStore;
  /** Validates a staged-candidate image by path. */
  readonly validate: (imagePath: string) => ValidationResult | Promise<ValidationResult>;
}

export type CaptureAttemptResult =
  | {
      readonly ok: true;
      readonly outcome: "staged";
      readonly asset: Asset;
      readonly stagedPath: string;
      /** Revision count after this capture; replacement is revisions > 1. */
      readonly revisions: number;
    }
  | { readonly ok: false; readonly outcome: "capture_failed"; readonly detail: string }
  | { readonly ok: false; readonly outcome: "unparseable_filename"; readonly filename: string }
  | { readonly ok: false; readonly outcome: "unknown_symbol"; readonly symbol: string }
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
  const { capturer, resolver, workspace, staging, validate } = deps;

  // 1. Capture the current chart.
  let capture: CaptureResult;
  try {
    capture = await capturer.capture();
  } catch (e) {
    return { ok: false, outcome: "capture_failed", detail: errMsg(e) };
  }

  // 2. Resolve. The Resolver owns filename interpretation; its failures map
  //    directly into outcomes (no policy layer — routing is by identity).
  const resolved = resolver.resolve(capture.suggestedFilename);
  if (!resolved.ok) {
    if (resolved.reason === "unparseable_filename") {
      return { ok: false, outcome: "unparseable_filename", filename: resolved.filename };
    }
    return { ok: false, outcome: "unknown_symbol", symbol: resolved.symbol };
  }
  const asset = resolved.asset;

  // 3. Validate (only after successful resolution).
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

  // 4. Stage (before recording the fact). Custody is asset-keyed.
  let stagedPath: string;
  try {
    stagedPath = staging.stage(asset.id, capture.imagePath).path;
  } catch (e) {
    return { ok: false, outcome: "staging_failed", asset, detail: errMsg(e) };
  }

  // 5. Record the fact (auto-persists via the persisted surface). Cannot fail.
  const fact = workspace.capture(asset.id, capture.capturedAt);

  return {
    ok: true,
    outcome: "staged",
    asset,
    stagedPath,
    revisions: fact.revisions,
  };
}
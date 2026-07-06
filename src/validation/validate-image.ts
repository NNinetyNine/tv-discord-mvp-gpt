import { existsSync, statSync } from "node:fs";
import sharp from "sharp";
import type { ValidationResult, ValidationChecks } from "../types.ts";

/**
 * Canonical image validation — pure and deterministic.
 *
 * Promoted from the legacy validate/checks.ts so there is ONE validation
 * implementation. The legacy validate(imagePath, ticker) is now a thin adapter
 * that builds a complete ValidationPolicy (from env + Ticker) and delegates here.
 *
 * Purity: this function reads NO configuration from process.env. Every threshold
 * is supplied by the caller in a complete, immutable ValidationPolicy. Given the
 * same imagePath and policy, it always returns the same result.
 *
 * Philosophy (unchanged from the legacy validator): a missing chart is better
 * than a bad chart. ANY check that fails — or ANY unexpected error while
 * checking — returns ok:false. We never throw; problems become a clean rejection.
 *
 * Checks, cheapest first:
 *   1. file exists
 *   2. file size above policy.minBytes
 *   3. image readable (sharp metadata + stats)
 *   4. dimensions == policy.expectedDimensions  (SKIPPED when expectedDimensions is null)
 *   5. not blank (max channel stddev above policy.blankStddevFloor)
 *
 * The legacy observable behaviour is preserved through the adapter. The one
 * intentional difference from the legacy code: when expectedDimensions is null,
 * the dimension check does not run and `checks.dimensions` is omitted entirely.
 * The legacy adapter always supplies dimensions, so it never takes that branch
 * and its results are unchanged.
 */

/**
 * A complete, immutable description of what "valid" means. Every threshold is
 * required — the validator applies no defaults and reads no environment.
 *
 * Kept beside validateImage: it is the input half of this one function's
 * contract, consumed only here (adapters construct it solely to call this).
 */
export interface ValidationPolicy {
  readonly minBytes: number;
  readonly blankStddevFloor: number;
  /** Enforce exact pixel dimensions, or null to skip the dimension check entirely. */
  readonly expectedDimensions: { readonly width: number; readonly height: number } | null;
}

/**
 * The standard intrinsic-check thresholds, centralized so callers don't
 * duplicate them. These mirror the legacy env defaults (MIN_IMAGE_BYTES=20000,
 * BLANK_STDDEV_FLOOR=4). expectedDimensions defaults to null (no dimension
 * enforcement); callers that DO enforce dimensions spread this and override it,
 * e.g. { ...DEFAULT_VALIDATION_POLICY, expectedDimensions: { width, height } }.
 */
export const DEFAULT_VALIDATION_POLICY: ValidationPolicy = {
  minBytes: 20_000,
  blankStddevFloor: 4,
  expectedDimensions: null,
};

function fail(checks: ValidationChecks, reason: string): ValidationResult {
  return { ok: false, checks, reason };
}

export async function validateImage(
  imagePath: string,
  policy: ValidationPolicy,
): Promise<ValidationResult> {
  const checks: ValidationChecks = {};

  // 1. exists
  if (!existsSync(imagePath)) {
    checks.exists = false;
    return fail(checks, `file does not exist: ${imagePath}`);
  }
  checks.exists = true;

  // 2. size
  let bytes: number;
  try {
    bytes = statSync(imagePath).size;
  } catch (e) {
    checks.size = false;
    return fail(checks, `could not stat file: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (bytes < policy.minBytes) {
    checks.size = false;
    return fail(checks, `file too small: ${bytes} bytes < ${policy.minBytes}`);
  }
  checks.size = true;

  // 3 + 4 + 5 need pixels. Read metadata and stats once; any sharp error => reject.
  let width: number | undefined;
  let height: number | undefined;
  let maxStdev: number;
  try {
    const img = sharp(imagePath);
    const meta = await img.metadata();
    const stats = await img.stats();
    width = meta.width;
    height = meta.height;
    maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
  } catch (e) {
    checks.readable = false;
    return fail(checks, `image not readable: ${e instanceof Error ? e.message : String(e)}`);
  }
  checks.readable = true;

  // 4. dimensions — only when the policy enforces them. When expectedDimensions
  //    is null, the check is skipped and checks.dimensions is left unset.
  if (policy.expectedDimensions !== null) {
    const { width: expW, height: expH } = policy.expectedDimensions;
    if (width !== expW || height !== expH) {
      checks.dimensions = false;
      return fail(checks, `dimensions ${width ?? "?"}x${height ?? "?"} != expected ${expW}x${expH}`);
    }
    checks.dimensions = true;
  }

  // 5. not blank: a flat/blank image has near-zero variance on every channel
  if (maxStdev < policy.blankStddevFloor) {
    checks.notBlank = false;
    return fail(checks, `image appears blank: max channel stddev ${maxStdev.toFixed(2)} < ${policy.blankStddevFloor}`);
  }
  checks.notBlank = true;

  return { ok: true, checks };
}
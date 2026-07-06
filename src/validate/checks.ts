import type { ValidationResult, Validator } from "../types.ts";
import { validateImage, type ValidationPolicy } from "../validation/validate-image.ts";

/**
 * Legacy validation adapter.
 *
 * The validation logic has been promoted to the pure, policy-driven
 * validateImage() in src/validation/. This module is now a thin LEGACY adapter:
 * it preserves the existing (imagePath, ticker) Validator signature used by the
 * browser/pipeline path, assembles a complete ValidationPolicy from today's
 * sources — environment variables (intrinsic thresholds) and the Ticker
 * (expected dimensions) — and delegates to the canonical validator.
 *
 * Environment coupling lives HERE, at the legacy boundary, not in the canonical
 * validator. The legacy observable behaviour is preserved: same env vars, same
 * defaults, same ticker dimensions. Because this adapter always supplies
 * expectedDimensions, the canonical validator runs all five checks exactly as
 * the legacy path did (it never takes the dimensions-omitted branch).
 *
 * This adapter is temporary: it retires when the runtime migrates off the
 * Ticker-driven path. The canonical validateImage() remains.
 */

/** Read a numeric env var, falling back if missing or not finite. */
function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const validate: Validator = async (imagePath, ticker): Promise<ValidationResult> => {
  const policy: ValidationPolicy = {
    minBytes: numEnv("MIN_IMAGE_BYTES", 20_000),
    blankStddevFloor: numEnv("BLANK_STDDEV_FLOOR", 4),
    expectedDimensions: { width: ticker.expectedWidth, height: ticker.expectedHeight },
  };
  return validateImage(imagePath, policy);
};
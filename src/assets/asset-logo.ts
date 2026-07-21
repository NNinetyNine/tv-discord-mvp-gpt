import { createHash } from "node:crypto";

import { readDecodedImageFacts } from "../validation/inspect-image.ts";

export const ASSET_LOGO_POLICY = Object.freeze({
  format: "png" as const,
  maximumBytes: 4 * 1024 * 1024,
  minimumDimension: 64,
  maximumDimension: 2048,
  requireSquare: true,
  maximumFrames: 1,
});

export type AssetLogoValidationFailureReason =
  | "empty_file"
  | "file_too_large"
  | "unreadable_image"
  | "unsupported_format"
  | "missing_dimensions"
  | "dimensions_too_small"
  | "dimensions_too_large"
  | "not_square"
  | "animated_image";

export interface AssetLogoValidationFailure {
  readonly ok: false;
  readonly reason: AssetLogoValidationFailureReason;
  readonly detail: string;
}

export interface ValidatedAssetLogo {
  readonly ok: true;
  readonly sha256: string;
  readonly byteSize: number;
  readonly format: "png";
  readonly width: number;
  readonly height: number;
  readonly pageOrFrameCount: number;
  readonly channelCount: number | null;
  readonly hasAlpha: boolean | null;
}

export type AssetLogoValidationResult =
  | ValidatedAssetLogo
  | AssetLogoValidationFailure;

function failure(
  reason: AssetLogoValidationFailureReason,
  detail: string,
): AssetLogoValidationFailure {
  return Object.freeze({ ok: false, reason, detail });
}

/**
 * Validate immutable Asset-logo bytes without writing files or mutating state.
 *
 * Successful facts are deterministic and path-neutral so their SHA-256 and
 * decoded image identity can later be bound into a Pack-builder preview.
 */
export async function validateAssetLogo(
  bytes: Buffer,
): Promise<AssetLogoValidationResult> {
  if (bytes.byteLength === 0) {
    return failure("empty_file", "Asset logo must not be empty.");
  }

  if (bytes.byteLength > ASSET_LOGO_POLICY.maximumBytes) {
    return failure(
      "file_too_large",
      `Asset logo must not exceed ${ASSET_LOGO_POLICY.maximumBytes} bytes.`,
    );
  }

  let decoded;
  try {
    decoded = await readDecodedImageFacts(bytes);
  } catch (error) {
    return failure(
      "unreadable_image",
      `Asset logo could not be decoded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (decoded.format !== ASSET_LOGO_POLICY.format) {
    return failure(
      "unsupported_format",
      `Asset logo format must be ${ASSET_LOGO_POLICY.format}.`,
    );
  }

  if (decoded.width === null || decoded.height === null) {
    return failure(
      "missing_dimensions",
      "Asset logo did not report pixel dimensions.",
    );
  }

  if (
    decoded.width < ASSET_LOGO_POLICY.minimumDimension ||
    decoded.height < ASSET_LOGO_POLICY.minimumDimension
  ) {
    return failure(
      "dimensions_too_small",
      `Asset logo dimensions must be at least ${ASSET_LOGO_POLICY.minimumDimension} × ${ASSET_LOGO_POLICY.minimumDimension} pixels.`,
    );
  }

  if (
    decoded.width > ASSET_LOGO_POLICY.maximumDimension ||
    decoded.height > ASSET_LOGO_POLICY.maximumDimension
  ) {
    return failure(
      "dimensions_too_large",
      `Asset logo dimensions must not exceed ${ASSET_LOGO_POLICY.maximumDimension} × ${ASSET_LOGO_POLICY.maximumDimension} pixels.`,
    );
  }

  if (
    ASSET_LOGO_POLICY.requireSquare &&
    decoded.width !== decoded.height
  ) {
    return failure(
      "not_square",
      "Asset logo must have equal width and height.",
    );
  }

  const pageOrFrameCount = decoded.pageOrFrameCount ?? 1;
  if (pageOrFrameCount > ASSET_LOGO_POLICY.maximumFrames) {
    return failure(
      "animated_image",
      "Asset logo must contain exactly one image frame.",
    );
  }

  return Object.freeze({
    ok: true,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    format: "png",
    width: decoded.width,
    height: decoded.height,
    pageOrFrameCount,
    channelCount: decoded.channelCount,
    hasAlpha: decoded.hasAlpha,
  });
}

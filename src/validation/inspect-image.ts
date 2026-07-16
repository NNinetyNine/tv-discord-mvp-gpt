import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import sharp from "sharp";

/**
 * Low-level facts obtained by fully decoding an image.
 *
 * This is technical inspection, not acceptance policy. The canonical validator
 * uses the pixel statistic below; the developer-facing evidence report exposes
 * only the directly observable container and bitmap facts.
 */
export interface DecodedImageFacts {
  readonly format: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly pageOrFrameCount: number | null;
  readonly channelCount: number | null;
  readonly hasAlpha: boolean | null;
  readonly maxChannelStddev: number;
}

/** One deterministic, path-neutral observation of an explicitly supplied file. */
export interface ImageObservation {
  readonly originalBasename: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly format: string | null;
  readonly width: number;
  readonly height: number;
  readonly pageOrFrameCount: number | null;
  readonly channelCount: number | null;
  readonly hasAlpha: boolean | null;
}

export type ImageInspectionFailureReason =
  | "missing_file"
  | "not_regular_file"
  | "unreadable_file"
  | "unreadable_image"
  | "missing_dimensions";

/**
 * A failure to inspect explicitly requested evidence.
 *
 * This is deliberately separate from production import rejection outcomes: the
 * evidence command is read-only developer tooling, not canonical ingestion.
 */
export class ImageInspectionError extends Error {
  readonly inputPath: string;
  readonly reason: ImageInspectionFailureReason;
  readonly detail: string;

  constructor(inputPath: string, reason: ImageInspectionFailureReason, detail: string) {
    super(`Could not inspect ${inputPath}: ${detail}`);
    this.name = "ImageInspectionError";
    this.inputPath = inputPath;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Decode image pixels once and return normalized technical facts.
 *
 * The input may be a path (used by canonical validation) or immutable file bytes
 * (used by evidence inspection so the digest and image facts describe the exact
 * same content). Errors are intentionally left to the caller to classify.
 */
export async function readDecodedImageFacts(
  input: string | Buffer,
): Promise<DecodedImageFacts> {
  const image = sharp(input);
  const metadata = await image.metadata();
  const stats = await image.stats();

  return {
    format: metadata.format ?? null,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    pageOrFrameCount: metadata.pages ?? null,
    channelCount: metadata.channels ?? null,
    hasAlpha: metadata.hasAlpha ?? null,
    maxChannelStddev: Math.max(...stats.channels.map((channel) => channel.stdev)),
  };
}

/** Inspect one explicitly supplied image without modifying it or creating state. */
export async function inspectImageFile(inputPath: string): Promise<ImageObservation> {
  let fileStat;
  try {
    fileStat = await stat(inputPath);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "ENOENT") {
      throw new ImageInspectionError(inputPath, "missing_file", "file does not exist");
    }
    throw new ImageInspectionError(
      inputPath,
      "unreadable_file",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!fileStat.isFile()) {
    throw new ImageInspectionError(inputPath, "not_regular_file", "path is not a regular file");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(inputPath);
  } catch (error) {
    throw new ImageInspectionError(
      inputPath,
      "unreadable_file",
      error instanceof Error ? error.message : String(error),
    );
  }

  let decoded: DecodedImageFacts;
  try {
    decoded = await readDecodedImageFacts(bytes);
  } catch (error) {
    throw new ImageInspectionError(
      inputPath,
      "unreadable_image",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (decoded.width === null || decoded.height === null) {
    throw new ImageInspectionError(
      inputPath,
      "missing_dimensions",
      "decoded image did not report pixel dimensions",
    );
  }

  return Object.freeze({
    originalBasename: basename(inputPath),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    format: decoded.format,
    width: decoded.width,
    height: decoded.height,
    pageOrFrameCount: decoded.pageOrFrameCount,
    channelCount: decoded.channelCount,
    hasAlpha: decoded.hasAlpha,
  });
}

/**
 * Inspect requested files in caller order. The complete array is returned only
 * when every file succeeds, allowing callers to avoid a misleading partial report.
 */
export async function inspectImageFiles(
  inputPaths: readonly string[],
): Promise<readonly ImageObservation[]> {
  const observations: ImageObservation[] = [];
  for (const inputPath of inputPaths) {
    observations.push(await inspectImageFile(inputPath));
  }
  return Object.freeze(observations);
}

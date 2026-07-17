import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  link,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHART_PUBLICATION_BRANDING,
} from "../rendering/chart-publication-template.ts";
import { readDecodedImageFacts } from "../validation/inspect-image.ts";
import {
  buildPublicationReviewReceipt,
  serializePublicationReviewReceipt,
  validateChartPublicationRenderReceipt,
  validatePublicationReviewMetadata,
  type PublicationReviewReceipt,
} from "./publication-review.ts";

export type PublicationReviewFailureReason =
  | "invalid_arguments"
  | "unreadable_publication"
  | "unreadable_render_receipt"
  | "unreadable_review"
  | "unreadable_source"
  | "invalid_render_receipt"
  | "invalid_review"
  | "publication_hash_mismatch"
  | "publication_dimensions_mismatch"
  | "source_hash_mismatch"
  | "source_dimensions_mismatch"
  | "branding_identity_mismatch"
  | "input_changed_during_review"
  | "path_collision"
  | "output_already_exists"
  | "temporary_write_failed"
  | "finalize_failed";

export interface PublicationReviewFailure {
  readonly ok: false;
  readonly reason: PublicationReviewFailureReason;
  readonly detail: string;
}

export interface PublicationReviewFileSuccess {
  readonly ok: true;
  readonly outputBasename: string;
  readonly publicationApproved: boolean;
  readonly sourceReverified: boolean;
  readonly receipt: PublicationReviewReceipt;
}

export type PublicationReviewFileResult =
  | PublicationReviewFileSuccess
  | PublicationReviewFailure;

export interface ReviewChartPublicationFileOptions {
  readonly publicationPath: string;
  readonly renderReceiptPath: string;
  readonly reviewPath: string;
  readonly outputPath: string;
  readonly sourcePath?: string;
}

export interface ReviewChartPublicationFileDependencies {
  /** Test seam for simulating input changes before finalization. */
  readonly beforeFinalize?: () => Promise<void>;
}

interface DestinationPath {
  readonly canonical: string;
  readonly directory: string;
  readonly basename: string;
  readonly exists: boolean;
  readonly existingRealPath: string | null;
}

interface InputArtifact {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

function isFailureResult(value: InputArtifact | PublicationReviewFailure): value is PublicationReviewFailure {
  return "ok" in value && value.ok === false;
}

function isBrandingFailure(
  value: PublicationReviewFailure | { readonly emblem: InputArtifact; readonly wordmark: InputArtifact },
): value is PublicationReviewFailure {
  return "ok" in value && value.ok === false;
}

const EMBLEM_URL = new URL(`../../assets/branding/${CHART_PUBLICATION_BRANDING.emblem.filename}`, import.meta.url);
const WORDMARK_URL = new URL(`../../assets/branding/${CHART_PUBLICATION_BRANDING.wordmark.filename}`, import.meta.url);

function failure(reason: PublicationReviewFailureReason, detail: string): PublicationReviewFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readInput(path: string, reason: "unreadable_publication" | "unreadable_render_receipt" | "unreadable_review" | "unreadable_source"): Promise<InputArtifact | PublicationReviewFailure> {
  let realPath: string;
  try {
    realPath = await realpath(resolve(path));
  } catch (error) {
    return failure(reason, `could not resolve input: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const bytes = await readFile(realPath);
    return Object.freeze({ path: realPath, bytes, sha256: hash(bytes) });
  } catch (error) {
    return failure(reason, `could not read input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolveDestination(path: string): Promise<DestinationPath> {
  const requested = resolve(path);
  const directory = await realpath(dirname(requested));
  const canonical = join(directory, basename(requested));
  let existingRealPath: string | null = null;
  let exists = false;
  try {
    existingRealPath = await realpath(canonical);
    exists = true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  return Object.freeze({ canonical, directory, basename: basename(canonical), exists, existingRealPath });
}

function comparisonKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function collides(output: DestinationPath, inputPath: string): boolean {
  const inputKey = comparisonKey(inputPath);
  return comparisonKey(output.canonical) === inputKey ||
    (output.existingRealPath !== null && comparisonKey(output.existingRealPath) === inputKey);
}

async function writeAndSyncNewFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close();
  }
}

async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    return false;
  }
}

async function verifyUnchanged(artifact: InputArtifact): Promise<boolean> {
  try {
    return hash(await readFile(artifact.path)) === artifact.sha256;
  } catch {
    return false;
  }
}

async function decodedPngFacts(bytes: Buffer): Promise<
  | { readonly format: "png"; readonly width: number; readonly height: number }
  | null
> {
  try {
    const facts = await readDecodedImageFacts(bytes);
    if (facts.format !== "png" || facts.width === null || facts.height === null) return null;
    return Object.freeze({ format: "png", width: facts.width, height: facts.height });
  } catch {
    return null;
  }
}

function parseJson(bytes: Buffer, unreadableReason: "unreadable_render_receipt" | "unreadable_review"):
  | { readonly ok: true; readonly value: unknown }
  | PublicationReviewFailure {
  try {
    return Object.freeze({ ok: true, value: JSON.parse(bytes.toString("utf8")) as unknown });
  } catch (error) {
    return failure(unreadableReason, `input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rectangleWithin(
  rectangle: Readonly<{ left: number; top: number; width: number; height: number }>,
  width: number,
  height: number,
): boolean {
  return rectangle.left >= 0 && rectangle.top >= 0 && rectangle.width > 0 && rectangle.height > 0 &&
    rectangle.left + rectangle.width <= width && rectangle.top + rectangle.height <= height;
}

function verifyBrandingReceipt(receipt: PublicationReviewReceiptSource): PublicationReviewFailure | null {
  const branding = receipt.branding;
  if (
    branding.emblem.assetSha256 !== CHART_PUBLICATION_BRANDING.emblem.sha256 ||
    branding.wordmark.assetSha256 !== CHART_PUBLICATION_BRANDING.wordmark.sha256 ||
    branding.watermark.assetSha256 !== CHART_PUBLICATION_BRANDING.emblem.sha256
  ) {
    return failure("branding_identity_mismatch", "render receipt branding hashes do not match approved bundled asset identities");
  }
  if (branding.watermark.opacity !== CHART_PUBLICATION_BRANDING.watermarkOpacity) {
    return failure("branding_identity_mismatch", `render receipt watermark opacity must equal ${CHART_PUBLICATION_BRANDING.watermarkOpacity}`);
  }
  const width = receipt.output.width;
  const height = receipt.output.height;
  if (
    !rectangleWithin(branding.emblem.header, width, height) ||
    !rectangleWithin(branding.emblem.footer, width, height) ||
    !rectangleWithin(branding.wordmark, width, height) ||
    !rectangleWithin(branding.watermark, width, height)
  ) {
    return failure("branding_identity_mismatch", "render receipt contains out-of-range branding placement dimensions");
  }
  const watermark = branding.watermark;
  const placement = receipt.placement;
  if (
    watermark.left < placement.renderedLeft ||
    watermark.top < placement.renderedTop ||
    watermark.left + watermark.width > placement.renderedLeft + placement.renderedWidth ||
    watermark.top + watermark.height > placement.renderedTop + placement.renderedHeight
  ) {
    return failure("branding_identity_mismatch", "render receipt watermark placement is outside rendered chart bounds");
  }
  return null;
}

type PublicationReviewReceiptSource = Parameters<typeof buildPublicationReviewReceipt>[0]["renderReceipt"];

async function verifyBundledAssets(): Promise<PublicationReviewFailure | { readonly emblem: InputArtifact; readonly wordmark: InputArtifact }> {
  const emblemPath = fileURLToPath(EMBLEM_URL);
  const wordmarkPath = fileURLToPath(WORDMARK_URL);
  try {
    const emblemBytes = await readFile(emblemPath);
    const wordmarkBytes = await readFile(wordmarkPath);
    const emblem = Object.freeze({ path: emblemPath, bytes: emblemBytes, sha256: hash(emblemBytes) });
    const wordmark = Object.freeze({ path: wordmarkPath, bytes: wordmarkBytes, sha256: hash(wordmarkBytes) });
    if (emblem.sha256 !== CHART_PUBLICATION_BRANDING.emblem.sha256 || wordmark.sha256 !== CHART_PUBLICATION_BRANDING.wordmark.sha256) {
      return failure("branding_identity_mismatch", "bundled branding asset bytes do not match approved identities");
    }
    return Object.freeze({ emblem, wordmark });
  } catch (error) {
    return failure("branding_identity_mismatch", `could not verify bundled branding assets: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function temporaryPath(output: DestinationPath, token: string): string {
  return join(output.directory, `.${output.basename}.visionx-review-${token}.tmp`);
}

/**
 * Verify one rendered publication, its renderer receipt, and one explicit human
 * decision, then durably write a single immutable review receipt.
 */
export async function reviewChartPublicationFile(
  options: ReviewChartPublicationFileOptions,
  dependencies: ReviewChartPublicationFileDependencies = {},
): Promise<PublicationReviewFileResult> {
  const publication = await readInput(options.publicationPath, "unreadable_publication");
  if (isFailureResult(publication)) return publication;
  const renderReceiptArtifact = await readInput(options.renderReceiptPath, "unreadable_render_receipt");
  if (isFailureResult(renderReceiptArtifact)) return renderReceiptArtifact;
  const reviewArtifact = await readInput(options.reviewPath, "unreadable_review");
  if (isFailureResult(reviewArtifact)) return reviewArtifact;
  const source = options.sourcePath === undefined ? null : await readInput(options.sourcePath, "unreadable_source");
  if (source !== null && isFailureResult(source)) return source;

  let output: DestinationPath;
  try {
    output = await resolveDestination(options.outputPath);
  } catch (error) {
    return failure("temporary_write_failed", `could not resolve output parent: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const input of [publication, renderReceiptArtifact, reviewArtifact, ...(source === null ? [] : [source])]) {
    if (collides(output, input.path)) return failure("path_collision", "review output must not resolve to any input artifact");
  }
  if (output.exists) return failure("output_already_exists", "review output already exists");

  const parsedRender = parseJson(renderReceiptArtifact.bytes, "unreadable_render_receipt");
  if (!parsedRender.ok) return parsedRender;
  const validatedRender = validateChartPublicationRenderReceipt(parsedRender.value);
  if (!validatedRender.ok) return failure("invalid_render_receipt", validatedRender.detail);
  const renderReceipt = validatedRender.receipt;

  const parsedReview = parseJson(reviewArtifact.bytes, "unreadable_review");
  if (!parsedReview.ok) return parsedReview;
  const validatedReview = validatePublicationReviewMetadata(parsedReview.value);
  if (!validatedReview.ok) return failure("invalid_review", validatedReview.detail);

  const brandingFailure = verifyBrandingReceipt(renderReceipt);
  if (brandingFailure !== null) return brandingFailure;
  const bundled = await verifyBundledAssets();
  if (isBrandingFailure(bundled)) return bundled;

  if (publication.sha256 !== renderReceipt.output.sha256) {
    return failure("publication_hash_mismatch", "publication SHA-256 does not match renderer receipt");
  }
  const publicationFacts = await decodedPngFacts(publication.bytes);
  if (publicationFacts === null) return failure("unreadable_publication", "publication is not a decodable PNG with dimensions");
  if (
    publicationFacts.width !== renderReceipt.output.width ||
    publicationFacts.height !== renderReceipt.output.height ||
    publicationFacts.width !== renderReceipt.template.width ||
    publicationFacts.height !== renderReceipt.template.height
  ) {
    return failure("publication_dimensions_mismatch", "publication dimensions do not match renderer receipt and template dimensions");
  }

  if (source !== null) {
    if (source.sha256 !== renderReceipt.source.sha256) {
      return failure("source_hash_mismatch", "supplied source SHA-256 does not match renderer receipt");
    }
    const sourceFacts = await decodedPngFacts(source.bytes);
    if (sourceFacts === null) return failure("source_dimensions_mismatch", "supplied source is not a decodable PNG with dimensions");
    if (sourceFacts.width !== renderReceipt.source.width || sourceFacts.height !== renderReceipt.source.height) {
      return failure("source_dimensions_mismatch", "supplied source dimensions do not match renderer receipt");
    }
  }

  const receipt = buildPublicationReviewReceipt({
    publicationSha256: publication.sha256,
    renderReceiptSha256: renderReceiptArtifact.sha256,
    sourceReverified: source !== null,
    renderReceipt,
    review: validatedReview.review,
  });
  const receiptBytes = serializePublicationReviewReceipt(receipt);

  const token = randomBytes(12).toString("hex");
  const temporary = temporaryPath(output, token);
  try {
    await writeAndSyncNewFile(temporary, receiptBytes);
  } catch (error) {
    const cleaned = await removeIfPresent(temporary);
    return failure("temporary_write_failed", `could not write complete temporary review receipt; cleanup ${cleaned ? "succeeded" : "failed"}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await dependencies.beforeFinalize?.();
  } catch (error) {
    await removeIfPresent(temporary);
    return failure("finalize_failed", `review finalization hook failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const unchangedChecks = await Promise.all([
    verifyUnchanged(publication),
    verifyUnchanged(renderReceiptArtifact),
    verifyUnchanged(reviewArtifact),
    ...(source === null ? [] : [verifyUnchanged(source)]),
    verifyUnchanged(bundled.emblem),
    verifyUnchanged(bundled.wordmark),
  ]);
  if (unchangedChecks.some((unchanged) => !unchanged)) {
    await removeIfPresent(temporary);
    return failure("input_changed_during_review", "one or more review inputs changed before finalization");
  }

  try {
    await link(temporary, output.canonical);
    await syncDirectoryBestEffort(output.directory);
    const removed = await removeIfPresent(temporary);
    if (!removed) return failure("finalize_failed", "review receipt was finalized but temporary cleanup failed");
  } catch (error) {
    await removeIfPresent(temporary);
    return failure("finalize_failed", `could not finalize review receipt without overwrite: ${error instanceof Error ? error.message : String(error)}`);
  }

  return Object.freeze({
    ok: true,
    outputBasename: output.basename,
    publicationApproved: receipt.publicationApproved,
    sourceReverified: receipt.technicalValidation.sourceReverified,
    receipt,
  });
}

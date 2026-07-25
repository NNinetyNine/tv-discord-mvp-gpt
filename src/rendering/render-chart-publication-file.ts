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

import {
  validateChartPublicationMetadata,
  type ChartPublicationMetadata,
} from "./chart-publication-template.ts";
import {
  renderChartPublication,
  type ChartPublicationFailure,
  type ChartPublicationFailureReason,
  type ChartPublicationReceipt,
} from "./render-chart-publication.ts";

export interface RenderChartPublicationFileOptions {
  readonly inputPath: string;
  readonly metadataPath: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly watermarkEnabled?: boolean;
}

export interface RenderChartPublicationFileSuccess {
  readonly ok: true;
  readonly outputBasename: string;
  readonly receiptBasename: string;
  readonly outputSha256: string;
  readonly receipt: ChartPublicationReceipt;
}

export type RenderChartPublicationFileResult =
  | RenderChartPublicationFileSuccess
  | ChartPublicationFailure;

export interface RenderChartPublicationFileDependencies {
  readonly render?: typeof renderChartPublication;
  /** Test seam for exercising finalization races; production callers omit it. */
  readonly beforeFinalize?: () => Promise<void>;
}

interface DestinationPath {
  readonly requested: string;
  readonly canonical: string;
  readonly directory: string;
  readonly basename: string;
  readonly exists: boolean;
  readonly existingRealPath: string | null;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

function failure(reason: ChartPublicationFailureReason, detail: string): ChartPublicationFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function resolveDestination(requested: string): Promise<DestinationPath> {
  const absolute = resolve(requested);
  const directory = await realpath(dirname(absolute));
  const name = basename(absolute);
  const canonical = join(directory, name);
  const exists = await pathExists(canonical);
  return Object.freeze({
    requested,
    canonical,
    directory,
    basename: name,
    exists,
    existingRealPath: exists ? await realpath(canonical) : null,
  });
}

async function writeAndSyncNewFile(path: string, bytes: Uint8Array): Promise<void> {
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
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
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
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

function temporaryPath(destination: DestinationPath, token: string): string {
  return join(destination.directory, `.${destination.basename}.visionx-${token}.tmp`);
}

function comparisonKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const stats = await lstat(path, { bigint: true });
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

async function removeOwnedFinalIfPresent(
  path: string,
  expected: FileIdentity,
): Promise<boolean> {
  try {
    const actual = await fileIdentity(path);
    if (actual.device !== expected.device || actual.inode !== expected.inode) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

async function finalizePair(
  temporaryOutput: string,
  output: DestinationPath,
  temporaryReceipt: string,
  receipt: DestinationPath,
): Promise<ChartPublicationFailure | null> {
  let outputIdentity: FileIdentity;
  let receiptIdentity: FileIdentity;
  try {
    outputIdentity = await fileIdentity(temporaryOutput);
    receiptIdentity = await fileIdentity(temporaryReceipt);
  } catch (error) {
    await removeIfPresent(temporaryOutput);
    await removeIfPresent(temporaryReceipt);
    return failure(
      "finalize_failed",
      `could not verify temporary artifacts before finalization: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let outputPublished = false;
  let receiptPublished = false;
  try {
    // Hard-link publication is atomic and fails with EEXIST rather than
    // overwriting a destination that appeared after the initial checks.
    await link(temporaryOutput, output.canonical);
    outputPublished = true;
    await syncDirectoryBestEffort(output.directory);
    await link(temporaryReceipt, receipt.canonical);
    receiptPublished = true;
    await syncDirectoryBestEffort(receipt.directory);

    const outputTempRemoved = await removeIfPresent(temporaryOutput);
    const receiptTempRemoved = await removeIfPresent(temporaryReceipt);
    if (!outputTempRemoved || !receiptTempRemoved) {
      throw new Error("final artifacts were published but temporary-file cleanup failed");
    }
    return null;
  } catch (error) {
    const outputRolledBack = !outputPublished || await removeOwnedFinalIfPresent(output.canonical, outputIdentity);
    const receiptRolledBack = !receiptPublished || await removeOwnedFinalIfPresent(receipt.canonical, receiptIdentity);
    const outputTempRemoved = await removeIfPresent(temporaryOutput);
    const receiptTempRemoved = await removeIfPresent(temporaryReceipt);
    const cleanupSucceeded =
      outputRolledBack && receiptRolledBack && outputTempRemoved && receiptTempRemoved;
    if (!cleanupSucceeded) {
      return failure(
        "rollback_failed",
        `publication finalization failed and rollback was incomplete: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return failure(
      "finalize_failed",
      `publication finalization failed; rollback removed partial artifacts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseMetadata(bytes: Buffer):
  | { readonly ok: true; readonly metadata: ChartPublicationMetadata }
  | ChartPublicationFailure {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return failure(
      "unreadable_metadata",
      `metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validation = validateChartPublicationMetadata(value);
  if (!validation.ok) return failure("invalid_metadata", validation.detail);
  return Object.freeze({ ok: true, metadata: validation.metadata });
}

/**
 * Render and transactionally publish one PNG/receipt pair without modifying the
 * source or metadata files. Final artifacts are created with atomic no-replace
 * hard links from fully flushed temporary files; rollback is attempted if the
 * second final artifact cannot be published.
 */
export async function renderChartPublicationFile(
  options: RenderChartPublicationFileOptions,
  dependencies: RenderChartPublicationFileDependencies = {},
): Promise<RenderChartPublicationFileResult> {
  let sourcePath: string;
  try {
    sourcePath = await realpath(resolve(options.inputPath));
  } catch (error) {
    return failure("unreadable_source", error instanceof Error ? error.message : String(error));
  }
  let metadataPath: string;
  try {
    metadataPath = await realpath(resolve(options.metadataPath));
  } catch (error) {
    return failure("unreadable_metadata", error instanceof Error ? error.message : String(error));
  }
  let output: DestinationPath;
  let receipt: DestinationPath;
  try {
    output = await resolveDestination(options.outputPath);
    receipt = await resolveDestination(options.receiptPath);
  } catch (error) {
    return failure(
      "temporary_write_failed",
      `could not resolve destination parent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sourceKey = comparisonKey(sourcePath);
  if (
    comparisonKey(output.canonical) === sourceKey ||
    comparisonKey(receipt.canonical) === sourceKey ||
    (output.existingRealPath !== null && comparisonKey(output.existingRealPath) === sourceKey) ||
    (receipt.existingRealPath !== null && comparisonKey(receipt.existingRealPath) === sourceKey)
  ) {
    return failure("source_output_collision", "output and receipt destinations must not resolve to the source image");
  }
  if (
    comparisonKey(output.canonical) === comparisonKey(receipt.canonical) ||
    (output.existingRealPath !== null &&
      receipt.existingRealPath !== null &&
      comparisonKey(output.existingRealPath) === comparisonKey(receipt.existingRealPath))
  ) {
    return failure("output_receipt_collision", "output PNG and receipt must use different destinations");
  }
  if (output.exists) return failure("output_already_exists", "output destination already exists");
  if (receipt.exists) return failure("receipt_already_exists", "receipt destination already exists");

  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(sourcePath);
  } catch (error) {
    return failure("unreadable_source", error instanceof Error ? error.message : String(error));
  }
  let metadataBytes: Buffer;
  try {
    metadataBytes = await readFile(metadataPath);
  } catch (error) {
    return failure("unreadable_metadata", error instanceof Error ? error.message : String(error));
  }
  const parsed = parseMetadata(metadataBytes);
  if (!parsed.ok) return parsed;

  const sourceHashBefore = hash(sourceBytes);
  const render = dependencies.render ?? renderChartPublication;
  const rendered = await render(sourceBytes, parsed.metadata, {
    watermarkEnabled: options.watermarkEnabled !== false,
  });
  if (!rendered.ok) return rendered;

  const token = randomBytes(12).toString("hex");
  const temporaryOutput = temporaryPath(output, token);
  const temporaryReceipt = temporaryPath(receipt, token);
  try {
    await writeAndSyncNewFile(temporaryOutput, rendered.outputPng);
    await writeAndSyncNewFile(temporaryReceipt, rendered.receiptBytes);
  } catch (error) {
    const outputCleaned = await removeIfPresent(temporaryOutput);
    const receiptCleaned = await removeIfPresent(temporaryReceipt);
    return failure(
      "temporary_write_failed",
      `could not write complete temporary artifacts; cleanup ${outputCleaned && receiptCleaned ? "succeeded" : "was incomplete"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let sourceHashAfter: string;
  try {
    sourceHashAfter = hash(await readFile(sourcePath));
  } catch (error) {
    await removeIfPresent(temporaryOutput);
    await removeIfPresent(temporaryReceipt);
    return failure("unreadable_source", `could not re-read source after rendering: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sourceHashAfter !== sourceHashBefore) {
    await removeIfPresent(temporaryOutput);
    await removeIfPresent(temporaryReceipt);
    return failure("source_changed_during_render", "source SHA-256 changed during rendering; no final artifacts were published");
  }

  try {
    await dependencies.beforeFinalize?.();
  } catch (error) {
    await removeIfPresent(temporaryOutput);
    await removeIfPresent(temporaryReceipt);
    return failure(
      "finalize_failed",
      `publication finalization hook failed before any final artifact was published: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const finalizationFailure = await finalizePair(
    temporaryOutput,
    output,
    temporaryReceipt,
    receipt,
  );
  if (finalizationFailure !== null) return finalizationFailure;

  return Object.freeze({
    ok: true,
    outputBasename: output.basename,
    receiptBasename: receipt.basename,
    outputSha256: rendered.receipt.output.sha256,
    receipt: rendered.receipt,
  });
}

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { Workspace, PackState } from "../packs/workspace.ts";
import type { StagingStore } from "../wiring/staging.ts";
import type { ValidationResult } from "../types.ts";
import type { ChartPublicationTimeframe } from "./chart-publication-preview.ts";

export interface AcceptPackChartPublicationFileOptions {
  readonly sourceBasename: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly outputBasename: string;
  readonly receiptBasename: string;
  readonly outputSha256: string;
  readonly assetId: string;
  readonly packId: string;
  readonly timeframe: ChartPublicationTimeframe;
  readonly dataAsOf: string;
}

export interface AcceptPackChartPublicationFileDependencies {
  readonly workspace: Workspace;
  readonly staging: StagingStore;
  readonly validate: (imagePath: string) => ValidationResult | Promise<ValidationResult>;
  readonly now: () => string;
}

export type AcceptPackChartPublicationFileResult =
  | {
      readonly ok: true;
      readonly outcome: "staged_render";
      readonly sourceBasename: string;
      readonly outputBasename: string;
      readonly receiptBasename: string;
      readonly outputSha256: string;
      readonly assetId: string;
      readonly packId: string;
      readonly timeframe: ChartPublicationTimeframe;
      readonly dataAsOf: string;
      readonly revisions: number;
      readonly packState: PackState;
      readonly capturedCount: number;
      readonly totalCount: number;
      readonly remainingRequiredAssetIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly outcome: "artifact_verification_failed";
      readonly assetId: string;
      readonly packId: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "validation_failed";
      readonly assetId: string;
      readonly packId: string;
      readonly reason: string;
      readonly checks: Readonly<Record<string, boolean>>;
    }
  | {
      readonly ok: false;
      readonly outcome: "staging_failed";
      readonly assetId: string;
      readonly packId: string;
      readonly detail: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function acceptPackChartPublicationFile(
  options: AcceptPackChartPublicationFileOptions,
  dependencies: AcceptPackChartPublicationFileDependencies,
): Promise<AcceptPackChartPublicationFileResult> {
  const pack = dependencies.workspace.pack(options.packId);
  if (pack === null || !pack.assets.includes(options.assetId)) {
    return Object.freeze({
      ok: false,
      outcome: "artifact_verification_failed",
      assetId: options.assetId,
      packId: options.packId,
      detail: `Asset ${options.assetId} is not a current member of Pack ${options.packId}.`,
    });
  }
  if (
    basename(options.outputPath) !== options.outputBasename ||
    basename(options.receiptPath) !== options.receiptBasename
  ) {
    return Object.freeze({
      ok: false,
      outcome: "artifact_verification_failed",
      assetId: options.assetId,
      packId: options.packId,
      detail: "Prepared artifact names do not match their stored paths.",
    });
  }

  try {
    const [outputStat, receiptStat] = await Promise.all([
      lstat(options.outputPath),
      lstat(options.receiptPath),
    ]);
    if (
      outputStat.isSymbolicLink() || !outputStat.isFile() ||
      receiptStat.isSymbolicLink() || !receiptStat.isFile()
    ) {
      throw new Error("Prepared publication evidence must be regular non-symlink files.");
    }
    const [output, receipt] = await Promise.all([
      readFile(options.outputPath),
      readFile(options.receiptPath),
    ]);
    if (receipt.length === 0 || hash(output) !== options.outputSha256) {
      return Object.freeze({
        ok: false,
        outcome: "artifact_verification_failed",
        assetId: options.assetId,
        packId: options.packId,
        detail: "Prepared publication or receipt no longer matches its render evidence.",
      });
    }
  } catch (error) {
    return Object.freeze({
      ok: false,
      outcome: "artifact_verification_failed",
      assetId: options.assetId,
      packId: options.packId,
      detail: `Prepared publication evidence is unavailable: ${errorMessage(error)}`,
    });
  }

  const validation = await dependencies.validate(options.outputPath);
  if (!validation.ok) {
    return Object.freeze({
      ok: false,
      outcome: "validation_failed",
      assetId: options.assetId,
      packId: options.packId,
      reason: validation.reason ?? "validation failed",
      checks: Object.freeze({ ...validation.checks }),
    });
  }

  try {
    dependencies.staging.stage(options.assetId, options.outputPath);
  } catch (error) {
    return Object.freeze({
      ok: false,
      outcome: "staging_failed",
      assetId: options.assetId,
      packId: options.packId,
      detail: errorMessage(error),
    });
  }

  const capture = dependencies.workspace.capture(options.assetId, dependencies.now());
  const remainingRequiredAssetIds = Object.freeze([
    ...dependencies.workspace.pendingAssets(options.packId),
  ]);
  return Object.freeze({
    ok: true,
    outcome: "staged_render",
    sourceBasename: options.sourceBasename,
    outputBasename: options.outputBasename,
    receiptBasename: options.receiptBasename,
    outputSha256: options.outputSha256,
    assetId: options.assetId,
    packId: options.packId,
    timeframe: options.timeframe,
    dataAsOf: options.dataAsOf,
    revisions: capture.revisions,
    packState: dependencies.workspace.packState(options.packId),
    capturedCount: pack.assets.length - remainingRequiredAssetIds.length,
    totalCount: pack.assets.length,
    remainingRequiredAssetIds,
  });
}

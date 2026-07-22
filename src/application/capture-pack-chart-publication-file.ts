import { basename } from "node:path";

import type { Workspace, PackState } from "../packs/workspace.ts";
import type { StagingStore } from "../wiring/staging.ts";
import type { ValidationResult } from "../types.ts";
import {
  previewChartPublicationFile,
  type PreviewChartPublicationFileDependencies,
  type PreviewChartPublicationFileResult,
} from "./chart-publication-preview-file.ts";
import type { ChartPublicationTimeframe } from "./chart-publication-preview.ts";

/**
 * One accepted Pack render entering publication custody.
 *
 * The raw TradingView export and the no-overwrite render/receipt pair remain
 * untouched. Only the rendered PNG is copied into the asset-keyed staging
 * slot consumed by publishPack(). Workspace capture is recorded last, after
 * rendering, validation, and staging have all succeeded.
 */
export interface CapturePackChartPublicationFileOptions {
  readonly inputPath: string;
  readonly assetId: string;
  readonly packId: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly registryPath: string;
  readonly channelsPath: string;
  readonly packsPath: string;
}

export interface CapturePackChartPublicationFileDependencies {
  readonly workspace: Workspace;
  readonly staging: StagingStore;
  readonly validate: (imagePath: string) => ValidationResult | Promise<ValidationResult>;
  readonly now: () => string;
  readonly preview?: typeof previewChartPublicationFile;
  readonly previewDependencies?: PreviewChartPublicationFileDependencies;
}

export type CapturePackChartPublicationFileResult =
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
      readonly outcome: "render_failed";
      readonly reason: string;
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

function renderFailure(
  result: Exclude<PreviewChartPublicationFileResult, { readonly ok: true }>,
): CapturePackChartPublicationFileResult {
  return Object.freeze({
    ok: false,
    outcome: "render_failed",
    reason: result.reason,
    detail: result.detail,
  });
}

export async function capturePackChartPublicationFile(
  options: CapturePackChartPublicationFileOptions,
  dependencies: CapturePackChartPublicationFileDependencies,
): Promise<CapturePackChartPublicationFileResult> {
  const preview = dependencies.preview ?? previewChartPublicationFile;
  const rendered = await preview(
    {
      inputPath: options.inputPath,
      request: { context: "pack", assetId: options.assetId, packId: options.packId },
      outputPath: options.outputPath,
      receiptPath: options.receiptPath,
      registryPath: options.registryPath,
      channelsPath: options.channelsPath,
      packsPath: options.packsPath,
    },
    dependencies.previewDependencies,
  );
  if (!rendered.ok) return renderFailure(rendered);

  if (rendered.context !== "pack" || rendered.packId !== options.packId) {
    throw new Error("Pack chart capture received a non-Pack or mismatched render result");
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
  const pack = dependencies.workspace.pack(options.packId);
  if (pack === null) {
    throw new Error(`Pack ${options.packId} disappeared after its render was prepared`);
  }
  const remainingRequiredAssetIds = Object.freeze([
    ...dependencies.workspace.pendingAssets(options.packId),
  ]);

  return Object.freeze({
    ok: true,
    outcome: "staged_render",
    sourceBasename: basename(options.inputPath),
    outputBasename: rendered.outputBasename,
    receiptBasename: rendered.receiptBasename,
    outputSha256: rendered.outputSha256,
    assetId: options.assetId,
    packId: options.packId,
    timeframe: rendered.timeframe,
    dataAsOf: rendered.dataAsOf,
    revisions: capture.revisions,
    packState: dependencies.workspace.packState(options.packId),
    capturedCount: pack.assets.length - remainingRequiredAssetIds.length,
    totalCount: pack.assets.length,
    remainingRequiredAssetIds,
  });
}

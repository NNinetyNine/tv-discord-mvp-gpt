import type { Workspace } from "../packs/workspace.ts";
import type { StagingStore } from "../wiring/staging.ts";
import type { ValidationResult } from "../types.ts";
import {
  previewChartPublicationFile,
  type PreviewChartPublicationFileDependencies,
  type PreviewChartPublicationFileResult,
} from "./chart-publication-preview-file.ts";
import {
  acceptPackChartPublicationFile,
  type AcceptPackChartPublicationFileResult,
} from "./accept-pack-chart-publication-file.ts";

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
  | AcceptPackChartPublicationFileResult
  | {
      readonly ok: false;
      readonly outcome: "render_failed";
      readonly reason: string;
      readonly detail: string;
    };

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

  return acceptPackChartPublicationFile({
    sourceBasename: rendered.sourceBasename,
    outputPath: options.outputPath,
    receiptPath: options.receiptPath,
    outputBasename: rendered.outputBasename,
    receiptBasename: rendered.receiptBasename,
    outputSha256: rendered.outputSha256,
    assetId: options.assetId,
    packId: options.packId,
    timeframe: rendered.timeframe,
    dataAsOf: rendered.dataAsOf,
  }, dependencies);
}

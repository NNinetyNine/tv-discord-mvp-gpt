import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import {
  renderChartPublicationFile,
  type RenderChartPublicationFileDependencies,
  type RenderChartPublicationFileResult,
} from "../rendering/render-chart-publication-file.ts";
import {
  prepareChartPublicationPreview,
  type ChartPublicationPreviewPreparationResult,
} from "./chart-publication-preview.ts";

export interface PreviewChartPublicationFileOptions {
  readonly inputPath: string;
  readonly profilePath: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly registryPath: string;
  readonly channelsPath: string;
}

export interface PreviewChartPublicationFileSuccess {
  readonly ok: true;
  readonly sourceBasename: string;
  readonly assetId: string;
  readonly dataAsOf: string;
  readonly metadata: Exclude<ChartPublicationPreviewPreparationResult, { readonly ok: false }>["metadata"];
  readonly outputBasename: string;
  readonly receiptBasename: string;
  readonly outputSha256: string;
  readonly receipt: Exclude<RenderChartPublicationFileResult, { readonly ok: false }>["receipt"];
}

export type PreviewChartPublicationFileResult =
  | PreviewChartPublicationFileSuccess
  | Exclude<ChartPublicationPreviewPreparationResult, { readonly ok: true }>
  | Exclude<RenderChartPublicationFileResult, { readonly ok: true }>
  | {
      readonly ok: false;
      readonly reason: "unreadable_profile" | "temporary_metadata_failed";
      readonly detail: string;
    };

export interface PreviewChartPublicationFileDependencies {
  readonly render?: typeof renderChartPublicationFile;
  readonly renderDependencies?: RenderChartPublicationFileDependencies;
}

function failure(
  reason: "unreadable_profile" | "temporary_metadata_failed",
  detail: string,
): PreviewChartPublicationFileResult {
  return Object.freeze({ ok: false, reason, detail });
}

export async function previewChartPublicationFile(
  options: PreviewChartPublicationFileOptions,
  dependencies: PreviewChartPublicationFileDependencies = {},
): Promise<PreviewChartPublicationFileResult> {
  let profileValue: unknown;
  try {
    profileValue = JSON.parse(await readFile(options.profilePath, "utf8"));
  } catch (error) {
    return failure(
      "unreadable_profile",
      `could not read/parse preview profile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const registry = loadRegistry(options.registryPath, options.channelsPath);
  const resolver = createResolver(registry);
  const prepared = prepareChartPublicationPreview(
    registry,
    resolver,
    options.inputPath,
    profileValue,
  );
  if (!prepared.ok) return prepared;

  let temporaryDirectory: string;
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "visionx-chart-preview-"));
  } catch (error) {
    return failure(
      "temporary_metadata_failed",
      `could not create temporary metadata directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const metadataPath = join(temporaryDirectory, "metadata.json");
    try {
      await writeFile(metadataPath, `${JSON.stringify(prepared.metadata, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      return failure(
        "temporary_metadata_failed",
        `could not write temporary render metadata: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const render = dependencies.render ?? renderChartPublicationFile;
    const rendered = await render(
      {
        inputPath: options.inputPath,
        metadataPath,
        outputPath: options.outputPath,
        receiptPath: options.receiptPath,
      },
      dependencies.renderDependencies,
    );
    if (!rendered.ok) return rendered;

    return Object.freeze({
      ok: true,
      sourceBasename: prepared.sourceBasename,
      assetId: prepared.assetId,
      dataAsOf: prepared.dataAsOf,
      metadata: prepared.metadata,
      outputBasename: rendered.outputBasename,
      receiptBasename: rendered.receiptBasename,
      outputSha256: rendered.outputSha256,
      receipt: rendered.receipt,
    });
  } finally {
    // The preview result is defined by the final PNG/receipt pair. A best-effort
    // temporary metadata cleanup must not turn a successfully finalized pair
    // into a reported failure.
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

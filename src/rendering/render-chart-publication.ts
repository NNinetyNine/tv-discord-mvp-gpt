import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import sharp, { type OverlayOptions } from "sharp";

import {
  detectChartFrameFromPixels,
  type ChartFrameDetectionFailure,
  type ChartFrameDetectionResult,
  type ChartFrameFailureReason,
  type ChartFrameObservation,
  type DecodedPixelImage,
} from "../validation/detect-chart-frame.ts";
import { readDecodedImagePixels } from "../validation/inspect-image.ts";
import {
  buildChartPublicationOverlaySvg,
  calculateChartPublicationLayout,
  CHART_PUBLICATION_BRANDING,
  CHART_PUBLICATION_COLORS,
  CHART_PUBLICATION_DIMENSIONS,
  CHART_PUBLICATION_LAYOUT_IDENTIFIER,
  CHART_PUBLICATION_RENDERER_IDENTIFIER,
  CHART_PUBLICATION_RENDERER_VERSION,
  CHART_PUBLICATION_TEMPLATE_IDENTIFIER,
  CHART_PUBLICATION_TEMPLATE_VERSION,
  type ChartPlacement,
  type ChartPublicationLayout,
  type ChartPublicationMetadata,
  type RectanglePlacement,
  validateChartPublicationMetadata,
} from "./chart-publication-template.ts";

export const CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION = 2 as const;
const CHART_PUBLICATION_PNG_COMPRESSION_LEVEL = 6;

const BRANDING_ASSET_URLS = Object.freeze({
  emblem: new URL(`../../assets/branding/${CHART_PUBLICATION_BRANDING.emblem.filename}`, import.meta.url),
  wordmark: new URL(`../../assets/branding/${CHART_PUBLICATION_BRANDING.wordmark.filename}`, import.meta.url),
});

export type ChartPublicationFailureReason =
  | "invalid_arguments"
  | "invalid_metadata"
  | "unreadable_metadata"
  | "unreadable_source"
  | "detector_rejected_source"
  | "invalid_detected_bounds"
  | "source_output_collision"
  | "output_receipt_collision"
  | "output_already_exists"
  | "receipt_already_exists"
  | "render_failed"
  | "temporary_write_failed"
  | "finalize_failed"
  | "rollback_failed"
  | "source_changed_during_render";

export interface ChartPublicationFailure {
  readonly ok: false;
  readonly reason: ChartPublicationFailureReason;
  readonly detail: string;
  readonly detectorReason?: ChartFrameFailureReason;
  readonly detectorDetail?: string;
  readonly detectorIdentifier?: string;
  readonly detectorVersion?: string;
  readonly sourceWidth?: number | null;
  readonly sourceHeight?: number | null;
}

interface BrandingPlacementReceipt extends RectanglePlacement {
  readonly assetSha256: string;
}

export interface ChartPublicationReceipt {
  readonly schemaVersion: typeof CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION;
  readonly renderer: {
    readonly id: typeof CHART_PUBLICATION_RENDERER_IDENTIFIER;
    readonly version: typeof CHART_PUBLICATION_RENDERER_VERSION;
  };
  readonly template: {
    readonly id: typeof CHART_PUBLICATION_TEMPLATE_IDENTIFIER;
    readonly version: typeof CHART_PUBLICATION_TEMPLATE_VERSION;
    readonly layoutId: typeof CHART_PUBLICATION_LAYOUT_IDENTIFIER;
    readonly width: number;
    readonly height: number;
  };
  readonly layout: {
    readonly outerBorderThickness: number;
    readonly headerHeight: number;
    readonly headerDividerThickness: number;
    readonly chartGutters: {
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly bottom: number;
    };
    readonly footerDividerThickness: number;
    readonly footerHeight: number;
    readonly visibleFooterAttribution: false;
  };
  readonly source: {
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly format: "png";
  };
  readonly detection: {
    readonly detectorId: string;
    readonly detectorVersion: string;
    readonly coordinateConvention: "zero_based_inclusive";
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
    readonly height: number;
    readonly candidateCount: number;
  };
  readonly placement: ChartPlacement;
  readonly branding: {
    readonly emblem: {
      readonly assetSha256: string;
      readonly header: RectanglePlacement;
      readonly footer: RectanglePlacement;
    };
    readonly wordmark: BrandingPlacementReceipt;
    readonly watermark: BrandingPlacementReceipt & { readonly opacity: number };
  };
  readonly metadata: ChartPublicationMetadata;
  readonly output: {
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly format: "png";
  };
}

export interface ChartPublicationRenderSuccess {
  readonly ok: true;
  readonly outputPng: Buffer;
  readonly receipt: ChartPublicationReceipt;
  readonly receiptBytes: Buffer;
}

export type ChartPublicationRenderResult =
  | ChartPublicationRenderSuccess
  | ChartPublicationFailure;

export type ChartFrameDetector = (image: DecodedPixelImage) => ChartFrameDetectionResult;

export interface ChartPublicationRenderDependencies {
  readonly detectFrame?: ChartFrameDetector;
}

interface BrandingAssets {
  readonly emblem: Buffer;
  readonly wordmark: Buffer;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function freezeFailure(
  reason: ChartPublicationFailureReason,
  detail: string,
  extras: Omit<ChartPublicationFailure, "ok" | "reason" | "detail"> = {},
): ChartPublicationFailure {
  return Object.freeze({ ok: false, reason, detail, ...extras });
}

function freezeRectangle<T extends RectanglePlacement>(rectangle: T): T {
  return Object.freeze({ ...rectangle });
}

function freezeMetadata(metadata: ChartPublicationMetadata): ChartPublicationMetadata {
  return Object.freeze({ ...metadata });
}

function freezePlacement(placement: ChartPlacement): ChartPlacement {
  return Object.freeze({ ...placement });
}

function freezeReceipt(receipt: ChartPublicationReceipt): ChartPublicationReceipt {
  return Object.freeze({
    ...receipt,
    renderer: Object.freeze({ ...receipt.renderer }),
    template: Object.freeze({ ...receipt.template }),
    layout: Object.freeze({
      ...receipt.layout,
      chartGutters: Object.freeze({ ...receipt.layout.chartGutters }),
    }),
    source: Object.freeze({ ...receipt.source }),
    detection: Object.freeze({ ...receipt.detection }),
    placement: freezePlacement(receipt.placement),
    branding: Object.freeze({
      emblem: Object.freeze({
        ...receipt.branding.emblem,
        header: freezeRectangle(receipt.branding.emblem.header),
        footer: freezeRectangle(receipt.branding.emblem.footer),
      }),
      wordmark: freezeRectangle(receipt.branding.wordmark),
      watermark: freezeRectangle(receipt.branding.watermark),
    }),
    metadata: freezeMetadata(receipt.metadata),
    output: Object.freeze({ ...receipt.output }),
  });
}

function detectorFailure(failure: ChartFrameDetectionFailure): ChartPublicationFailure {
  return freezeFailure(
    "detector_rejected_source",
    `chart-frame detector rejected source: ${failure.reason}: ${failure.detail}`,
    {
      detectorReason: failure.reason,
      detectorDetail: failure.detail,
      detectorIdentifier: failure.detectorIdentifier,
      detectorVersion: failure.detectorVersion,
      sourceWidth: failure.sourceWidth,
      sourceHeight: failure.sourceHeight,
    },
  );
}

export function validateDetectedChartBounds(
  detection: ChartFrameObservation,
): ChartPublicationFailure | null {
  const { left, top, right, bottom, sourceWidth, sourceHeight } = detection;
  if (
    !Number.isInteger(left) ||
    !Number.isInteger(top) ||
    !Number.isInteger(right) ||
    !Number.isInteger(bottom) ||
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    left < 0 ||
    top < 0 ||
    right < left ||
    bottom < top ||
    right >= sourceWidth ||
    bottom >= sourceHeight
  ) {
    return freezeFailure("invalid_detected_bounds", "detector returned out-of-range or incoherent inclusive bounds", {
      detectorIdentifier: detection.detectorIdentifier,
      detectorVersion: detection.detectorVersion,
      sourceWidth,
      sourceHeight,
    });
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  if (width <= 0 || height <= 0 || detection.frameWidth !== width || detection.frameHeight !== height) {
    return freezeFailure("invalid_detected_bounds", "detector frame dimensions do not match inclusive bounds", {
      detectorIdentifier: detection.detectorIdentifier,
      detectorVersion: detection.detectorVersion,
      sourceWidth,
      sourceHeight,
    });
  }
  return null;
}

function jsonReceiptBytes(receipt: ChartPublicationReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

async function readVerifiedBrandingAssets(): Promise<BrandingAssets> {
  const [emblem, wordmark] = await Promise.all([
    readFile(fileURLToPath(BRANDING_ASSET_URLS.emblem)),
    readFile(fileURLToPath(BRANDING_ASSET_URLS.wordmark)),
  ]);
  if (hashBytes(emblem) !== CHART_PUBLICATION_BRANDING.emblem.sha256) {
    throw new Error("bundled VisionX emblem SHA-256 does not match renderer contract");
  }
  if (hashBytes(wordmark) !== CHART_PUBLICATION_BRANDING.wordmark.sha256) {
    throw new Error("bundled VisionX wordmark SHA-256 does not match renderer contract");
  }
  const [emblemMetadata, wordmarkMetadata] = await Promise.all([
    sharp(emblem).metadata(),
    sharp(wordmark).metadata(),
  ]);
  if (
    emblemMetadata.width !== CHART_PUBLICATION_BRANDING.emblem.sourceWidth ||
    emblemMetadata.height !== CHART_PUBLICATION_BRANDING.emblem.sourceHeight
  ) {
    throw new Error("bundled VisionX emblem dimensions do not match renderer contract");
  }
  if (
    wordmarkMetadata.width !== CHART_PUBLICATION_BRANDING.wordmark.sourceWidth ||
    wordmarkMetadata.height !== CHART_PUBLICATION_BRANDING.wordmark.sourceHeight
  ) {
    throw new Error("bundled VisionX wordmark dimensions do not match renderer contract");
  }
  return Object.freeze({ emblem, wordmark });
}

async function resizeBrandAsset(
  bytes: Buffer,
  placement: RectanglePlacement,
): Promise<Buffer> {
  return sharp(bytes)
    .resize({
      width: placement.width,
      height: placement.height,
      fit: "contain",
      kernel: sharp.kernel.lanczos3,
    })
    .png({
      compressionLevel: CHART_PUBLICATION_PNG_COMPRESSION_LEVEL,
      adaptiveFiltering: false,
      palette: false,
    })
    .toBuffer();
}

async function buildWatermark(
  emblem: Buffer,
  layout: ChartPublicationLayout,
): Promise<Buffer> {
  const resized = await sharp(emblem)
    .resize({
      width: layout.watermark.width,
      height: layout.watermark.height,
      fit: "contain",
      kernel: sharp.kernel.lanczos3,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaIndex = resized.info.channels - 1;
  for (let offset = alphaIndex; offset < resized.data.length; offset += resized.info.channels) {
    const alpha = resized.data[offset] ?? 0;
    resized.data[offset] = Math.round(alpha * layout.watermark.opacity);
  }
  return sharp(resized.data, {
    raw: {
      width: resized.info.width,
      height: resized.info.height,
      channels: resized.info.channels,
    },
  })
    .png({
      compressionLevel: CHART_PUBLICATION_PNG_COMPRESSION_LEVEL,
      adaptiveFiltering: false,
      palette: false,
    })
    .toBuffer();
}

function solidRectangle(width: number, height: number, color: string): OverlayOptions["input"] {
  return {
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  };
}

async function buildPublicationPng(
  sourceBytes: Buffer,
  detection: ChartFrameObservation,
  layout: ChartPublicationLayout,
  metadata: ChartPublicationMetadata,
  branding: BrandingAssets,
): Promise<Buffer> {
  const cropWidth = detection.right - detection.left + 1;
  const cropHeight = detection.bottom - detection.top + 1;
  const extracted = await sharp(sourceBytes)
    .extract({
      left: detection.left,
      top: detection.top,
      width: cropWidth,
      height: cropHeight,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const resizedChart = await sharp(extracted.data, {
    raw: {
      width: extracted.info.width,
      height: extracted.info.height,
      channels: extracted.info.channels,
    },
  })
    .resize({
      width: layout.placement.renderedWidth,
      kernel: sharp.kernel.lanczos3,
    })
    .png({
      compressionLevel: CHART_PUBLICATION_PNG_COMPRESSION_LEVEL,
      adaptiveFiltering: false,
      palette: false,
    })
    .toBuffer();
  const resizedChartMetadata = await sharp(resizedChart).metadata();
  if (
    resizedChartMetadata.width !== layout.placement.renderedWidth ||
    resizedChartMetadata.height !== layout.placement.renderedHeight
  ) {
    throw new Error("Sharp width-driven chart resize did not match deterministic layout dimensions");
  }

  const watermark = await buildWatermark(branding.emblem, layout);
  const chartWithWatermark = await sharp(resizedChart)
    .composite([{
      input: watermark,
      left: layout.watermark.left - layout.placement.renderedLeft,
      top: layout.watermark.top - layout.placement.renderedTop,
    }])
    .png({
      compressionLevel: CHART_PUBLICATION_PNG_COMPRESSION_LEVEL,
      adaptiveFiltering: false,
      palette: false,
    })
    .toBuffer();

  const [headerEmblem, footerEmblem, footerWordmark] = await Promise.all([
    resizeBrandAsset(branding.emblem, layout.headerEmblem),
    resizeBrandAsset(branding.emblem, layout.footerEmblem),
    resizeBrandAsset(branding.wordmark, layout.footerWordmark),
  ]);
  const overlay = Buffer.from(buildChartPublicationOverlaySvg(metadata, layout), "utf8");
  const width = layout.outputWidth;
  const height = layout.outputHeight;
  const border = layout.outerBorderThickness;

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: CHART_PUBLICATION_COLORS.headerBackground,
    },
  })
    .composite([
      {
        input: solidRectangle(layout.viewport.width, layout.viewport.height, CHART_PUBLICATION_COLORS.viewportGutter),
        left: layout.viewport.left,
        top: layout.viewport.top,
      },
      {
        input: solidRectangle(layout.footer.width, layout.footer.height, CHART_PUBLICATION_COLORS.footerBackground),
        left: layout.footer.left,
        top: layout.footer.top,
      },
      {
        input: chartWithWatermark,
        left: layout.placement.renderedLeft,
        top: layout.placement.renderedTop,
      },
      { input: overlay, left: 0, top: 0 },
      { input: headerEmblem, left: layout.headerEmblem.left, top: layout.headerEmblem.top },
      { input: footerEmblem, left: layout.footerEmblem.left, top: layout.footerEmblem.top },
      { input: footerWordmark, left: layout.footerWordmark.left, top: layout.footerWordmark.top },
      {
        input: solidRectangle(layout.headerDivider.width, layout.headerDivider.height, CHART_PUBLICATION_COLORS.goldRule),
        left: layout.headerDivider.left,
        top: layout.headerDivider.top,
      },
      {
        input: solidRectangle(layout.footerDivider.width, layout.footerDivider.height, CHART_PUBLICATION_COLORS.goldRule),
        left: layout.footerDivider.left,
        top: layout.footerDivider.top,
      },
      { input: solidRectangle(width, border, CHART_PUBLICATION_COLORS.goldRule), left: 0, top: 0 },
      { input: solidRectangle(width, border, CHART_PUBLICATION_COLORS.goldRule), left: 0, top: height - border },
      { input: solidRectangle(border, height, CHART_PUBLICATION_COLORS.goldRule), left: 0, top: 0 },
      { input: solidRectangle(border, height, CHART_PUBLICATION_COLORS.goldRule), left: width - border, top: 0 },
    ])
    .png({
      compressionLevel: CHART_PUBLICATION_PNG_COMPRESSION_LEVEL,
      adaptiveFiltering: false,
      palette: false,
    })
    .toBuffer();
}

/**
 * Render one publication derivative from immutable source bytes.
 *
 * The optional detector dependency is a test seam only. The developer command
 * always uses the existing chart-frame detector and accepts no caller-supplied
 * crop bounds.
 */
export async function renderChartPublication(
  sourceBytes: Buffer,
  metadata: ChartPublicationMetadata,
  dependencies: ChartPublicationRenderDependencies = {},
): Promise<ChartPublicationRenderResult> {
  const validatedMetadata = validateChartPublicationMetadata(metadata);
  if (!validatedMetadata.ok) {
    return freezeFailure("invalid_metadata", validatedMetadata.detail);
  }
  const canonicalMetadata = validatedMetadata.metadata;

  let decoded;
  try {
    decoded = await readDecodedImagePixels(sourceBytes);
  } catch (error) {
    return freezeFailure(
      "unreadable_source",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (decoded.format !== "png") {
    return freezeFailure("unreadable_source", `source format must be png, received ${decoded.format ?? "unknown"}`);
  }

  const detector = dependencies.detectFrame ?? detectChartFrameFromPixels;
  let detection: ChartFrameDetectionResult;
  try {
    detection = detector({
      format: decoded.format,
      width: decoded.width,
      height: decoded.height,
      channelCount: decoded.channelCount,
      data: decoded.data,
    });
  } catch (error) {
    return freezeFailure(
      "render_failed",
      `chart-frame detector threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      { sourceWidth: decoded.width, sourceHeight: decoded.height },
    );
  }

  if (!detection.ok) return detectorFailure(detection);
  if (detection.candidateCount !== 1) {
    return freezeFailure(
      "detector_rejected_source",
      `chart-frame detector returned successful candidateCount ${detection.candidateCount}; expected exactly 1`,
      {
        detectorIdentifier: detection.detectorIdentifier,
        detectorVersion: detection.detectorVersion,
        sourceWidth: detection.sourceWidth,
        sourceHeight: detection.sourceHeight,
      },
    );
  }
  if (detection.sourceWidth !== decoded.width || detection.sourceHeight !== decoded.height) {
    return freezeFailure("invalid_detected_bounds", "detector source dimensions do not match decoded source", {
      detectorIdentifier: detection.detectorIdentifier,
      detectorVersion: detection.detectorVersion,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
    });
  }
  const boundsFailure = validateDetectedChartBounds(detection);
  if (boundsFailure !== null) return boundsFailure;

  const layout = calculateChartPublicationLayout(detection.frameWidth, detection.frameHeight);
  let branding: BrandingAssets;
  let outputPng: Buffer;
  try {
    branding = await readVerifiedBrandingAssets();
    outputPng = await buildPublicationPng(
      sourceBytes,
      detection,
      layout,
      canonicalMetadata,
      branding,
    );
  } catch (error) {
    return freezeFailure(
      "render_failed",
      error instanceof Error ? error.message : String(error),
      { sourceWidth: decoded.width, sourceHeight: decoded.height },
    );
  }

  const outputHash = hashBytes(outputPng);
  const receipt = freezeReceipt({
    schemaVersion: CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION,
    renderer: {
      id: CHART_PUBLICATION_RENDERER_IDENTIFIER,
      version: CHART_PUBLICATION_RENDERER_VERSION,
    },
    template: {
      id: CHART_PUBLICATION_TEMPLATE_IDENTIFIER,
      version: CHART_PUBLICATION_TEMPLATE_VERSION,
      layoutId: CHART_PUBLICATION_LAYOUT_IDENTIFIER,
      width: layout.outputWidth,
      height: layout.outputHeight,
    },
    layout: {
      outerBorderThickness: layout.outerBorderThickness,
      headerHeight: layout.header.height,
      headerDividerThickness: layout.headerDivider.height,
      chartGutters: layout.chartGutters,
      footerDividerThickness: layout.footerDivider.height,
      footerHeight: layout.footer.height,
      visibleFooterAttribution: false,
    },
    source: {
      sha256: hashBytes(sourceBytes),
      width: decoded.width,
      height: decoded.height,
      format: "png",
    },
    detection: {
      detectorId: detection.detectorIdentifier,
      detectorVersion: detection.detectorVersion,
      coordinateConvention: detection.coordinateConvention,
      left: detection.left,
      top: detection.top,
      right: detection.right,
      bottom: detection.bottom,
      width: detection.frameWidth,
      height: detection.frameHeight,
      candidateCount: detection.candidateCount,
    },
    placement: layout.placement,
    branding: {
      emblem: {
        assetSha256: CHART_PUBLICATION_BRANDING.emblem.sha256,
        header: layout.headerEmblem,
        footer: layout.footerEmblem,
      },
      wordmark: {
        assetSha256: CHART_PUBLICATION_BRANDING.wordmark.sha256,
        ...layout.footerWordmark,
      },
      watermark: {
        assetSha256: CHART_PUBLICATION_BRANDING.emblem.sha256,
        ...layout.watermark,
      },
    },
    metadata: freezeMetadata(canonicalMetadata),
    output: {
      sha256: outputHash,
      width: layout.outputWidth,
      height: layout.outputHeight,
      format: "png",
    },
  });

  return Object.freeze({
    ok: true,
    outputPng,
    receipt,
    receiptBytes: jsonReceiptBytes(receipt),
  });
}

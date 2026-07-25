import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  CHART_FRAME_COORDINATE_CONVENTION,
  CHART_FRAME_DETECTOR_IDENTIFIER,
  CHART_FRAME_DETECTOR_VERSION,
  type ChartFrameObservation,
} from "../validation/detect-chart-frame.ts";
import {
  CHART_PUBLICATION_BRANDING,
  CHART_PUBLICATION_COLORS,
  CHART_PUBLICATION_LAYOUT_IDENTIFIER,
  CHART_PUBLICATION_OUTPUT_WIDTH,
  CHART_PUBLICATION_RENDERER_VERSION,
  CHART_PUBLICATION_TEMPLATE_VERSION,
  type ChartPublicationMetadata,
} from "./chart-publication-template.ts";
import {
  CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION,
  renderChartPublication,
  validateDetectedChartBounds,
} from "./render-chart-publication.ts";

const METADATA: ChartPublicationMetadata = Object.freeze({
  title: "BTC PERPETUAL FUTURES",
  symbol: "BTCUSD",
  timeframe: "5M",
  market: "BINANCE",
  currency: "USD",
  dataSource: "BINANCE",
  dataAsOf: "2026-07-17",
  chartAttribution: "Chart source: TradingView",
});

async function makeSupportedSource(): Promise<Buffer> {
  const width = 320;
  const height = 220;
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);
  const setPixel = (x: number, y: number, rgb: readonly [number, number, number]): void => {
    const offset = (y * width + x) * channels;
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(x, y, [31, 31, 31]);
  }
  const left = 8;
  const top = 12;
  const right = 311;
  const bottom = 190;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) setPixel(x, y, [12, 80, 120]);
  }
  for (let x = left; x <= right; x += 1) {
    setPixel(x, top, [45, 45, 45]);
    setPixel(x, bottom, [45, 45, 45]);
  }
  for (let y = top; y <= bottom; y += 1) {
    setPixel(left, y, [45, 45, 45]);
    setPixel(right, y, [45, 45, 45]);
  }
  return sharp(data, { raw: { width, height, channels } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

function invalidObservation(): ChartFrameObservation {
  return Object.freeze({
    ok: true,
    sourceWidth: 320,
    sourceHeight: 220,
    coordinateConvention: CHART_FRAME_COORDINATE_CONVENTION,
    left: 8,
    top: 12,
    right: 320,
    bottom: 190,
    frameWidth: 313,
    frameHeight: 179,
    candidateCount: 1,
    detectorIdentifier: CHART_FRAME_DETECTOR_IDENTIFIER,
    detectorVersion: CHART_FRAME_DETECTOR_VERSION,
    sideContinuity: Object.freeze({
      top: Object.freeze({ matchedPixels: 1, totalPixels: 1, ratio: 1 }),
      right: Object.freeze({ matchedPixels: 1, totalPixels: 1, ratio: 1 }),
      bottom: Object.freeze({ matchedPixels: 1, totalPixels: 1, ratio: 1 }),
      left: Object.freeze({ matchedPixels: 1, totalPixels: 1, ratio: 1 }),
    }),
    corners: Object.freeze({
      topLeft: true,
      topRight: true,
      bottomRight: true,
      bottomLeft: true,
      coherentCornerCount: 4,
    }),
    border: Object.freeze({
      representative: Object.freeze({ red: 45, green: 45, blue: 45 }),
      minimum: Object.freeze({ red: 45, green: 45, blue: 45 }),
      maximum: Object.freeze({ red: 45, green: 45, blue: 45 }),
      neutralPixelRatio: 1,
    }),
    exterior: Object.freeze({
      representative: Object.freeze({ red: 31, green: 31, blue: 31 }),
      minimum: Object.freeze({ red: 31, green: 31, blue: 31 }),
      maximum: Object.freeze({ red: 31, green: 31, blue: 31 }),
      sampleCount: 4,
      contrastFromBorder: 14,
      darkerSampleRatio: 1,
    }),
  });
}

function rgb(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function pixel(
  data: Buffer,
  width: number,
  channels: number,
  x: number,
  y: number,
): readonly [number, number, number] {
  const offset = (y * width + x) * channels;
  return [data[offset] ?? -1, data[offset + 1] ?? -1, data[offset + 2] ?? -1];
}

describe("renderChartPublication", () => {
  it("uses the existing detector and records inclusive crop dimensions", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, METADATA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.detection).toMatchObject({
      left: 8,
      top: 12,
      right: 311,
      bottom: 190,
      width: 304,
      height: 179,
      candidateCount: 1,
    });
    expect(result.receipt.source.sha256).toBe(createHash("sha256").update(source).digest("hex"));
  });

  it("creates deterministic dynamic PNG and receipt bytes with versioned layout", async () => {
    const source = await makeSupportedSource();
    const first = await renderChartPublication(source, METADATA);
    const second = await renderChartPublication(source, METADATA);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.outputPng.equals(second.outputPng)).toBe(true);
    expect(first.receiptBytes.equals(second.receiptBytes)).toBe(true);
    const info = await sharp(first.outputPng).metadata();
    expect(info).toMatchObject({
      width: CHART_PUBLICATION_OUTPUT_WIDTH,
      height: first.receipt.output.height,
      format: "png",
    });
    expect(first.receipt).toMatchObject({
      schemaVersion: CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION,
      renderer: { version: CHART_PUBLICATION_RENDERER_VERSION },
      template: {
        version: CHART_PUBLICATION_TEMPLATE_VERSION,
        layoutId: CHART_PUBLICATION_LAYOUT_IDENTIFIER,
      },
    });
    expect(first.receipt.output.sha256).toBe(
      createHash("sha256").update(first.outputPng).digest("hex"),
    );
  });

  it("omits the centre V watermark only when explicitly disabled", async () => {
    const source = await makeSupportedSource();
    const enabled = await renderChartPublication(source, METADATA);
    const disabled = await renderChartPublication(source, METADATA, { watermarkEnabled: false });
    expect(enabled.ok).toBe(true);
    expect(disabled.ok).toBe(true);
    if (!enabled.ok || !disabled.ok) return;
    expect(enabled.receipt.branding.watermark.opacity).toBe(CHART_PUBLICATION_BRANDING.watermarkOpacity);
    expect(disabled.receipt.branding.watermark.opacity).toBe(0);
    expect(disabled.receipt.branding.watermark).toMatchObject({
      assetSha256: enabled.receipt.branding.watermark.assetSha256,
      left: enabled.receipt.branding.watermark.left,
      top: enabled.receipt.branding.watermark.top,
      width: enabled.receipt.branding.watermark.width,
      height: enabled.receipt.branding.watermark.height,
    });
    expect(disabled.outputPng.equals(enabled.outputPng)).toBe(false);
    expect(disabled.receipt.output.sha256).not.toBe(enabled.receipt.output.sha256);
  });

  it("renders the chart near full width with slim symmetric gutters and preserved aspect ratio", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, METADATA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const placement = result.receipt.placement;
    expect(placement.fit).toBe("contain");
    expect(placement.renderedLeft).toBe(5);
    expect(placement.renderedWidth).toBe(2038);
    expect(placement.renderedLeft - placement.viewportLeft).toBe(4);
    expect(
      placement.viewportLeft + placement.viewportWidth -
      (placement.renderedLeft + placement.renderedWidth),
    ).toBe(4);
    expect(placement.renderedWidth / placement.renderedHeight).toBeCloseTo(304 / 179, 3);
  });

  it("renders exact outer edges, section dividers, and region palette pixels", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, METADATA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data, info } = await sharp(result.outputPng).raw().toBuffer({ resolveWithObject: true });
    const gold = rgb(CHART_PUBLICATION_COLORS.goldRule);
    const header = rgb(CHART_PUBLICATION_COLORS.headerBackground);
    const footer = rgb(CHART_PUBLICATION_COLORS.footerBackground);
    const gutter = rgb(CHART_PUBLICATION_COLORS.viewportGutter);
    for (const x of [0, Math.floor(info.width / 2), info.width - 1]) {
      expect(pixel(data, info.width, info.channels, x, 0)).toEqual(gold);
      expect(pixel(data, info.width, info.channels, x, info.height - 1)).toEqual(gold);
    }
    for (const y of [0, Math.floor(info.height / 2), info.height - 1]) {
      expect(pixel(data, info.width, info.channels, 0, y)).toEqual(gold);
      expect(pixel(data, info.width, info.channels, info.width - 1, y)).toEqual(gold);
    }
    expect(pixel(data, info.width, info.channels, 1000, 20)).toEqual(header);
    expect(pixel(data, info.width, info.channels, 2, result.receipt.placement.viewportTop + 1)).toEqual(gutter);
    const footerTop = info.height - 1 - result.receipt.layout.footerHeight;
    expect(pixel(data, info.width, info.channels, 1000, footerTop + 10)).toEqual(footer);
    expect(pixel(data, info.width, info.channels, 1000, 40)).toEqual(gold);
    expect(pixel(data, info.width, info.channels, 1000, footerTop - 1)).toEqual(gold);
  });

  it("records and renders exact bundled branding placements", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, METADATA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.branding).toMatchObject({
      emblem: { assetSha256: CHART_PUBLICATION_BRANDING.emblem.sha256 },
      wordmark: { assetSha256: CHART_PUBLICATION_BRANDING.wordmark.sha256 },
      watermark: { assetSha256: CHART_PUBLICATION_BRANDING.emblem.sha256, opacity: 0.035 },
    });
    const { data, info } = await sharp(result.outputPng).raw().toBuffer({ resolveWithObject: true });
    const headerRect = result.receipt.branding.emblem.header;
    const footerRect = result.receipt.branding.wordmark;
    const headerBackground = rgb(CHART_PUBLICATION_COLORS.headerBackground);
    const footerBackground = rgb(CHART_PUBLICATION_COLORS.footerBackground);
    let headerChanged = 0;
    for (let y = headerRect.top; y < headerRect.top + headerRect.height; y += 1) {
      for (let x = headerRect.left; x < headerRect.left + headerRect.width; x += 1) {
        if (pixel(data, info.width, info.channels, x, y).some((value, index) => value !== headerBackground[index])) headerChanged += 1;
      }
    }
    let footerChanged = 0;
    for (let y = footerRect.top; y < footerRect.top + footerRect.height; y += 1) {
      for (let x = footerRect.left; x < footerRect.left + footerRect.width; x += 1) {
        if (pixel(data, info.width, info.channels, x, y).some((value, index) => value !== footerBackground[index])) footerChanged += 1;
      }
    }
    expect(headerChanged).toBeGreaterThan(0);
    expect(footerChanged).toBeGreaterThan(0);
  });

  it("adds a centered restrained watermark without introducing diagnostic red", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, METADATA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data, info } = await sharp(result.outputPng).raw().toBuffer({ resolveWithObject: true });
    let diagnosticRedFound = false;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (data[offset] === 255 && data[offset + 1] === 0 && data[offset + 2] === 76) {
        diagnosticRedFound = true;
        break;
      }
    }
    expect(diagnosticRedFound).toBe(false);

    const watermark = result.receipt.branding.watermark;
    let changedPixels = 0;
    let maximumDelta = 0;
    for (let y = watermark.top; y < watermark.top + watermark.height; y += 1) {
      for (let x = watermark.left; x < watermark.left + watermark.width; x += 1) {
        const actual = pixel(data, info.width, info.channels, x, y);
        const baseline = [12, 80, 120] as const;
        const delta = Math.max(...actual.map((value, index) => Math.abs(value - (baseline[index] ?? 0))));
        if (delta > 0) changedPixels += 1;
        maximumDelta = Math.max(maximumDelta, delta);
      }
    }
    expect(changedPixels).toBeGreaterThan(0);
    expect(maximumDelta).toBeLessThanOrEqual(10);

    const safeX = result.receipt.placement.renderedLeft + 40;
    const safeY = result.receipt.placement.renderedTop + 40;
    expect(pixel(data, info.width, info.channels, safeX, safeY)).toEqual([12, 80, 120]);
  });

  it("retains chart attribution in receipt while marking it hidden from the visible footer", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, METADATA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.metadata.chartAttribution).toBe("Chart source: TradingView");
    expect(result.receipt.layout.visibleFooterAttribution).toBe(false);
    expect(result.receipt.metadata.currency).toBe("USD");
  });

  it("preserves typed detector failure details", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, METADATA, {
      detectFrame: () => Object.freeze({
        ok: false,
        reason: "multiple_comparable_candidates",
        detail: "two distinct frames",
        sourceWidth: 320,
        sourceHeight: 220,
        candidateCount: 2,
        detectorIdentifier: CHART_FRAME_DETECTOR_IDENTIFIER,
        detectorVersion: CHART_FRAME_DETECTOR_VERSION,
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "detector_rejected_source",
      detectorReason: "multiple_comparable_candidates",
      detectorDetail: "two distinct frames",
    });
  });

  it("fails closed on invalid detector bounds without fallback coordinates", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, METADATA, {
      detectFrame: () => invalidObservation(),
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_detected_bounds" });
  });

  it("rejects invalid metadata at the buffer-level boundary", async () => {
    const source = await makeSupportedSource();
    const result = await renderChartPublication(source, {
      ...METADATA,
      chartAttribution: "",
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_metadata" });
  });

  it("does not mutate source bytes", async () => {
    const source = await makeSupportedSource();
    const before = Buffer.from(source);
    await renderChartPublication(source, METADATA);
    expect(source.equals(before)).toBe(true);
  });

  it("validates inclusive bounds independently", () => {
    expect(validateDetectedChartBounds(invalidObservation())).toMatchObject({
      ok: false,
      reason: "invalid_detected_bounds",
    });
  });
});

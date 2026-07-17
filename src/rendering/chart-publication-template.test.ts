import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildChartPublicationOverlaySvg,
  calculateChartPublicationLayout,
  CHART_PUBLICATION_BRANDING,
  CHART_PUBLICATION_COLORS,
  CHART_PUBLICATION_DIMENSIONS,
  CHART_PUBLICATION_FONT,
  CHART_PUBLICATION_METADATA_MAX_LENGTHS,
  CHART_PUBLICATION_OUTPUT_WIDTH,
  escapeXmlText,
  formatPublicationDate,
  validateChartPublicationMetadata,
  visibleChartPublicationFooter,
  type ChartPublicationMetadata,
} from "./chart-publication-template.ts";

const VALID_METADATA: ChartPublicationMetadata = Object.freeze({
  title: "BTC PERPETUAL FUTURES",
  symbol: "BTCUSD",
  timeframe: "5M",
  market: "BINANCE",
  currency: "USD",
  dataSource: "BINANCE",
  dataAsOf: "2026-07-17",
  chartAttribution: "Chart source: TradingView",
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("chart-publication template", () => {
  it("accepts and freezes valid metadata including optional currency", () => {
    const result = validateChartPublicationMetadata(VALID_METADATA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata).toEqual(VALID_METADATA);
    expect(Object.isFrozen(result.metadata)).toBe(true);
  });

  it("rejects missing attribution and empty required fields", () => {
    const { chartAttribution: _omitted, ...missing } = VALID_METADATA;
    expect(validateChartPublicationMetadata(missing)).toMatchObject({ ok: false });
    expect(validateChartPublicationMetadata({ ...VALID_METADATA, title: "   " })).toMatchObject({
      ok: false,
    });
  });

  it("rejects malformed and impossible calendar dates", () => {
    expect(validateChartPublicationMetadata({ ...VALID_METADATA, dataAsOf: "17.07.2026" })).toMatchObject({ ok: false });
    expect(validateChartPublicationMetadata({ ...VALID_METADATA, dataAsOf: "2026-02-30" })).toMatchObject({ ok: false });
  });

  it("rejects control characters, overlong values, and unknown fields", () => {
    expect(validateChartPublicationMetadata({ ...VALID_METADATA, title: "BTC\nFUTURES" })).toMatchObject({ ok: false });
    expect(validateChartPublicationMetadata({
      ...VALID_METADATA,
      title: "X".repeat(CHART_PUBLICATION_METADATA_MAX_LENGTHS.title + 1),
    })).toMatchObject({ ok: false });
    expect(validateChartPublicationMetadata({ ...VALID_METADATA, extra: "unsupported" })).toMatchObject({ ok: false });
  });

  it("rejects invalid optional currency values", () => {
    expect(validateChartPublicationMetadata({ ...VALID_METADATA, currency: 42 })).toMatchObject({ ok: false });
    expect(validateChartPublicationMetadata({ ...VALID_METADATA, currency: "   " })).toMatchObject({ ok: false });
    expect(validateChartPublicationMetadata({ ...VALID_METADATA, currency: "US\nD" })).toMatchObject({ ok: false });
    expect(validateChartPublicationMetadata({
      ...VALID_METADATA,
      currency: "X".repeat(CHART_PUBLICATION_METADATA_MAX_LENGTHS.currency + 1),
    })).toMatchObject({ ok: false });
  });

  it("uses the exact approved palette and reduced typography constants", () => {
    expect(CHART_PUBLICATION_COLORS).toEqual({
      headerBackground: "#1B1B18",
      footerBackground: "#1B1B18",
      viewportGutter: "#151513",
      goldRule: "#3F371E",
      secondaryText: "#7F7F7E",
      titleText: "#E2E2E1",
    });
    expect(CHART_PUBLICATION_FONT.headerTitleSize).toBe(14);
    expect(CHART_PUBLICATION_FONT.headerSecondarySize).toBe(10);
    expect(CHART_PUBLICATION_FONT.footerSize).toBe(10);
  });

  it("calculates the exact width-driven layout for the canonical evidence crop", () => {
    const layout = calculateChartPublicationLayout(2153, 1257);
    expect(layout.outputWidth).toBe(2048);
    expect(layout.outputHeight).toBe(1274);
    expect(layout.outerBorderThickness).toBe(1);
    expect(layout.header.height).toBe(39);
    expect(layout.headerDivider.height).toBe(1);
    expect(layout.footerDivider.height).toBe(1);
    expect(layout.footer.height).toBe(33);
    expect(layout.placement).toMatchObject({
      renderedLeft: 5,
      renderedTop: 45,
      renderedWidth: 2038,
      renderedHeight: 1190,
      fit: "contain",
    });
    expect(layout.chartGutters).toEqual({ left: 4, right: 4, top: 4, bottom: 4 });
  });

  it("derives output height from chart aspect ratio without changing output width", () => {
    const tall = calculateChartPublicationLayout(1000, 1000);
    const wide = calculateChartPublicationLayout(2000, 1000);
    expect(tall.outputWidth).toBe(CHART_PUBLICATION_OUTPUT_WIDTH);
    expect(wide.outputWidth).toBe(CHART_PUBLICATION_OUTPUT_WIDTH);
    expect(tall.outputHeight).toBeGreaterThan(wide.outputHeight);
    expect(tall.placement.renderedWidth / tall.placement.renderedHeight).toBeCloseTo(1, 3);
    expect(wide.placement.renderedWidth / wide.placement.renderedHeight).toBeCloseTo(2, 3);
  });

  it("places compact header/footer branding and a centered low-opacity watermark", () => {
    const layout = calculateChartPublicationLayout(2153, 1257);
    expect(layout.headerEmblem).toMatchObject({ left: 16, width: 15, height: 14 });
    expect(layout.footerEmblem).toMatchObject({ width: 15, height: 14 });
    expect(layout.footerWordmark).toMatchObject({ width: 58, height: 13 });
    expect(layout.watermark.opacity).toBe(0.035);
    expect(layout.watermark.opacity).toBeLessThanOrEqual(0.05);
    expect(layout.watermark.left + Math.floor(layout.watermark.width / 2)).toBeCloseTo(
      layout.placement.renderedLeft + Math.floor(layout.placement.renderedWidth / 2),
      0,
    );
    expect(layout.watermark.top + Math.floor(layout.watermark.height / 2)).toBeCloseTo(
      layout.placement.renderedTop + Math.floor(layout.placement.renderedHeight / 2),
      0,
    );
  });

  it("preserves exact bundled branding asset hashes", () => {
    const emblem = readFileSync(fileURLToPath(new URL("../../assets/branding/visionx-emblem.png", import.meta.url)));
    const wordmark = readFileSync(fileURLToPath(new URL("../../assets/branding/visionx-wordmark.png", import.meta.url)));
    expect(hash(emblem)).toBe(CHART_PUBLICATION_BRANDING.emblem.sha256);
    expect(hash(wordmark)).toBe(CHART_PUBLICATION_BRANDING.wordmark.sha256);
  });

  it("formats the display date without changing the canonical metadata value", () => {
    expect(formatPublicationDate(VALID_METADATA.dataAsOf)).toBe("17.07.2026");
    expect(VALID_METADATA.dataAsOf).toBe("2026-07-17");
  });

  it("escapes all XML-sensitive metadata characters", () => {
    expect(escapeXmlText(`A&B <C> "D" 'E'`)).toBe(
      "A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;",
    );
  });

  it("renders deterministic compact header, currency, and source/date footer SVG", () => {
    const metadata = { ...VALID_METADATA, title: "BTC & <FUTURES>" };
    const layout = calculateChartPublicationLayout(2153, 1257);
    const first = buildChartPublicationOverlaySvg(metadata, layout);
    const second = buildChartPublicationOverlaySvg(metadata, layout);
    expect(first).toBe(second);
    expect(first).toContain("BTC &amp; &lt;FUTURES&gt; · 5M · BINANCE");
    expect(first).toContain(">USD</text>");
    expect(first).toContain("SOURCE: BINANCE · DATA AS OF: 17.07.2026");
    expect(first).not.toContain("CHART SOURCE: TRADINGVIEW");
    expect(first).not.toContain(">VISIONX</text>");
    expect(first).not.toContain("<script");
  });

  it("omits the header-right text cleanly when currency and legacy text are absent", () => {
    const { currency: _currency, ...metadata } = VALID_METADATA;
    const svg = buildChartPublicationOverlaySvg(metadata, calculateChartPublicationLayout(1600, 900));
    expect(svg).not.toContain("class=\"header-right\"");
  });

  it("retains attribution in metadata while excluding it from the visible footer", () => {
    expect(VALID_METADATA.chartAttribution).toBe("Chart source: TradingView");
    expect(visibleChartPublicationFooter(VALID_METADATA)).toBe(
      "SOURCE: BINANCE · DATA AS OF: 17.07.2026",
    );
  });

  it("uses the measured thin-region constants", () => {
    expect(CHART_PUBLICATION_DIMENSIONS).toEqual({
      outerBorder: 1,
      headerHeight: 39,
      headerDivider: 1,
      chartGutterLeft: 4,
      chartGutterRight: 4,
      chartGutterTop: 4,
      chartGutterBottom: 4,
      footerDivider: 1,
      footerHeight: 33,
    });
  });
});

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { renderChartPublication } from "../rendering/render-chart-publication.ts";
import { chartPublicationMetadataForAsset } from "./chart-publication-metadata.ts";


async function supportedSource(): Promise<Buffer> {
  const width = 320;
  const height = 220;
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);
  const pixel = (x: number, y: number, red: number, green: number, blue: number): void => {
    const offset = (y * width + x) * channels;
    data[offset] = red; data[offset + 1] = green; data[offset + 2] = blue; data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixel(x, y, 31, 31, 31);
  for (let y = 12; y <= 190; y += 1) for (let x = 8; x <= 311; x += 1) pixel(x, y, 12, 80, 120);
  for (let x = 8; x <= 311; x += 1) { pixel(x, 12, 45, 45, 45); pixel(x, 190, 45, 45, 45); }
  for (let y = 12; y <= 190; y += 1) { pixel(8, y, 45, 45, 45); pixel(311, y, 45, 45, 45); }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

const facts = Object.freeze({
  timeframe: "1W",
  dataSource: "TradingView",
  dataAsOf: "2026-07-20",
  chartAttribution: "VisionX",
});

describe("Registry-backed chart publication metadata", () => {
  it("derives title, market, symbol, and currency from the canonical Asset", () => {
    const result = chartPublicationMetadataForAsset({
      id: "dxy",
      tradingView: "TVC:DXY",
      display: "U.S. Dollar Currency Index",
      currency: "USD",
      channel: "forex",
    }, facts);
    expect(result).toMatchObject({
      ok: true,
      metadata: {
        title: "U.S. DOLLAR CURRENCY INDEX",
        market: "TVC",
        symbol: "DXY",
        currency: "USD",
        timeframe: "1W",
      },
    });
  });


  it("passes canonical currency through the existing renderer into deterministic render evidence", async () => {
    const metadata = chartPublicationMetadataForAsset({
      id: "dxy", tradingView: "TVC:DXY", display: "U.S. Dollar Currency Index", currency: "USD", channel: "forex",
    }, facts);
    expect(metadata.ok).toBe(true);
    if (!metadata.ok) return;
    const rendered = await renderChartPublication(await supportedSource(), metadata.metadata);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.receipt.metadata).toMatchObject({ title: "U.S. DOLLAR CURRENCY INDEX", market: "TVC", symbol: "DXY", currency: "USD" });
  });

  it("preserves normalized slash-delimited quote units", () => {
    expect(chartPublicationMetadataForAsset({
      id: "cl1",
      tradingView: "NYMEX:CL1!",
      display: "Crude Oil",
      currency: "USD/BLL",
      channel: "commodities",
    }, facts)).toMatchObject({
      ok: true,
      metadata: {
        market: "NYMEX",
        symbol: "CL1!",
        currency: "USD/BLL",
      },
    });
  });

  it("fails before rendering when canonical identity or currency is incomplete", () => {
    expect(chartPublicationMetadataForAsset({ id: "dxy", tradingView: "DXY", display: "DXY", currency: "USD", channel: "forex" }, facts)).toMatchObject({ ok: false, reason: "unqualified_tradingview_symbol" });
    expect(chartPublicationMetadataForAsset({ id: "dxy", tradingView: "TVC:DXY", display: "DXY", channel: "forex" }, facts)).toMatchObject({ ok: false, reason: "missing_asset_currency" });
    expect(chartPublicationMetadataForAsset({ id: "dxy", tradingView: "TVC:DXY", display: "DXY", currency: "usd", channel: "forex" }, facts)).toMatchObject({ ok: false, reason: "invalid_asset_currency" });
  });
});

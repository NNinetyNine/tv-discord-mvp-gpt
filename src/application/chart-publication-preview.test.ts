import { describe, expect, it } from "vitest";

import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import {
  CHART_PUBLICATION_PREVIEW_ATTRIBUTION,
  deriveTradingViewExportDate,
  prepareChartPublicationPreview,
  validateChartPublicationPreviewProfile,
} from "./chart-publication-preview.ts";

function fixture() {
  const registry = buildRegistry(
    {
      btc: {
        tradingView: "CRYPTO:BTCUSD",
        display: "Bitcoin / U.S. Dollar",
        currency: "USD",
        channel: "crypto",
      },
      eth: {
        tradingView: "ETH",
        tradingViewAliases: ["ETHUSD"],
        display: "Ethereum",
        channel: "crypto",
      },
    },
    { crypto: "" },
  );
  return { registry, resolver: createResolver(registry) };
}

describe("chart publication preview profile", () => {
  it("accepts a strict controlled Asset/timeframe profile", () => {
    expect(validateChartPublicationPreviewProfile({
      schemaVersion: 1,
      assetId: "btc",
      timeframe: "1H",
    })).toEqual({
      ok: true,
      profile: { schemaVersion: 1, assetId: "btc", timeframe: "1H" },
    });
  });

  it("rejects unsupported timeframes, foreign fields, and malformed Asset ids", () => {
    expect(validateChartPublicationPreviewProfile({ schemaVersion: 1, assetId: "btc", timeframe: "hourly" })).toMatchObject({ ok: false });
    expect(validateChartPublicationPreviewProfile({ schemaVersion: 1, assetId: "btc", timeframe: "1H", dataSource: "TRADINGVIEW" })).toMatchObject({ ok: false });
    expect(validateChartPublicationPreviewProfile({ schemaVersion: 1, assetId: "BTC", timeframe: "1H" })).toMatchObject({ ok: false });
  });
});

describe("TradingView export date", () => {
  it("derives the date from a strict export basename", () => {
    expect(deriveTradingViewExportDate("/tmp/BTCUSD_2026-07-22_18-58-01.png")).toEqual({
      ok: true,
      dataAsOf: "2026-07-22",
    });
  });

  it("rejects missing and impossible timestamps", () => {
    expect(deriveTradingViewExportDate("BTCUSD.png")).toMatchObject({ ok: false, reason: "missing_export_timestamp" });
    expect(deriveTradingViewExportDate("BTCUSD_2026-02-30_18-58-01.png")).toMatchObject({ ok: false, reason: "invalid_export_timestamp" });
    expect(deriveTradingViewExportDate("BTCUSD_2026-07-22_24-00-00.png")).toMatchObject({ ok: false, reason: "invalid_export_timestamp" });
  });
});

describe("Registry-backed chart publication preview preparation", () => {
  it("uses canonical identity, derives date, and displays canonical market as source", () => {
    const { registry, resolver } = fixture();
    const result = prepareChartPublicationPreview(
      registry,
      resolver,
      "/tmp/BTCUSD_2026-07-22_18-58-01.png",
      { schemaVersion: 1, assetId: "btc", timeframe: "1H" },
    );

    expect(result).toEqual({
      ok: true,
      sourceBasename: "BTCUSD_2026-07-22_18-58-01.png",
      assetId: "btc",
      dataAsOf: "2026-07-22",
      metadata: {
        title: "BITCOIN / U.S. DOLLAR",
        symbol: "BTCUSD",
        timeframe: "1H",
        market: "CRYPTO",
        currency: "USD",
        dataSource: "CRYPTO",
        dataAsOf: "2026-07-22",
        chartAttribution: CHART_PUBLICATION_PREVIEW_ATTRIBUTION,
      },
    });
  });

  it("fails when the controlled profile does not match the filename-resolved Asset", () => {
    const { registry, resolver } = fixture();
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "BTCUSD_2026-07-22_18-58-01.png",
      { schemaVersion: 1, assetId: "eth", timeframe: "1H" },
    )).toMatchObject({ ok: false, reason: "profile_asset_mismatch" });
  });

  it("fails before metadata construction when timestamp evidence is unavailable", () => {
    const { registry, resolver } = fixture();
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "BTCUSD.png",
      { schemaVersion: 1, assetId: "btc", timeframe: "1H" },
    )).toMatchObject({ ok: false, reason: "missing_export_timestamp" });
  });
});

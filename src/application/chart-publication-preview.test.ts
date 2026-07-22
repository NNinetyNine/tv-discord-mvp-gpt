import { describe, expect, it } from "vitest";

import { buildPacks } from "../packs/packs.ts";
import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import {
  CHART_PUBLICATION_PREVIEW_ATTRIBUTION,
  defaultChartPublicationTimeframeForPack,
  deriveTradingViewExportDate,
  prepareChartPublicationPreview,
  validateChartPublicationPreviewRequest,
  validateChartPublicationTimeframe,
} from "./chart-publication-preview.ts";

function fixture() {
  const channels = { crypto: "", etfs: "" };
  const registry = buildRegistry(
    {
      btc: {
        tradingView: "CRYPTO:BTCUSD",
        display: "Bitcoin / U.S. Dollar",
        currency: "USD",
        channel: "crypto",
      },
      acwi: {
        tradingView: "AMEX:ACWI",
        display: "iShares MSCI ACWI ETF",
        currency: "USD",
        channel: "etfs",
      },
      orphan: {
        tradingView: "NASDAQ:ORPHAN",
        display: "Standalone Only",
        currency: "USD",
        channel: "crypto",
      },
    },
    channels,
  );
  const packs = buildPacks(
    [
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] },
      { id: "etfs", display: "ETFs", channel: "etfs", assets: ["acwi"] },
    ],
    new Set(registry.all().map((asset) => asset.id)),
    new Set(Object.keys(channels)),
  );
  return { registry, resolver: createResolver(registry), packs };
}

describe("chart publication rendering request", () => {
  it("accepts standalone and Pack contexts without a per-ticker profile file", () => {
    expect(validateChartPublicationPreviewRequest({
      context: "standalone",
      assetId: "btc",
      timeframe: "4H",
    })).toEqual({
      ok: true,
      request: { context: "standalone", assetId: "btc", timeframe: "4H" },
    });
    expect(validateChartPublicationPreviewRequest({
      context: "pack",
      assetId: "btc",
      packId: "crypto",
    })).toEqual({
      ok: true,
      request: { context: "pack", assetId: "btc", packId: "crypto" },
    });
  });

  it("accepts 4D and other supported standalone timeframes", () => {
    expect(validateChartPublicationTimeframe("4D")).toEqual({ ok: true, timeframe: "4D" });
    expect(validateChartPublicationTimeframe("12H")).toEqual({ ok: true, timeframe: "12H" });
  });

  it("rejects malformed contexts, identifiers, foreign fields, and unsupported timeframes", () => {
    expect(validateChartPublicationPreviewRequest({ context: "other", assetId: "btc", timeframe: "1D" })).toMatchObject({ ok: false });
    expect(validateChartPublicationPreviewRequest({ context: "standalone", assetId: "BTC", timeframe: "1D" })).toMatchObject({ ok: false });
    expect(validateChartPublicationPreviewRequest({ context: "standalone", assetId: "btc", timeframe: "hourly" })).toMatchObject({ ok: false });
    expect(validateChartPublicationPreviewRequest({ context: "standalone", assetId: "btc", timeframe: "1D", packId: "crypto" })).toMatchObject({ ok: false });
    expect(validateChartPublicationPreviewRequest({ context: "pack", assetId: "btc", packId: "crypto", timeframe: "1D" })).toMatchObject({ ok: false });
  });

  it("uses 1D for ordinary Packs and 4D for the ETF Pack", () => {
    expect(defaultChartPublicationTimeframeForPack({ id: "crypto" })).toBe("1D");
    expect(defaultChartPublicationTimeframeForPack({ id: "stocks" })).toBe("1D");
    expect(defaultChartPublicationTimeframeForPack({ id: "etfs" })).toBe("4D");
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

describe("Registry-backed chart publication preparation", () => {
  it("renders a standalone Registry Asset with an operator-selected supported timeframe", () => {
    const { registry, resolver } = fixture();
    const result = prepareChartPublicationPreview(
      registry,
      resolver,
      "/tmp/ORPHAN_2026-07-22_18-58-01.png",
      { context: "standalone", assetId: "orphan", timeframe: "3H" },
    );

    expect(result).toEqual({
      ok: true,
      context: "standalone",
      sourceBasename: "ORPHAN_2026-07-22_18-58-01.png",
      assetId: "orphan",
      timeframe: "3H",
      dataAsOf: "2026-07-22",
      metadata: {
        title: "STANDALONE ONLY",
        symbol: "ORPHAN",
        timeframe: "3H",
        market: "NASDAQ",
        currency: "USD",
        dataSource: "NASDAQ",
        dataAsOf: "2026-07-22",
        chartAttribution: CHART_PUBLICATION_PREVIEW_ATTRIBUTION,
      },
    });
  });

  it("uses the ordinary Pack default after proving membership", () => {
    const { registry, resolver, packs } = fixture();
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "BTCUSD_2026-07-22_18-58-01.png",
      { context: "pack", assetId: "btc", packId: "crypto" },
      packs,
    )).toMatchObject({
      ok: true,
      context: "pack",
      assetId: "btc",
      packId: "crypto",
      timeframe: "1D",
      metadata: { timeframe: "1D", market: "CRYPTO", dataSource: "CRYPTO" },
    });
  });

  it("uses the ETF Pack 4D default after proving membership", () => {
    const { registry, resolver, packs } = fixture();
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "ACWI_2026-07-22_18-58-01.png",
      { context: "pack", assetId: "acwi", packId: "etfs" },
      packs,
    )).toMatchObject({
      ok: true,
      context: "pack",
      assetId: "acwi",
      packId: "etfs",
      timeframe: "4D",
      metadata: { timeframe: "4D", market: "AMEX", dataSource: "AMEX" },
    });
  });

  it("fails closed on missing Pack definitions, unknown Packs, and non-membership", () => {
    const { registry, resolver, packs } = fixture();
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "BTCUSD_2026-07-22_18-58-01.png",
      { context: "pack", assetId: "btc", packId: "crypto" },
    )).toMatchObject({ ok: false, reason: "pack_definitions_required" });
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "BTCUSD_2026-07-22_18-58-01.png",
      { context: "pack", assetId: "btc", packId: "missing" },
      packs,
    )).toMatchObject({ ok: false, reason: "unknown_pack" });
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "ORPHAN_2026-07-22_18-58-01.png",
      { context: "pack", assetId: "orphan", packId: "crypto" },
      packs,
    )).toMatchObject({ ok: false, reason: "asset_not_in_pack" });
  });

  it("fails when the selected Asset does not match the filename-resolved Asset", () => {
    const { registry, resolver } = fixture();
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "BTCUSD_2026-07-22_18-58-01.png",
      { context: "standalone", assetId: "orphan", timeframe: "1H" },
    )).toMatchObject({ ok: false, reason: "request_asset_mismatch" });
  });

  it("fails before metadata construction when timestamp evidence is unavailable", () => {
    const { registry, resolver } = fixture();
    expect(prepareChartPublicationPreview(
      registry,
      resolver,
      "BTCUSD.png",
      { context: "standalone", assetId: "btc", timeframe: "1H" },
    )).toMatchObject({ ok: false, reason: "missing_export_timestamp" });
  });
});

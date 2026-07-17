import { describe, expect, it } from "vitest";

import { previewChartPublicationMetadataForProposedAsset } from "./chart-publication-metadata-preview.ts";

describe("proposed Asset publication metadata preview", () => {
  it("copies Asset-owned market, symbol, and currency without parsing", () => {
    const preview = previewChartPublicationMetadataForProposedAsset({
      id: "token",
      displayName: "Token Example",
      symbol: "ABCUSDT",
      market: "BINANCE",
      tradingViewSymbol: "BINANCE:ABCUSDT",
      currency: "BTC",
    });
    expect(preview).toEqual({ title: "TOKEN EXAMPLE", symbol: "ABCUSDT", market: "BINANCE", currency: "BTC" });
    expect(preview.currency).not.toBe("USDT");
  });
});

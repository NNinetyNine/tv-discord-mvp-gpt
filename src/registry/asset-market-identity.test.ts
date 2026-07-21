import { describe, expect, it } from "vitest";

import {
  validateProposedAssetMarketIdentity,
  validatePublicationCurrency,
} from "./asset-market-identity.ts";

const VALID = Object.freeze({
  id: "example_asset",
  displayName: "Example Asset",
  symbol: "EXAMPLE",
  market: "NASDAQ",
  tradingViewSymbol: "NASDAQ:EXAMPLE",
  currency: "USD",
});

describe("Asset market identity validation", () => {
  it("accepts one explicit normalized identity", () => {
    const result = validateProposedAssetMarketIdentity(VALID);
    expect(result).toEqual({ ok: true, asset: VALID });
    expect(result.ok && Object.isFrozen(result.asset)).toBe(true);
  });

  it.each([
    [undefined, "missing_currency"],
    ["", "missing_currency"],
    ["usd", "invalid_currency"],
    [" USD", "invalid_currency"],
    ["U$D", "invalid_currency"],
    ["USD/", "invalid_currency"],
    ["/BLL", "invalid_currency"],
    ["USD//BLL", "invalid_currency"],
    ["USD/bll", "invalid_currency"],
    ["U", "invalid_currency"],
    ["123456789", "invalid_currency"],
    [42, "invalid_currency"],
  ])("rejects invalid currency %#", (currency, reason) => {
    expect(validatePublicationCurrency(currency)).toMatchObject({ ok: false, reason });
  });

  it("accepts normalized slash-delimited quote units", () => {
    expect(validatePublicationCurrency("USD/BLL")).toEqual({
      ok: true,
      currency: "USD/BLL",
    });
  });

  it("does not provide an implicit USD default", () => {
    const value = { ...VALID } as Record<string, unknown>;
    delete value.currency;
    expect(validateProposedAssetMarketIdentity(value)).toMatchObject({ ok: false, reason: "missing_currency" });
  });

  it("rejects an unqualified TradingView symbol", () => {
    expect(validateProposedAssetMarketIdentity({ ...VALID, tradingViewSymbol: "EXAMPLE" })).toMatchObject({
      ok: false,
      reason: "invalid_tradingview_symbol",
    });
  });

  it("rejects a market-prefix mismatch", () => {
    expect(validateProposedAssetMarketIdentity({ ...VALID, tradingViewSymbol: "NYSE:EXAMPLE" })).toMatchObject({
      ok: false,
      reason: "market_symbol_mismatch",
    });
  });

  it("supports current normalized symbol punctuation without guessing", () => {
    expect(validateProposedAssetMarketIdentity({
      ...VALID,
      symbol: "BRK.B",
      tradingViewSymbol: "NYSE:BRK.B",
      market: "NYSE",
    })).toMatchObject({ ok: true });
    expect(validateProposedAssetMarketIdentity({
      ...VALID,
      symbol: "ES1!",
      tradingViewSymbol: "CME:ES1!",
      market: "CME",
    })).toMatchObject({ ok: true });
  });
});

import { describe, expect, it } from "vitest";

import { auditAssetMarketIdentity } from "./asset-market-identity-audit.ts";

const ASSETS = Object.freeze([
  Object.freeze({ id: "aem", tradingView: "AEM", display: "Agnico Eagle Mines", channel: "stocks" }),
  Object.freeze({
    id: "btc",
    tradingView: "BINANCE:BTCUSDT",
    display: "Bitcoin",
    channel: "crypto",
    currency: "USDT",
  }),
]);
const PACKS = Object.freeze([
  Object.freeze({ id: "stocks", assets: Object.freeze(["aem"]) }),
  Object.freeze({ id: "crypto", assets: Object.freeze(["btc"]) }),
]);

describe("Asset market identity audit", () => {
  it("reports unqualified Assets without guessing market or currency", () => {
    const audit = auditAssetMarketIdentity(ASSETS, PACKS);
    const aem = audit.assets.find((entry) => entry.assetId === "aem");
    expect(audit.ok).toBe(false);
    expect(aem).toMatchObject({
      currentTradingView: "AEM",
      marketIdentityStatus: "requires_curator_decision",
      currencyStatus: "missing",
      issues: ["unqualified_market_symbol", "missing_publication_currency"],
    });
    expect(aem).not.toHaveProperty("market");
    expect(aem).not.toHaveProperty("currency");
  });


  it("derives market and symbol identity from a qualified token and typed canonical currency", () => {
    const audit = auditAssetMarketIdentity([
      Object.freeze({ id: "dxy", tradingView: "TVC:DXY", display: "U.S. Dollar Currency Index", currency: "USD", channel: "forex" }),
    ], []);
    expect(audit).toMatchObject({ ok: true, registryAssetCount: 1, gaps: [] });
    expect(audit.assets[0]).toMatchObject({
      marketIdentityStatus: "complete", currencyStatus: "valid", market: "TVC", tradingViewSymbol: "TVC:DXY", currency: "USD", issues: [],
    });
  });

  it("reports only missing currency for a valid qualified token without canonical currency", () => {
    const audit = auditAssetMarketIdentity([Object.freeze({ id: "dxy", tradingView: "TVC:DXY", display: "DXY", channel: "forex" })], []);
    expect(audit.assets[0]).toMatchObject({ marketIdentityStatus: "complete", currencyStatus: "missing", issues: ["missing_publication_currency"] });
  });

  it("is deterministic and includes every Asset and membership once", () => {
    const first = auditAssetMarketIdentity(ASSETS, PACKS);
    const second = auditAssetMarketIdentity(ASSETS, PACKS);
    expect(second).toEqual(first);
    expect(first.registryAssetCount).toBe(2);
    expect(first.packCount).toBe(2);
    expect(first.packMembershipCount).toBe(2);
    expect(first.assets.map((entry) => entry.assetId)).toEqual(["aem", "btc"]);
  });

  it("reports unknown and duplicate Pack references without mutation", () => {
    const packs = [Object.freeze({ id: "p", assets: Object.freeze(["aem", "aem", "missing"]) })];
    const beforeAssets = JSON.stringify(ASSETS);
    const beforePacks = JSON.stringify(packs);
    const audit = auditAssetMarketIdentity(ASSETS, packs);
    expect(audit.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue: "duplicate_pack_asset", assetId: "aem", packId: "p" }),
      expect.objectContaining({ issue: "unknown_pack_asset", assetId: "missing", packId: "p" }),
    ]));
    expect(JSON.stringify(ASSETS)).toBe(beforeAssets);
    expect(JSON.stringify(packs)).toBe(beforePacks);
  });

  it("contains no path or wall-clock fields", () => {
    const json = JSON.stringify(auditAssetMarketIdentity(ASSETS, PACKS));
    expect(json).not.toMatch(/path|timestamp|createdAt|reviewedAt/u);
  });
});

import { describe, expect, it } from "vitest";

import { auditAssetMarketIdentity } from "./asset-market-identity-audit.ts";

const ASSETS = Object.freeze([
  Object.freeze({ id: "aem", tradingView: "AEM", display: "Agnico Eagle Mines", channel: "stocks" }),
  Object.freeze({
    id: "btc",
    tradingView: "BTC",
    display: "Bitcoin",
    channel: "crypto",
    market: "BINANCE",
    tradingViewSymbol: "BINANCE:BTCUSDT",
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

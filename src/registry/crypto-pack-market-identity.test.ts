import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadPacks } from "../packs/packs.ts";
import { auditAssetMarketIdentity, packsForAudit } from "./asset-market-identity-audit.ts";
import { loadRegistry } from "./registry.ts";

const CRYPTO_IDENTITIES = Object.freeze([
  Object.freeze({ id: "akt", tradingView: "CRYPTO:AKTUSD", currency: "USD", filenameToken: "AKTUSD" }),
  Object.freeze({ id: "zec", tradingView: "CRYPTO:ZECUSD", currency: "USD", filenameToken: "ZECUSD" }),
  Object.freeze({ id: "pepe", tradingView: "CRYPTO:PEPEUSD", currency: "USD", filenameToken: "PEPEUSD" }),
  Object.freeze({ id: "doge", tradingView: "CRYPTO:DOGEUSD", currency: "USD", filenameToken: "DOGEUSD" }),
  Object.freeze({ id: "fet", tradingView: "CRYPTO:FETUSD", currency: "USD", filenameToken: "FETUSD" }),
  Object.freeze({ id: "xlm", tradingView: "CRYPTO:XLMUSD", currency: "USD", filenameToken: "XLMUSD" }),
  Object.freeze({ id: "xrp", tradingView: "CRYPTO:XRPUSD", currency: "USD", filenameToken: "XRPUSD" }),
  Object.freeze({ id: "sui", tradingView: "CRYPTO:SUIUSD", currency: "USD", filenameToken: "SUIUSD" }),
  Object.freeze({ id: "tao", tradingView: "BITGET:TAOUSDT", currency: "USDT", filenameToken: "TAOUSDT" }),
  Object.freeze({ id: "trx", tradingView: "CRYPTO:TRXUSD", currency: "USD", filenameToken: "TRXUSD" }),
  Object.freeze({ id: "link", tradingView: "CRYPTO:LINKUSD", currency: "USD", filenameToken: "LINKUSD" }),
  Object.freeze({ id: "sol", tradingView: "CRYPTO:SOLUSD", currency: "USD", filenameToken: "SOLUSD" }),
  Object.freeze({ id: "hype", tradingView: "CRYPTO:HYPEHUSD", currency: "USD", filenameToken: "HYPEHUSD" }),
  Object.freeze({ id: "eth", tradingView: "CRYPTO:ETHUSD", currency: "USD", filenameToken: "ETHUSD" }),
  Object.freeze({ id: "btc", tradingView: "CRYPTO:BTCUSD", currency: "USD", filenameToken: "BTCUSD" }),
  Object.freeze({ id: "total3", tradingView: "CRYPTOCAP:TOTAL3", currency: "USD", filenameToken: "TOTAL3" }),
]);

function canonicalState() {
  const registryPath = resolve("definitions/registry.json");
  const channelsPath = resolve("config/channels.json");
  const packsPath = resolve("definitions/packs.json");
  const channels = JSON.parse(readFileSync(channelsPath, "utf8")) as Record<string, unknown>;
  const registry = loadRegistry(registryPath, channelsPath);
  const assets = registry.all();
  const packs = loadPacks(
    packsPath,
    new Set(assets.map((asset) => asset.id)),
    new Set(Object.keys(channels)),
  );
  return { registry, assets, packs };
}

describe("canonical Crypto Pack market identities", () => {
  it("matches the complete operator-approved identity and currency map", () => {
    const { registry, assets, packs } = canonicalState();
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const crypto = packs.find((pack) => pack.id === "crypto");

    expect(crypto?.assets).toEqual(CRYPTO_IDENTITIES.map((identity) => identity.id));
    for (const identity of CRYPTO_IDENTITIES) {
      const asset = byId.get(identity.id);
      expect(asset).toMatchObject({
        id: identity.id,
        tradingView: identity.tradingView,
        currency: identity.currency,
        channel: "crypto",
      });
      expect(asset?.tradingViewAliases).toBeUndefined();
      expect(registry.lookupByTradingView(identity.tradingView)?.id).toBe(identity.id);
      expect(registry.lookupByTradingView(identity.filenameToken)).toBeNull();
      expect(registry.lookupByFilenameSymbol(identity.filenameToken)?.id).toBe(identity.id);
    }
  });

  it("has one collision-free canonical identity and filename token per member", () => {
    expect(new Set(CRYPTO_IDENTITIES.map((identity) => identity.tradingView.toUpperCase())).size).toBe(16);
    expect(new Set(CRYPTO_IDENTITIES.map((identity) => identity.filenameToken.toUpperCase())).size).toBe(16);
    expect(() => canonicalState()).not.toThrow();
  });

  it("closes every Crypto audit gap while preserving remaining Pack gaps", () => {
    const { assets, packs } = canonicalState();
    const audit = auditAssetMarketIdentity(assets, packsForAudit(packs));
    const cryptoIds = new Set<string>(CRYPTO_IDENTITIES.map((identity) => identity.id));
    const cryptoEntries = audit.assets.filter((asset) => cryptoIds.has(asset.assetId));

    expect(cryptoEntries).toHaveLength(16);
    expect(cryptoEntries.every((asset) =>
      asset.marketIdentityStatus === "complete" &&
      asset.currencyStatus === "valid" &&
      asset.issues.length === 0
    )).toBe(true);
    expect(audit.gaps).toHaveLength(228);
    expect(audit.gaps.every((gap) => !cryptoIds.has(gap.assetId))).toBe(true);
  });
});

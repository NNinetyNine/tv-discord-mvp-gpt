import { describe, it, expect } from "vitest";

import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "./index.ts";

const channels = { crypto: "", stocks: "", indices: "" };
const fixture = {
  btc:  { tradingView: "CRYPTO:BTCUSD", display: "Bitcoin / U.S. Dollar", currency: "USD", channel: "crypto" },
  eth:  { tradingView: "ETHUSD", display: "Ethereum", channel: "crypto" },
  aapl: { tradingView: "AAPL",   display: "Apple",    channel: "stocks" },
  spx:  { tradingView: "SPX",    display: "S&P 500",  channel: "indices" },
  // Underscore-bearing canonical token + a separate "B" asset: this pair proves
  // the retired provisional rule (keep-after-last-underscore) no longer runs.
  // With formatting-only normalization, "NOVO_B" resolves to novob (not b).
  novob: { tradingView: "NOVO_B", display: "Novo Nordisk", channel: "stocks" },
  b:     { tradingView: "B",      display: "Barrick Mining", channel: "stocks" },
  legacy: { tradingView: "LEGACY", tradingViewAliases: ["LEGACYUSD"], display: "Legacy", channel: "crypto" },
};
const resolver = createResolver(buildRegistry(fixture, channels));

describe("resolver — real filenames resolve to assets", () => {
  it("AAPL_<stamp>.png -> aapl", () => {
    const r = resolver.resolve("AAPL_2026-06-25_01-21-06.png");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe("aapl");
  });

  it("BTCUSD_<stamp>.png -> btc/Bitcoin/crypto", () => {
    const r = resolver.resolve("BTCUSD_2026-06-25_01-18-55.png");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.asset.id).toBe("btc");
      expect(r.asset.display).toBe("Bitcoin / U.S. Dollar");
      expect(r.asset.tradingView).toBe("CRYPTO:BTCUSD");
      expect(r.asset.currency).toBe("USD");
      expect(r.asset.tradingViewAliases).toBeUndefined();
      expect(r.asset.channel).toBe("crypto");
    }
  });

  it("lowercase filename still resolves (case-insensitive)", () => {
    const r = resolver.resolve("btcusd_2026-06-25_01-18-55.png");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe("btc");
  });

  it("temporary legacy aliases still resolve", () => {
    const r = resolver.resolve("LEGACYUSD_2026-06-25_01-21-06.png");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe("legacy");
  });

  it("SPX_<stamp>.png -> spx (real export form, no exchange prefix)", () => {
    const r = resolver.resolve("SPX_2026-06-25_01-21-06.png");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe("spx");
  });
});

describe("resolver — formatting-only normalization (no semantic translation)", () => {
  it("underscore-bearing symbol NOVO_B resolves to novob, NOT b", () => {
    // Guards against regression of the retired keep-after-last-underscore rule,
    // which would have reduced NOVO_B -> B and mis-resolved Novo Nordisk as Barrick.
    const r = resolver.resolve("NOVO_B_2026-06-25_01-21-06.png");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.asset.id).toBe("novob");
      expect(r.asset.display).toBe("Novo Nordisk");
    }
  });

  it("standalone B still resolves to b (Barrick)", () => {
    const r = resolver.resolve("B_2026-06-25_01-21-06.png");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe("b");
  });

  it("an underscore-prefixed name is NOT reduced to its trailing segment", () => {
    // "SP_SPX" no longer normalizes to "SPX" — the provisional exchange-prefix
    // rule is gone. Since real SPX exports are "SPX_...", and no SP_SPX alias is
    // declared, this correctly resolves to unknown_symbol carrying the token.
    const r = resolver.resolve("SP_SPX_2026-06-25_01-21-06.png");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown_symbol");
      if (r.reason === "unknown_symbol") expect(r.symbol).toBe("SP_SPX");
    }
  });
});

describe("resolver — failure cases never throw", () => {
  it("DOGEUSD -> unknown_symbol carrying the symbol", () => {
    const r = resolver.resolve("DOGEUSD_2026-06-25_01-30-00.png");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown_symbol");
      if (r.reason === "unknown_symbol") expect(r.symbol).toBe("DOGEUSD");
    }
  });

  it("empty filename -> unparseable_filename", () => {
    const r = resolver.resolve("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unparseable_filename");
  });

  it("garbage filename -> not ok (no throw)", () => {
    const r = resolver.resolve("...png");
    expect(r.ok).toBe(false);
  });
});
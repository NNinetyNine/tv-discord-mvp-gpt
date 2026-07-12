import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildRegistry, RegistryError, loadRegistry } from "./registry.ts";
// Tests inject their own fixtures — they do NOT depend on definitions/registry.json.
const channels = { crypto: "", stocks: "", indices: "" };
const good = {
  btc:  { tradingView: "BTCUSD", display: "Bitcoin",  channel: "crypto" },
  eth:  { tradingView: "ETHUSD", display: "Ethereum", channel: "crypto" },
  aapl: { tradingView: "AAPL",   display: "Apple",    channel: "stocks" },
  spx:  { tradingView: "SPX",    display: "S&P 500",  channel: "indices" },
};
describe("registry — reverse lookup", () => {
  it("looks up by TradingView symbol (case-insensitive)", () => {
    const reg = buildRegistry(good, channels);
    expect(reg.lookupByTradingView("BTCUSD")?.id).toBe("btc");
    expect(reg.lookupByTradingView("btcusd")?.id).toBe("btc");
    expect(reg.lookupByTradingView("AAPL")?.display).toBe("Apple");
  });
  it("returns null for an unknown symbol", () => {
    const reg = buildRegistry(good, channels);
    expect(reg.lookupByTradingView("DOGEUSD")).toBeNull();
  });
  it("exposes all assets", () => {
    const reg = buildRegistry(good, channels);
    expect(reg.all().map((a) => a.id).sort()).toEqual(["aapl", "btc", "eth", "spx"]);
  });
});
describe("registry — validation (fails loudly)", () => {
  it("throws on duplicate TradingView symbols", () => {
    expect(() =>
      buildRegistry(
        {
          a: { tradingView: "AAPL", display: "A", channel: "stocks" },
          b: { tradingView: "AAPL", display: "B", channel: "stocks" },
        },
        channels,
      ),
    ).toThrow(RegistryError);
  });
  it("throws on a channel not present in channels config", () => {
    expect(() =>
      buildRegistry(
        { a: { tradingView: "AAPL", display: "A", channel: "nope" } },
        channels,
      ),
    ).toThrow(/channel "nope" not found/);
  });
  it("throws on a malformed entry (missing display)", () => {
    expect(() =>
      buildRegistry(
        { a: { tradingView: "AAPL", channel: "stocks" } },
        channels,
      ),
    ).toThrow(RegistryError);
  });
  it("throws on a malformed entry (missing tradingView)", () => {
    expect(() =>
      buildRegistry(
        { a: { display: "A", channel: "stocks" } },
        channels,
      ),
    ).toThrow(/tradingView/);
  });
  it("throws on an empty registry", () => {
    expect(() => buildRegistry({}, channels)).toThrow(/empty/);
  });
});
describe("registry — real config loads and validates", () => {
  it("loads definitions/registry.json without throwing", () => {
    const reg = loadRegistry(
      resolve(process.cwd(), "definitions", "registry.json"),
      resolve(process.cwd(), "config", "channels.json"),
    );
    expect(reg.all().length).toBeGreaterThan(0);
  });
});
describe("registry — tradingViewAliases", () => {
  it("resolves an asset by an alias as well as its canonical token", () => {
    const reg = buildRegistry(
      { btc: { tradingView: "BTC", display: "Bitcoin", channel: "crypto", tradingViewAliases: ["BTCUSD", "BTCUSDT"] } },
      channels,
    );
    expect(reg.lookupByTradingView("BTC")?.id).toBe("btc");
    expect(reg.lookupByTradingView("BTCUSD")?.id).toBe("btc");
    expect(reg.lookupByTradingView("btcusdt")?.id).toBe("btc"); // case-insensitive
  });
  it("preserves aliases on the Asset when present", () => {
    const reg = buildRegistry(
      { btc: { tradingView: "BTC", display: "Bitcoin", channel: "crypto", tradingViewAliases: ["BTCUSD"] } },
      channels,
    );
    expect(reg.lookupByTradingView("BTC")?.tradingViewAliases).toEqual(["BTCUSD"]);
  });
  it("omits tradingViewAliases for assets without them (existing assets unaffected)", () => {
    const reg = buildRegistry(
      { aapl: { tradingView: "AAPL", display: "Apple", channel: "stocks" } },
      channels,
    );
    expect("tradingViewAliases" in (reg.lookupByTradingView("AAPL") as object)).toBe(false);
  });
});
describe("registry — tradingViewAliases validation (fails loudly)", () => {
  it("rejects an alias colliding with another asset's canonical token", () => {
    expect(() =>
      buildRegistry(
        {
          btc:   { tradingView: "BTC", display: "Bitcoin", channel: "crypto" },
          other: { tradingView: "XYZ", display: "Other", channel: "crypto", tradingViewAliases: ["BTC"] },
        },
        channels,
      ),
    ).toThrow(RegistryError);
  });
  it("rejects the same alias claimed by two different assets", () => {
    expect(() =>
      buildRegistry(
        {
          a: { tradingView: "AAA", display: "A", channel: "crypto", tradingViewAliases: ["SHARED"] },
          b: { tradingView: "BBB", display: "B", channel: "crypto", tradingViewAliases: ["SHARED"] },
        },
        channels,
      ),
    ).toThrow(/duplicate TradingView symbol "SHARED"/);
  });
  it("rejects a duplicate alias within a single asset", () => {
    expect(() =>
      buildRegistry(
        { btc: { tradingView: "BTC", display: "Bitcoin", channel: "crypto", tradingViewAliases: ["BTCUSD", "BTCUSD"] } },
        channels,
      ),
    ).toThrow(/duplicate TradingView symbol "BTCUSD"/);
  });
  it("rejects a self-alias equal to the asset's own canonical token", () => {
    expect(() =>
      buildRegistry(
        { btc: { tradingView: "BTC", display: "Bitcoin", channel: "crypto", tradingViewAliases: ["BTC"] } },
        channels,
      ),
    ).toThrow(RegistryError);
  });
  it("rejects an alias colliding case-insensitively", () => {
    expect(() =>
      buildRegistry(
        {
          btc:   { tradingView: "BTC", display: "Bitcoin", channel: "crypto" },
          other: { tradingView: "XYZ", display: "Other", channel: "crypto", tradingViewAliases: ["btc"] },
        },
        channels,
      ),
    ).toThrow(RegistryError);
  });
  it("rejects a non-array tradingViewAliases", () => {
    expect(() =>
      buildRegistry(
        { btc: { tradingView: "BTC", display: "Bitcoin", channel: "crypto", tradingViewAliases: "BTCUSD" as unknown as string[] } },
        channels,
      ),
    ).toThrow(/tradingViewAliases must be an array/);
  });
  it("rejects a non-empty-string alias entry", () => {
    expect(() =>
      buildRegistry(
        { btc: { tradingView: "BTC", display: "Bitcoin", channel: "crypto", tradingViewAliases: ["BTCUSD", ""] } },
        channels,
      ),
    ).toThrow(/tradingViewAliases must contain only non-empty strings/);
  });
});
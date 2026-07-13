import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildRegistry, RegistryError, loadRegistry, createAsset } from "./registry.ts";
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
describe("createAsset — registry-owned persistence (§5.1 Create Asset)", () => {
  let dir: string;
  let registryPath: string;
  let channelsPath: string;

  // A small real-shaped registry with BOTH field orderings present, plus an
  // alias-bearing entry, so byte-preservation is exercised against variety.
  const INITIAL_REGISTRY =
    "{\n" +
    '  "btc":  { "tradingView": "BTC",  "tradingViewAliases": ["BTCUSD"], "display": "Bitcoin", "channel": "crypto" },\n' +
    '  "aapl": { "tradingView": "AAPL", "display": "Apple", "channel": "stocks" }\n' +
    "}";
  const CHANNELS = JSON.stringify({ crypto: "111", stocks: "", indices: "" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-createasset-"));
    registryPath = join(dir, "registry.json");
    channelsPath = join(dir, "channels.json");
    writeFileSync(registryPath, INITIAL_REGISTRY);
    writeFileSync(channelsPath, CHANNELS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a valid new asset (readable back through loadRegistry)", () => {
    const created = createAsset(registryPath, channelsPath, {
      id: "eth",
      tradingView: "ETH",
      display: "Ethereum",
      channel: "crypto",
    });
    expect(created.id).toBe("eth");

    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.all().map((a) => a.id).sort()).toEqual(["aapl", "btc", "eth"]);
    expect(reg.lookupByTradingView("ETH")?.id).toBe("eth");
  });

  it("preserves every existing byte and appends within the same object", () => {
    const before = readFileSync(registryPath, "utf8");
    createAsset(registryPath, channelsPath, {
      id: "eth",
      tradingView: "ETH",
      display: "Ethereum",
      channel: "crypto",
    });
    const after = readFileSync(registryPath, "utf8");
    // The entire prior body (minus its closing brace) is retained verbatim.
    const priorBody = before.replace(/\s+$/u, "").slice(0, -1).replace(/\s+$/u, "");
    expect(after.startsWith(priorBody)).toBe(true);
    // Still one valid JSON object; existing entries are untouched in content.
    const parsed = JSON.parse(after);
    expect(parsed.btc).toEqual({ tradingView: "BTC", tradingViewAliases: ["BTCUSD"], display: "Bitcoin", channel: "crypto" });
    expect(parsed.aapl).toEqual({ tradingView: "AAPL", display: "Apple", channel: "stocks" });
  });

  it("persists aliases when supplied", () => {
    createAsset(registryPath, channelsPath, {
      id: "eth",
      tradingView: "ETH",
      display: "Ethereum",
      channel: "crypto",
      tradingViewAliases: ["ETHUSD", "ETHUSDT"],
    });
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.lookupByTradingView("ethusdt")?.id).toBe("eth");
    expect(reg.lookupByTradingView("ETH")?.tradingViewAliases).toEqual(["ETHUSD", "ETHUSDT"]);
  });

  it("refuses a duplicate id and leaves the file byte-for-byte unchanged", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() =>
      createAsset(registryPath, channelsPath, { id: "btc", tradingView: "XXX", display: "X", channel: "crypto" }),
    ).toThrow(/already exists/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses a duplicate TradingView symbol (whole-candidate validation) and writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() =>
      // collides case-insensitively with existing aapl -> AAPL
      createAsset(registryPath, channelsPath, { id: "aapl2", tradingView: "aapl", display: "Apple II", channel: "stocks" }),
    ).toThrow(/duplicate TradingView symbol/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses an alias colliding with an existing symbol and writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() =>
      createAsset(registryPath, channelsPath, {
        id: "eth",
        tradingView: "ETH",
        display: "Ethereum",
        channel: "crypto",
        tradingViewAliases: ["BTCUSD"], // already claimed by btc
      }),
    ).toThrow(RegistryError);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses an unknown channel and writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() =>
      createAsset(registryPath, channelsPath, { id: "spx", tradingView: "SPX", display: "S&P 500", channel: "nope" }),
    ).toThrow(/channel "nope" not found/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses a malformed field (blank display) and writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() =>
      createAsset(registryPath, channelsPath, { id: "spx", tradingView: "SPX", display: "  ", channel: "crypto" }),
    ).toThrow(/display/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("allows creation onto a channel with no provisioned ID (coherence, not provisioning)", () => {
    // "indices" exists as a name but has a blank id — a valid definition; the
    // asset persists, and publish provisioning is a separate concern.
    const created = createAsset(registryPath, channelsPath, {
      id: "spx",
      tradingView: "SPX",
      display: "S&P 500",
      channel: "indices",
    });
    expect(created.channel).toBe("indices");
    expect(loadRegistry(registryPath, channelsPath).lookupByTradingView("SPX")?.id).toBe("spx");
  });
});
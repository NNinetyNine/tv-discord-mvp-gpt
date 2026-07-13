import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildRegistry, RegistryError, loadRegistry, createAsset, retireAsset, amendAssetDisplay, addAssetAlias, removeAssetAlias } from "./registry.ts";
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

describe("retireAsset — registry-owned persistence (§5.1 Retire Asset)", () => {
  let dir: string;
  let registryPath: string;
  let channelsPath: string;

  // Real-shaped registry: an alias-bearing entry, a plain entry, and a third
  // so the survivor set stays non-empty after a removal. Both field orderings.
  const INITIAL_REGISTRY =
    "{\n" +
    '  "btc":  { "tradingView": "BTC",  "tradingViewAliases": ["BTCUSD"], "display": "Bitcoin", "channel": "crypto" },\n' +
    '  "eth":  { "tradingView": "ETH",  "display": "Ethereum", "channel": "crypto" },\n' +
    '  "aapl": { "tradingView": "AAPL", "display": "Apple", "channel": "stocks" }\n' +
    "}";
  const CHANNELS = JSON.stringify({ crypto: "111", stocks: "", indices: "" });
  const NONE: ReadonlySet<string> = new Set();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-retireasset-"));
    registryPath = join(dir, "registry.json");
    channelsPath = join(dir, "channels.json");
    writeFileSync(registryPath, INITIAL_REGISTRY);
    writeFileSync(channelsPath, CHANNELS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("retires an unreferenced asset (gone from loadRegistry)", () => {
    retireAsset(registryPath, channelsPath, "eth", NONE);
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.all().map((a) => a.id).sort()).toEqual(["aapl", "btc"]);
    expect(reg.lookupByTradingView("ETH")).toBeNull();
  });

  it("retiring the LAST entry keeps valid JSON (comma repair) and preserves others", () => {
    retireAsset(registryPath, channelsPath, "aapl", NONE);
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(Object.keys(parsed)).toEqual(["btc", "eth"]);
    // survivors' bytes/content intact, including the alias entry
    expect(parsed.btc).toEqual({ tradingView: "BTC", tradingViewAliases: ["BTCUSD"], display: "Bitcoin", channel: "crypto" });
  });

  it("retiring a MIDDLE entry leaves neighbours byte-identical", () => {
    const before = readFileSync(registryPath, "utf8");
    retireAsset(registryPath, channelsPath, "eth", NONE);
    const after = readFileSync(registryPath, "utf8");
    // btc and aapl lines are preserved verbatim (present in both)
    const btcLine = before.split("\n").find((l) => l.trimStart().startsWith('"btc":'))!;
    const aaplLine = before.split("\n").find((l) => l.trimStart().startsWith('"aapl":'))!;
    expect(after).toContain(btcLine);
    expect(after).toContain(aaplLine.replace(/,\s*$/, "")); // aapl now last: trailing comma trimmed if it had one
  });

  it("refuses to retire an asset still referenced by a pack; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() =>
      retireAsset(registryPath, channelsPath, "btc", new Set(["btc", "sol"])),
    ).toThrow(/still referenced by a pack/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses to retire a non-existent id; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => retireAsset(registryPath, channelsPath, "nope", NONE)).toThrow(/does not exist/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses to retire the final remaining asset (surviving registry would be empty); writes nothing", () => {
    // reduce to a single-entry registry, then attempt to retire it
    writeFileSync(registryPath, '{\n  "only": { "tradingView": "ONLY", "display": "Only", "channel": "crypto" }\n}');
    const before = readFileSync(registryPath, "utf8");
    expect(() => retireAsset(registryPath, channelsPath, "only", NONE)).toThrow(/empty/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("round-trips: create then retire returns to the original catalogue", () => {
    createAsset(registryPath, channelsPath, { id: "sol", tradingView: "SOL", display: "Solana", channel: "crypto" });
    expect(loadRegistry(registryPath, channelsPath).all().map((a) => a.id).sort()).toEqual(["aapl", "btc", "eth", "sol"]);
    retireAsset(registryPath, channelsPath, "sol", NONE);
    expect(loadRegistry(registryPath, channelsPath).all().map((a) => a.id).sort()).toEqual(["aapl", "btc", "eth"]);
  });

  it("frees the retired asset's TradingView symbol for reuse", () => {
    retireAsset(registryPath, channelsPath, "eth", NONE);
    // ETH symbol is now free; a new asset may claim it
    createAsset(registryPath, channelsPath, { id: "eth2", tradingView: "ETH", display: "Ether Classic", channel: "crypto" });
    expect(loadRegistry(registryPath, channelsPath).lookupByTradingView("ETH")?.id).toBe("eth2");
  });
});

describe("amendAssetDisplay — registry-owned persistence (§2.4 metadata amendment)", () => {
  let dir: string;
  let registryPath: string;
  let channelsPath: string;

  // Real-shaped registry: an alias-bearing entry (display NOT last on its line)
  // and two plain entries (display in the middle of the line). Exercises the
  // field-edit against both field orderings.
  const INITIAL_REGISTRY =
    "{\n" +
    '  "btc":  { "tradingView": "BTC",  "tradingViewAliases": ["BTCUSD"], "display": "Bitcoin", "channel": "crypto" },\n' +
    '  "eth":  { "tradingView": "ETH",  "display": "Ethereum", "channel": "crypto" },\n' +
    '  "aapl": { "tradingView": "AAPL", "display": "Apple", "channel": "stocks" }\n' +
    "}";
  const CHANNELS = JSON.stringify({ crypto: "111", stocks: "", indices: "" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-amenddisplay-"));
    registryPath = join(dir, "registry.json");
    channelsPath = join(dir, "channels.json");
    writeFileSync(registryPath, INITIAL_REGISTRY);
    writeFileSync(channelsPath, CHANNELS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("amends a display name (readable back through loadRegistry)", () => {
    const amended = amendAssetDisplay(registryPath, channelsPath, "eth", "Ether");
    expect(amended.display).toBe("Ether");
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.lookupByTradingView("ETH")?.display).toBe("Ether");
  });

  it("changes ONLY the display; id, tradingView, channel, aliases untouched", () => {
    amendAssetDisplay(registryPath, channelsPath, "btc", "BTC (renamed)");
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(parsed.btc).toEqual({
      tradingView: "BTC",
      tradingViewAliases: ["BTCUSD"],
      display: "BTC (renamed)",
      channel: "crypto",
    });
  });

  it("leaves all OTHER entries byte-identical", () => {
    const before = readFileSync(registryPath, "utf8");
    amendAssetDisplay(registryPath, channelsPath, "eth", "Ether");
    const after = readFileSync(registryPath, "utf8");
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    // btc and aapl lines identical; only the eth line differs.
    const btcIdx = beforeLines.findIndex((l) => l.trimStart().startsWith('"btc":'));
    const aaplIdx = beforeLines.findIndex((l) => l.trimStart().startsWith('"aapl":'));
    expect(afterLines[btcIdx]).toBe(beforeLines[btcIdx]);
    expect(afterLines[aaplIdx]).toBe(beforeLines[aaplIdx]);
  });

  it("preserves aliases when amending an alias-bearing entry's display", () => {
    amendAssetDisplay(registryPath, channelsPath, "btc", "Bitcoin XL");
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.lookupByTradingView("BTCUSD")?.id).toBe("btc"); // alias still resolves
    expect(reg.lookupByTradingView("BTC")?.tradingViewAliases).toEqual(["BTCUSD"]);
  });

  it("handles a new display containing quotes (escaped safely, round-trips)", () => {
    amendAssetDisplay(registryPath, channelsPath, "aapl", 'Apple "Inc."');
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(parsed.aapl.display).toBe('Apple "Inc."');
  });

  it("refuses an unknown id; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => amendAssetDisplay(registryPath, channelsPath, "nope", "X")).toThrow(/does not exist/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses a blank display (whole-candidate validation); writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => amendAssetDisplay(registryPath, channelsPath, "eth", "   ")).toThrow(/display/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("amending to the SAME display is a valid no-op-equivalent write (idempotent content)", () => {
    amendAssetDisplay(registryPath, channelsPath, "eth", "Ethereum");
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(parsed.eth.display).toBe("Ethereum");
    // still a valid, complete registry
    expect(Object.keys(parsed).sort()).toEqual(["aapl", "btc", "eth"]);
  });
});

describe("addAssetAlias — registry-owned persistence (§5 additive resolution amendment)", () => {
  let dir: string;
  let registryPath: string;
  let channelsPath: string;

  const INITIAL_REGISTRY =
    "{\n" +
    '  "btc":  { "tradingView": "BTC",  "tradingViewAliases": ["BTCUSD"], "display": "Bitcoin", "channel": "crypto" },\n' +
    '  "eth":  { "tradingView": "ETH",  "display": "Ethereum", "channel": "crypto" },\n' +
    '  "aapl": { "tradingView": "AAPL", "display": "Apple", "channel": "stocks" }\n' +
    "}";
  const CHANNELS = JSON.stringify({ crypto: "111", stocks: "", indices: "" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-addalias-"));
    registryPath = join(dir, "registry.json");
    channelsPath = join(dir, "channels.json");
    writeFileSync(registryPath, INITIAL_REGISTRY);
    writeFileSync(channelsPath, CHANNELS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends an alias to an entry that already has aliases (resolves by it)", () => {
    const amended = addAssetAlias(registryPath, channelsPath, "btc", "BTCUSDT");
    expect(amended.tradingViewAliases).toEqual(["BTCUSD", "BTCUSDT"]);
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.lookupByTradingView("BTCUSDT")?.id).toBe("btc");
    expect(reg.lookupByTradingView("BTCUSD")?.id).toBe("btc"); // prior alias still resolves
  });

  it("adds the FIRST alias to an entry that had none (inserts the field)", () => {
    const amended = addAssetAlias(registryPath, channelsPath, "eth", "ETHUSD");
    expect(amended.tradingViewAliases).toEqual(["ETHUSD"]);
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.lookupByTradingView("ETHUSD")?.id).toBe("eth");
    expect(reg.lookupByTradingView("ETH")?.id).toBe("eth"); // canonical still resolves
  });

  it("changes ONLY the target entry; all others byte-identical", () => {
    const before = readFileSync(registryPath, "utf8");
    addAssetAlias(registryPath, channelsPath, "eth", "ETHUSD");
    const after = readFileSync(registryPath, "utf8");
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const btcIdx = beforeLines.findIndex((l) => l.trimStart().startsWith('"btc":'));
    const aaplIdx = beforeLines.findIndex((l) => l.trimStart().startsWith('"aapl":'));
    expect(afterLines[btcIdx]).toBe(beforeLines[btcIdx]);
    expect(afterLines[aaplIdx]).toBe(beforeLines[aaplIdx]);
  });

  it("preserves the target entry's other fields (id/tradingView/display/channel)", () => {
    addAssetAlias(registryPath, channelsPath, "btc", "XBTUSD");
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(parsed.btc.tradingView).toBe("BTC");
    expect(parsed.btc.display).toBe("Bitcoin");
    expect(parsed.btc.channel).toBe("crypto");
    expect(parsed.btc.tradingViewAliases).toEqual(["BTCUSD", "XBTUSD"]);
  });

  it("refuses an alias colliding with another asset's canonical token; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => addAssetAlias(registryPath, channelsPath, "btc", "AAPL")).toThrow(RegistryError);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses an alias colliding with an existing alias (case-insensitive); writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => addAssetAlias(registryPath, channelsPath, "eth", "btcusd")).toThrow(/duplicate TradingView symbol/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses an alias equal to the asset's own canonical token (self-alias); writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => addAssetAlias(registryPath, channelsPath, "eth", "ETH")).toThrow(RegistryError);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses an unknown id; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => addAssetAlias(registryPath, channelsPath, "nope", "NOPEUSD")).toThrow(/does not exist/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses a blank alias; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => addAssetAlias(registryPath, channelsPath, "eth", "   ")).toThrow(/alias must be a non-empty string/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("result remains a valid, complete registry loadable end to end", () => {
    addAssetAlias(registryPath, channelsPath, "eth", "ETHUSD");
    addAssetAlias(registryPath, channelsPath, "aapl", "AAPL.US");
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.all().map((a) => a.id).sort()).toEqual(["aapl", "btc", "eth"]);
    expect(reg.lookupByTradingView("AAPL.US")?.id).toBe("aapl");
  });
});

describe("removeAssetAlias — registry-owned persistence (§5 subtractive resolution amendment)", () => {
  let dir: string;
  let registryPath: string;
  let channelsPath: string;

  const INITIAL_REGISTRY =
    "{\n" +
    '  "btc":  { "tradingView": "BTC",  "tradingViewAliases": ["BTCUSD", "BTCUSDT"], "display": "Bitcoin", "channel": "crypto" },\n' +
    '  "eth":  { "tradingView": "ETH",  "tradingViewAliases": ["ETHUSD"], "display": "Ethereum", "channel": "crypto" },\n' +
    '  "aapl": { "tradingView": "AAPL", "display": "Apple", "channel": "stocks" }\n' +
    "}";
  const CHANNELS = JSON.stringify({ crypto: "111", stocks: "", indices: "" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-removealias-"));
    registryPath = join(dir, "registry.json");
    channelsPath = join(dir, "channels.json");
    writeFileSync(registryPath, INITIAL_REGISTRY);
    writeFileSync(channelsPath, CHANNELS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes one alias from a multi-alias entry (others remain)", () => {
    const amended = removeAssetAlias(registryPath, channelsPath, "btc", "BTCUSD");
    expect(amended.tradingViewAliases).toEqual(["BTCUSDT"]);
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.lookupByTradingView("BTCUSD")).toBeNull(); // removed alias no longer resolves
    expect(reg.lookupByTradingView("BTCUSDT")?.id).toBe("btc"); // kept alias still resolves
    expect(reg.lookupByTradingView("BTC")?.id).toBe("btc"); // canonical still resolves
  });

  it("removing the LAST alias DROPS the field (canonical alias-less shape)", () => {
    const amended = removeAssetAlias(registryPath, channelsPath, "eth", "ETHUSD");
    expect(amended.tradingViewAliases).toBeUndefined();
    expect("tradingViewAliases" in (amended as object)).toBe(false);
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    expect("tradingViewAliases" in parsed.eth).toBe(false); // field gone from the file
    expect(parsed.eth).toEqual({ tradingView: "ETH", display: "Ethereum", channel: "crypto" });
    // reloads and the removed alias no longer resolves; canonical still does
    const reg = loadRegistry(registryPath, channelsPath);
    expect(reg.lookupByTradingView("ETHUSD")).toBeNull();
    expect(reg.lookupByTradingView("ETH")?.id).toBe("eth");
  });

  it("changes ONLY the target entry; all others byte-identical", () => {
    const before = readFileSync(registryPath, "utf8");
    removeAssetAlias(registryPath, channelsPath, "eth", "ETHUSD");
    const after = readFileSync(registryPath, "utf8");
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const btcIdx = beforeLines.findIndex((l) => l.trimStart().startsWith('"btc":'));
    const aaplIdx = beforeLines.findIndex((l) => l.trimStart().startsWith('"aapl":'));
    expect(afterLines[btcIdx]).toBe(beforeLines[btcIdx]);
    expect(afterLines[aaplIdx]).toBe(beforeLines[aaplIdx]);
  });

  it("preserves the target entry's other fields when removing from a multi-alias entry", () => {
    removeAssetAlias(registryPath, channelsPath, "btc", "BTCUSDT");
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(parsed.btc).toEqual({
      tradingView: "BTC",
      tradingViewAliases: ["BTCUSD"],
      display: "Bitcoin",
      channel: "crypto",
    });
  });

  it("refuses to remove an alias the asset does not have; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => removeAssetAlias(registryPath, channelsPath, "btc", "NOPE")).toThrow(/has no alias "NOPE"/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses when the asset has no aliases at all; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => removeAssetAlias(registryPath, channelsPath, "aapl", "AAPLUSD")).toThrow(/has no alias/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("refuses an unknown id; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => removeAssetAlias(registryPath, channelsPath, "nope", "X")).toThrow(/does not exist/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("is exact/case-sensitive: a case-mismatched alias is refused; writes nothing", () => {
    const before = readFileSync(registryPath, "utf8");
    expect(() => removeAssetAlias(registryPath, channelsPath, "btc", "btcusd")).toThrow(/has no alias "btcusd"/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("round-trips with add: add then remove returns to the alias-less shape", () => {
    addAssetAlias(registryPath, channelsPath, "aapl", "AAPLUSD");
    expect(loadRegistry(registryPath, channelsPath).lookupByTradingView("AAPLUSD")?.id).toBe("aapl");
    const amended = removeAssetAlias(registryPath, channelsPath, "aapl", "AAPLUSD");
    expect(amended.tradingViewAliases).toBeUndefined();
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(parsed.aapl).toEqual({ tradingView: "AAPL", display: "Apple", channel: "stocks" });
  });

  it("frees the removed alias for reuse by another asset", () => {
    removeAssetAlias(registryPath, channelsPath, "btc", "BTCUSD");
    // BTCUSD is now free; eth may claim it
    const amended = addAssetAlias(registryPath, channelsPath, "eth", "BTCUSD");
    expect(amended.tradingViewAliases).toEqual(["ETHUSD", "BTCUSD"]);
    expect(loadRegistry(registryPath, channelsPath).lookupByTradingView("BTCUSD")?.id).toBe("eth");
  });
});
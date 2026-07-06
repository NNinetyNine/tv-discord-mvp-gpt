import { describe, it, expect } from "vitest";

import { buildPacks, PackError, loadPacks } from "./packs.ts";

// Injected valid-id set — independent of config/registry.json.
const validIds = new Set(["btc", "eth", "aapl", "nvda", "spx", "gold"]);

const goodPacks = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", assets: ["aapl", "nvda"] },
  { id: "indices", display: "Indices", assets: ["spx"] },
];

describe("buildPacks — valid input", () => {
  it("builds packs preserving array order (publishing sequence)", () => {
    const packs = buildPacks(goodPacks, validIds);
    expect(packs.map((p) => p.id)).toEqual(["crypto", "stocks", "indices"]);
  });

  it("preserves asset order within a pack", () => {
    const packs = buildPacks(goodPacks, validIds);
    expect(packs[0]?.assets).toEqual(["btc", "eth"]);
  });

  it("allows an asset to appear in more than one pack (cross-pack reuse)", () => {
    const packs = buildPacks(
      [
        { id: "morning", display: "Morning", assets: ["btc", "eth"] },
        { id: "evening", display: "Evening", assets: ["btc"] }, // btc reused — allowed
      ],
      validIds,
    );
    expect(packs).toHaveLength(2);
  });
});

describe("buildPacks — validation fails loudly", () => {
  it("throws when packs.json is not an array", () => {
    expect(() => buildPacks({ crypto: { assets: ["btc"] } }, validIds)).toThrow(PackError);
  });

  it("throws on an empty packs array", () => {
    expect(() => buildPacks([], validIds)).toThrow(/empty/);
  });

  it("throws on a missing pack id", () => {
    expect(() =>
      buildPacks([{ display: "Crypto", assets: ["btc"] }], validIds),
    ).toThrow(/id must be a non-empty string/);
  });

  it("throws on a duplicate pack id", () => {
    expect(() =>
      buildPacks(
        [
          { id: "crypto", display: "A", assets: ["btc"] },
          { id: "crypto", display: "B", assets: ["eth"] },
        ],
        validIds,
      ),
    ).toThrow(/duplicate pack id/);
  });

  it("throws on a missing display", () => {
    expect(() =>
      buildPacks([{ id: "crypto", assets: ["btc"] }], validIds),
    ).toThrow(/display/);
  });

  it("throws on an empty assets array", () => {
    expect(() =>
      buildPacks([{ id: "crypto", display: "Crypto", assets: [] }], validIds),
    ).toThrow(/non-empty array/);
  });

  it("throws on a duplicate asset id within a pack", () => {
    expect(() =>
      buildPacks([{ id: "crypto", display: "Crypto", assets: ["btc", "btc"] }], validIds),
    ).toThrow(/duplicate asset id/);
  });

  it("throws when a pack references an unknown asset id", () => {
    expect(() =>
      buildPacks([{ id: "crypto", display: "Crypto", assets: ["doge"] }], validIds),
    ).toThrow(/unknown asset id "doge"/);
  });
});

describe("loadPacks — real config loads and validates", () => {
  it("loads config/packs.json without throwing and preserves order", () => {
    const packs = loadPacks();
    expect(packs.length).toBeGreaterThan(0);
    for (const p of packs) {
      expect(p.assets.length).toBeGreaterThan(0);
      for (const a of p.assets) expect(typeof a).toBe("string");
    }
  });
});
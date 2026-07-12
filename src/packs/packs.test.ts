import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

import { buildPacks, PackError, loadPacks } from "./packs.ts";
import { loadRegistry } from "../registry/registry.ts";
import { loadChannels } from "../wiring/channels.ts";

// Injected valid-id set — independent of definitions/registry.json.
const validIds = new Set(["btc", "eth", "aapl", "nvda", "spx", "gold"]);

// Injected channel-NAME universe — independent of config/channels.json.
// "unwired" exists as a name but (conceptually) has no provisioned Discord ID:
// name membership is all buildPacks may check (definition coherence);
// provisioning is publish's concern.
const channelNames = new Set(["crypto", "stocks", "indices", "unwired"]);

const goodPacks = [
  { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", channel: "stocks", assets: ["aapl", "nvda"] },
  { id: "indices", display: "Indices", channel: "indices", assets: ["spx"] },
];

describe("buildPacks — valid input", () => {
  it("builds packs preserving array order (publishing sequence)", () => {
    const packs = buildPacks(goodPacks, validIds, channelNames);
    expect(packs.map((p) => p.id)).toEqual(["crypto", "stocks", "indices"]);
  });

  it("preserves asset order within a pack", () => {
    const packs = buildPacks(goodPacks, validIds, channelNames);
    expect(packs[0]?.assets).toEqual(["btc", "eth"]);
  });

  it("carries the Pack-owned channel assignment (a channel NAME)", () => {
    const packs = buildPacks(goodPacks, validIds, channelNames);
    expect(packs.map((p) => p.channel)).toEqual(["crypto", "stocks", "indices"]);
  });

  it("the assignment is NOT the pack id — any known channel name is assignable", () => {
    const packs = buildPacks(
      [{ id: "morning-run", display: "Morning Run", channel: "crypto", assets: ["btc"] }],
      validIds,
      channelNames,
    );
    expect(packs[0]?.channel).toBe("crypto");
  });

  it("a known channel name validates regardless of provisioning (coherence, not resolver success)", () => {
    // "unwired" is in the name universe; whether it has a Discord ID is
    // invisible here by design — the pack must load fine and fail closed
    // only at publish.
    const packs = buildPacks(
      [{ id: "crypto", display: "Crypto", channel: "unwired", assets: ["btc"] }],
      validIds,
      channelNames,
    );
    expect(packs[0]?.channel).toBe("unwired");
  });

  it("allows an asset to appear in more than one pack (cross-pack reuse)", () => {
    const packs = buildPacks(
      [
        { id: "morning", display: "Morning", channel: "crypto", assets: ["btc", "eth"] },
        { id: "evening", display: "Evening", channel: "crypto", assets: ["btc"] }, // btc reused — allowed
      ],
      validIds,
      channelNames,
    );
    expect(packs).toHaveLength(2);
  });
});

describe("buildPacks — validation fails loudly", () => {
  it("throws when packs.json is not an array", () => {
    expect(() => buildPacks({ crypto: { assets: ["btc"] } }, validIds, channelNames)).toThrow(PackError);
  });

  it("throws on an empty packs array", () => {
    expect(() => buildPacks([], validIds, channelNames)).toThrow(/empty/);
  });

  it("throws on a missing pack id", () => {
    expect(() =>
      buildPacks([{ display: "Crypto", channel: "crypto", assets: ["btc"] }], validIds, channelNames),
    ).toThrow(/id must be a non-empty string/);
  });

  it("throws on a duplicate pack id", () => {
    expect(() =>
      buildPacks(
        [
          { id: "crypto", display: "A", channel: "crypto", assets: ["btc"] },
          { id: "crypto", display: "B", channel: "crypto", assets: ["eth"] },
        ],
        validIds,
        channelNames,
      ),
    ).toThrow(/duplicate pack id/);
  });

  it("throws on a missing display", () => {
    expect(() =>
      buildPacks([{ id: "crypto", channel: "crypto", assets: ["btc"] }], validIds, channelNames),
    ).toThrow(/display/);
  });

  it("throws on a missing channel assignment", () => {
    expect(() =>
      buildPacks([{ id: "crypto", display: "Crypto", assets: ["btc"] }], validIds, channelNames),
    ).toThrow(/channel must be a non-empty string/);
  });

  it("throws on a channel name not present in the channels config", () => {
    expect(() =>
      buildPacks(
        [{ id: "crypto", display: "Crypto", channel: "nope", assets: ["btc"] }],
        validIds,
        channelNames,
      ),
    ).toThrow(/channel "nope" not found in channels config/);
  });

  it("throws on an empty assets array", () => {
    expect(() =>
      buildPacks([{ id: "crypto", display: "Crypto", channel: "crypto", assets: [] }], validIds, channelNames),
    ).toThrow(/non-empty array/);
  });

  it("throws on a duplicate asset id within a pack", () => {
    expect(() =>
      buildPacks(
        [{ id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "btc"] }],
        validIds,
        channelNames,
      ),
    ).toThrow(/duplicate asset id/);
  });

  it("throws when a pack references an unknown asset id", () => {
    expect(() =>
      buildPacks(
        [{ id: "crypto", display: "Crypto", channel: "crypto", assets: ["doge"] }],
        validIds,
        channelNames,
      ),
    ).toThrow(/unknown asset id "doge"/);
  });
});

describe("loadPacks — real config loads and validates", () => {
  it("loads definitions/packs.json without throwing and preserves order", () => {
    const registry = loadRegistry(
      resolve(process.cwd(), "definitions", "registry.json"),
      resolve(process.cwd(), "config", "channels.json"),
    );
    const realChannelNames = new Set(
      Object.keys(loadChannels(resolve(process.cwd(), "config", "channels.json"))),
    );
    const packs = loadPacks(
      resolve(process.cwd(), "definitions", "packs.json"),
      new Set(registry.all().map((a) => a.id)),
      realChannelNames,
    );
    expect(packs.length).toBeGreaterThan(0);
    for (const p of packs) {
      expect(p.channel.length).toBeGreaterThan(0);
      expect(realChannelNames.has(p.channel)).toBe(true);
      expect(p.assets.length).toBeGreaterThan(0);
      for (const a of p.assets) expect(typeof a).toBe("string");
    }
  });
});
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { buildPacks, PackError, loadPacks, createPack } from "./packs.ts";
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
describe("createPack — Pack-owned persistence (§5.3 Create Pack, with initial membership)", () => {
  let dir: string;
  let packsPath: string;

  const VALID_IDS: ReadonlySet<string> = new Set(["btc", "eth", "aapl", "nvda", "spx", "gold"]);
  const CHANNEL_NAMES: ReadonlySet<string> = new Set(["crypto", "stocks", "indices"]);

  const INITIAL_PACKS =
    "[\n" +
    '  {\n    "id": "crypto",\n    "display": "Crypto",\n    "channel": "crypto",\n    "assets": ["btc", "eth"]\n  },\n' +
    '  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl", "nvda"]\n  }\n' +
    "]";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-createpack-"));
    packsPath = join(dir, "packs.json");
    writeFileSync(packsPath, INITIAL_PACKS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a pack with its initial membership (readable back through loadPacks)", () => {
    const created = createPack(packsPath, VALID_IDS, CHANNEL_NAMES, {
      id: "indices",
      display: "Indices",
      channel: "indices",
      assets: ["spx", "gold"],
    });
    expect(created.id).toBe("indices");
    expect(created.assets).toEqual(["spx", "gold"]);

    const packs = loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES);
    expect(packs.map((p) => p.id)).toEqual(["crypto", "stocks", "indices"]); // appended in order
  });

  it("preserves every existing byte and appends within the same array", () => {
    const before = readFileSync(packsPath, "utf8");
    createPack(packsPath, VALID_IDS, CHANNEL_NAMES, {
      id: "indices",
      display: "Indices",
      channel: "indices",
      assets: ["spx"],
    });
    const after = readFileSync(packsPath, "utf8");
    const priorBody = before.replace(/\s+$/u, "").slice(0, -1).replace(/\s+$/u, "");
    expect(after.startsWith(priorBody)).toBe(true);
    const parsed = JSON.parse(after);
    expect(parsed[0]).toEqual({ id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] });
    expect(parsed[1]).toEqual({ id: "stocks", display: "Stocks", channel: "stocks", assets: ["aapl", "nvda"] });
  });

  it("preserves channel assignment and asset order", () => {
    createPack(packsPath, VALID_IDS, CHANNEL_NAMES, {
      id: "mix",
      display: "Mix",
      channel: "crypto",
      assets: ["eth", "btc"], // deliberate order
    });
    const parsed = JSON.parse(readFileSync(packsPath, "utf8"));
    expect(parsed[2]).toEqual({ id: "mix", display: "Mix", channel: "crypto", assets: ["eth", "btc"] });
  });

  it("refuses a duplicate pack id and leaves the file byte-for-byte unchanged", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() =>
      createPack(packsPath, VALID_IDS, CHANNEL_NAMES, { id: "crypto", display: "X", channel: "crypto", assets: ["btc"] }),
    ).toThrow(/already exists/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses an asset-less pack (ratified: initial membership required); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() =>
      createPack(packsPath, VALID_IDS, CHANNEL_NAMES, { id: "empty", display: "Empty", channel: "crypto", assets: [] }),
    ).toThrow(/non-empty array/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses an unknown channel; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() =>
      createPack(packsPath, VALID_IDS, CHANNEL_NAMES, { id: "nc", display: "NC", channel: "nope", assets: ["btc"] }),
    ).toThrow(/channel "nope" not found/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses an unknown asset id (whole-candidate validation); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() =>
      createPack(packsPath, VALID_IDS, CHANNEL_NAMES, { id: "u", display: "U", channel: "crypto", assets: ["doge"] }),
    ).toThrow(/unknown asset id "doge"/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses duplicate asset ids within the new pack; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() =>
      createPack(packsPath, VALID_IDS, CHANNEL_NAMES, { id: "d", display: "D", channel: "crypto", assets: ["btc", "btc"] }),
    ).toThrow(/duplicate asset id/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a blank pack id; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() =>
      createPack(packsPath, VALID_IDS, CHANNEL_NAMES, { id: "  ", display: "B", channel: "crypto", assets: ["btc"] }),
    ).toThrow(/pack id must be a non-empty string/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("allows an asset already used by another pack (cross-pack reuse)", () => {
    // btc is in "crypto"; a new pack may also include it.
    const created = createPack(packsPath, VALID_IDS, CHANNEL_NAMES, {
      id: "evening",
      display: "Evening",
      channel: "crypto",
      assets: ["btc"],
    });
    expect(created.assets).toEqual(["btc"]);
    expect(loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES)).toHaveLength(3);
  });
});
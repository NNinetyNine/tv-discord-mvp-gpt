import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { buildPacks, PackError, loadPacks, createPack, removePackAsset, renamePackDisplay, reassignPackChannel, reorderPacks, reorderPackAssets } from "./packs.ts";
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

describe("removePackAsset — Pack-owned persistence (§5.2 membership removal; pure definition persistence)", () => {
  let dir: string;
  let packsPath: string;

  const VALID_IDS: ReadonlySet<string> = new Set(["btc", "eth", "sol", "aapl", "nvda"]);
  const CHANNEL_NAMES: ReadonlySet<string> = new Set(["crypto", "stocks", "indices"]);

  const INITIAL_PACKS =
    "[\n" +
    '  {\n    "id": "crypto",\n    "display": "Crypto",\n    "channel": "crypto",\n    "assets": ["btc", "eth", "sol"]\n  },\n' +
    '  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl"]\n  }\n' +
    "]";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-removepackasset-"));
    packsPath = join(dir, "packs.json");
    writeFileSync(packsPath, INITIAL_PACKS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes an asset from a pack's membership (readable back, order preserved)", () => {
    const amended = removePackAsset(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "eth");
    expect(amended.assets).toEqual(["btc", "sol"]); // eth gone, order of survivors preserved
    const packs = loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES);
    expect(packs.find((p) => p.id === "crypto")?.assets).toEqual(["btc", "sol"]);
  });

  it("leaves OTHER packs byte-identical and preserves the target pack's other fields", () => {
    const before = readFileSync(packsPath, "utf8");
    removePackAsset(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "sol");
    const after = readFileSync(packsPath, "utf8");
    const parsed = JSON.parse(after);
    // stocks pack untouched
    expect(parsed[1]).toEqual({ id: "stocks", display: "Stocks", channel: "stocks", assets: ["aapl"] });
    // crypto pack: only assets changed
    expect(parsed[0]).toEqual({ id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] });
    // the stocks block's exact lines survive verbatim
    const stocksLine = before.split("\n").find((l) => l.includes('"id": "stocks"'))!;
    expect(after).toContain(stocksLine);
  });

  it("refuses to remove the LAST asset (asset-less pack invalid — buildPacks unchanged); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => removePackAsset(packsPath, VALID_IDS, CHANNEL_NAMES, "stocks", "aapl")).toThrow(/non-empty array/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses an unknown pack; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => removePackAsset(packsPath, VALID_IDS, CHANNEL_NAMES, "nope", "btc")).toThrow(/pack "nope" does not exist/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses removing an asset the pack does not contain; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => removePackAsset(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "aapl")).toThrow(/does not contain asset "aapl"/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("removing then via createPack round-trips membership (definition-level)", () => {
    removePackAsset(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "eth");
    expect(loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES).find((p) => p.id === "crypto")?.assets).toEqual(["btc", "sol"]);
    // remove another; still valid, still non-empty
    removePackAsset(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "sol");
    expect(loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES).find((p) => p.id === "crypto")?.assets).toEqual(["btc"]);
  });

  it("does not read or require workspace state (pure definition persistence)", () => {
    // The function signature takes only definition inputs — no session/workspace
    // path. This test documents that the Empty-only gate is NOT in the store:
    // removal succeeds here with no workspace present at all.
    const amended = removePackAsset(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "btc");
    expect(amended.assets).toEqual(["eth", "sol"]);
  });
});
describe("renamePackDisplay — Pack-owned persistence (§5.3 display rename; ungated)", () => {
  let dir: string;
  let packsPath: string;

  const VALID_IDS: ReadonlySet<string> = new Set(["btc", "eth", "sol", "aapl"]);
  const CHANNEL_NAMES: ReadonlySet<string> = new Set(["crypto", "stocks"]);

  const INITIAL_PACKS =
    "[\n" +
    '  {\n    "id": "crypto",\n    "display": "Crypto",\n    "channel": "crypto",\n    "assets": ["btc", "eth", "sol"]\n  },\n' +
    '  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl"]\n  }\n' +
    "]";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-renamepack-"));
    packsPath = join(dir, "packs.json");
    writeFileSync(packsPath, INITIAL_PACKS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames a pack's display (readable back through loadPacks)", () => {
    const amended = renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "Crypto Majors");
    expect(amended.display).toBe("Crypto Majors");
    const packs = loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES);
    expect(packs.find((p) => p.id === "crypto")?.display).toBe("Crypto Majors");
  });

  it("changes ONLY the display field of the target pack", () => {
    renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "Renamed");
    const parsed = JSON.parse(readFileSync(packsPath, "utf8"));
    expect(parsed[0]).toEqual({ id: "crypto", display: "Renamed", channel: "crypto", assets: ["btc", "eth", "sol"] });
  });

  it("leaves OTHER packs byte-identical", () => {
    const before = readFileSync(packsPath, "utf8");
    renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "Renamed");
    const after = readFileSync(packsPath, "utf8");
    const stocksBlock = before.substring(before.indexOf('{\n    "id": "stocks"'));
    expect(after).toContain(stocksBlock);
  });

  it("preserves this pack's other fields (id, channel, assets)", () => {
    renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "Renamed");
    const parsed = JSON.parse(readFileSync(packsPath, "utf8"));
    expect(parsed[0].id).toBe("crypto");
    expect(parsed[0].channel).toBe("crypto");
    expect(parsed[0].assets).toEqual(["btc", "eth", "sol"]);
  });

  it("handles a display containing quotes (escaped correctly)", () => {
    renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "stocks", 'Stocks "A-List"');
    const parsed = JSON.parse(readFileSync(packsPath, "utf8"));
    expect(parsed[1].display).toBe('Stocks "A-List"');
    expect(parsed[1].assets).toEqual(["aapl"]);
  });

  it("refuses an unknown pack; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "nope", "X")).toThrow(/pack "nope" does not exist/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a blank display (buildPacks non-empty rule, unchanged); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "   ")).toThrow(/display must be a non-empty string/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("rename then rename back is byte-identical to the original", () => {
    const before = readFileSync(packsPath, "utf8");
    renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "Temporarily Renamed");
    renamePackDisplay(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "Crypto");
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });
});

describe("reassignPackChannel — Pack-owned persistence (§5.3 channel reassignment; ungated)", () => {
  let dir: string;
  let packsPath: string;

  const VALID_IDS: ReadonlySet<string> = new Set(["btc", "eth", "sol", "aapl"]);
  const CHANNEL_NAMES: ReadonlySet<string> = new Set(["crypto", "stocks", "indices"]);

  const INITIAL_PACKS =
    "[\n" +
    '  {\n    "id": "crypto",\n    "display": "Crypto",\n    "channel": "crypto",\n    "assets": ["btc", "eth", "sol"]\n  },\n' +
    '  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl"]\n  }\n' +
    "]";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-reassignchannel-"));
    packsPath = join(dir, "packs.json");
    writeFileSync(packsPath, INITIAL_PACKS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reassigns a pack's channel (readable back through loadPacks)", () => {
    const amended = reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "indices");
    expect(amended.channel).toBe("indices");
    const packs = loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES);
    expect(packs.find((p) => p.id === "crypto")?.channel).toBe("indices");
  });

  it("changes ONLY the channel field of the target pack", () => {
    reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "indices");
    const parsed = JSON.parse(readFileSync(packsPath, "utf8"));
    expect(parsed[0]).toEqual({ id: "crypto", display: "Crypto", channel: "indices", assets: ["btc", "eth", "sol"] });
  });

  it("leaves OTHER packs byte-identical", () => {
    const before = readFileSync(packsPath, "utf8");
    reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "indices");
    const after = readFileSync(packsPath, "utf8");
    const stocksBlock = before.substring(before.indexOf('{\n    "id": "stocks"'));
    expect(after).toContain(stocksBlock);
  });

  it("preserves this pack's other fields (id, display, assets)", () => {
    reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "indices");
    const parsed = JSON.parse(readFileSync(packsPath, "utf8"));
    expect(parsed[0].id).toBe("crypto");
    expect(parsed[0].display).toBe("Crypto");
    expect(parsed[0].assets).toEqual(["btc", "eth", "sol"]);
  });

  it("refuses an unknown pack; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "nope", "crypto")).toThrow(/pack "nope" does not exist/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses an unknown channel name (buildPacks config check, unchanged); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "nonexistent")).toThrow(/channel "nonexistent" not found/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a blank channel (buildPacks non-empty rule, unchanged); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "   ")).toThrow(/channel/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("reassign then reassign back is byte-identical to the original", () => {
    const before = readFileSync(packsPath, "utf8");
    reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "indices");
    reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", "crypto");
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("allows reassigning to the channel a DIFFERENT pack already uses (channels are not unique)", () => {
    // stocks -> crypto's channel; both packs on 'crypto' channel is permitted
    const amended = reassignPackChannel(packsPath, VALID_IDS, CHANNEL_NAMES, "stocks", "crypto");
    expect(amended.channel).toBe("crypto");
    const packs = loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES);
    expect(packs.find((p) => p.id === "stocks")?.channel).toBe("crypto");
    expect(packs.find((p) => p.id === "crypto")?.channel).toBe("crypto");
  });
});

describe("reorderPacks — Pack-owned persistence (§5.3 Pack reordering; ungated, block permutation)", () => {
  let dir: string;
  let packsPath: string;

  const VALID_IDS: ReadonlySet<string> = new Set(["btc", "eth", "sol", "aapl", "spx"]);
  const CHANNEL_NAMES: ReadonlySet<string> = new Set(["crypto", "stocks", "indices"]);

  const INITIAL_PACKS =
    "[\n" +
    '  {\n    "id": "crypto",\n    "display": "Crypto",\n    "channel": "crypto",\n    "assets": ["btc", "eth", "sol"]\n  },\n' +
    '  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl"]\n  },\n' +
    '  {\n    "id": "indices",\n    "display": "Indices",\n    "channel": "indices",\n    "assets": ["spx"]\n  }\n' +
    "]";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-reorderpacks-"));
    packsPath = join(dir, "packs.json");
    writeFileSync(packsPath, INITIAL_PACKS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reorders the packs array (readable back through loadPacks)", () => {
    const packs = reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["stocks", "indices", "crypto"]);
    expect(packs.map((p) => p.id)).toEqual(["stocks", "indices", "crypto"]);
    const loaded = loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES);
    expect(loaded.map((p) => p.id)).toEqual(["stocks", "indices", "crypto"]);
  });

  it("changes ONLY order — every pack's fields, formatting, and asset order preserved", () => {
    reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["stocks", "indices", "crypto"]);
    const parsed = JSON.parse(readFileSync(packsPath, "utf8"));
    expect(parsed).toEqual([
      { id: "stocks", display: "Stocks", channel: "stocks", assets: ["aapl"] },
      { id: "indices", display: "Indices", channel: "indices", assets: ["spx"] },
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth", "sol"] },
    ]);
  });

  it("carries each block's exact bytes (crypto's multi-asset line survives verbatim)", () => {
    const before = readFileSync(packsPath, "utf8");
    const cryptoBlock = before.substring(before.indexOf('  {\n    "id": "crypto"'), before.indexOf('  },'));
    reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["stocks", "crypto", "indices"]);
    const after = readFileSync(packsPath, "utf8");
    // crypto's assets line, verbatim, still present
    expect(after).toContain('"assets": ["btc", "eth", "sol"]');
    expect(cryptoBlock.length).toBeGreaterThan(0);
  });

  it("refuses an unknown pack id; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["stocks", "nope", "crypto"])).toThrow(/unknown pack id "nope"/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a duplicate pack id; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["crypto", "crypto", "stocks"])).toThrow(/duplicate pack id "crypto"/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a wrong count (missing a pack); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["crypto", "stocks"])).toThrow(/every pack exactly once/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a no-op (order identical to current); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["crypto", "stocks", "indices"])).toThrow(/no-op/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("reorder then reorder back is byte-identical to the original", () => {
    const before = readFileSync(packsPath, "utf8");
    reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["indices", "stocks", "crypto"]);
    reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["crypto", "stocks", "indices"]);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("does not read or require workspace state (pure definition persistence)", () => {
    const packs = reorderPacks(packsPath, VALID_IDS, CHANNEL_NAMES, ["indices", "crypto", "stocks"]);
    expect(packs.map((p) => p.id)).toEqual(["indices", "crypto", "stocks"]);
  });
});

describe("reorderPackAssets — Pack-owned persistence (§5.2 asset reorder; pure definition persistence)", () => {
  let dir: string;
  let packsPath: string;

  const VALID_IDS: ReadonlySet<string> = new Set(["btc", "eth", "sol", "aapl"]);
  const CHANNEL_NAMES: ReadonlySet<string> = new Set(["crypto", "stocks"]);

  const INITIAL_PACKS =
    "[\n" +
    '  {\n    "id": "crypto",\n    "display": "Crypto",\n    "channel": "crypto",\n    "assets": ["btc", "eth", "sol"]\n  },\n' +
    '  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl"]\n  }\n' +
    "]";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-reorderassets-"));
    packsPath = join(dir, "packs.json");
    writeFileSync(packsPath, INITIAL_PACKS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reorders a pack's assets (readable back through loadPacks)", () => {
    const amended = reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["eth", "sol", "btc"]);
    expect(amended.assets).toEqual(["eth", "sol", "btc"]);
    const loaded = loadPacks(packsPath, VALID_IDS, CHANNEL_NAMES);
    expect(loaded.find((p) => p.id === "crypto")?.assets).toEqual(["eth", "sol", "btc"]);
  });

  it("changes ONLY order — membership set preserved, other fields intact", () => {
    reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["sol", "btc", "eth"]);
    const parsed = JSON.parse(readFileSync(packsPath, "utf8"));
    expect(parsed[0]).toEqual({ id: "crypto", display: "Crypto", channel: "crypto", assets: ["sol", "btc", "eth"] });
    // membership set unchanged
    expect(new Set(parsed[0].assets)).toEqual(new Set(["btc", "eth", "sol"]));
  });

  it("leaves OTHER packs byte-identical", () => {
    const before = readFileSync(packsPath, "utf8");
    reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["eth", "btc", "sol"]);
    const after = readFileSync(packsPath, "utf8");
    const stocksBlock = before.substring(before.indexOf('{\n    "id": "stocks"'));
    expect(after).toContain(stocksBlock);
  });

  it("refuses an unknown pack; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "nope", ["btc"])).toThrow(/pack "nope" does not exist/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses an asset not in the pack; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["btc", "eth", "aapl"])).toThrow(/not in pack "crypto"/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a duplicate asset id; writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["btc", "btc", "eth"])).toThrow(/duplicate asset id "btc"/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a wrong count (missing a member); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["btc", "eth"])).toThrow(/every asset in pack "crypto" exactly once/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("refuses a no-op (order identical to current); writes nothing", () => {
    const before = readFileSync(packsPath, "utf8");
    expect(() => reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["btc", "eth", "sol"])).toThrow(/no-op/);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("reorder then reorder back is byte-identical to the original", () => {
    const before = readFileSync(packsPath, "utf8");
    reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["sol", "eth", "btc"]);
    reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["btc", "eth", "sol"]);
    expect(readFileSync(packsPath, "utf8")).toBe(before);
  });

  it("does not read or require workspace state (pure definition persistence)", () => {
    // The Empty-only gate is NOT in the store: reorder succeeds here with no
    // workspace present at all.
    const amended = reorderPackAssets(packsPath, VALID_IDS, CHANNEL_NAMES, "crypto", ["eth", "sol", "btc"]);
    expect(amended.assets).toEqual(["eth", "sol", "btc"]);
  });
});
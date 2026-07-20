import { describe, expect, it } from "vitest";

import { prepareCreatePackWithMissingAssets } from "./create-pack-with-missing-assets.ts";

const CHANNELS = Buffer.from(`${JSON.stringify({ stocks: "1527846988270534827", forex: "1528609079822516305" }, null, 2)}\n`);
const REGISTRY = Buffer.from(
  '{\n  "aapl": { "tradingView": "NASDAQ:AAPL", "display": "Apple", "currency": "USD", "channel": "stocks" }\n}\n',
);
const REGISTRY_WITHOUT_CURRENCY = Buffer.from(
  '{\n  "aapl": { "tradingView": "NASDAQ:AAPL", "display": "Apple", "channel": "stocks" }\n}\n',
);
const PACKS = Buffer.from('[\n  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl"]\n  }\n]\n');

const forexMembers = [
  ["dxy", "U.S. Dollar Currency Index", "TVC:DXY"],
  ["exy", "Euro Currency Index", "TVC:EXY"],
  ["jxy", "Japanese Yen Currency Index", "TVC:JXY"],
  ["cxy", "Canadian Dollar Currency Index", "TVC:CXY"],
  ["sxy", "Swiss Franc Currency Index", "TVC:SXY"],
  ["bxy", "British Pound Currency Index", "TVC:BXY"],
  ["axy", "Australian Dollar Currency Index", "TVC:AXY"],
] as const;

function input(members: readonly unknown[] = forexMembers.map(([id, display, tradingView]) => ({ id, display, tradingView, currency: "USD" }))) {
  return { schemaVersion: 1, pack: { id: "forex", display: "Forex", channel: "forex" }, members };
}

function prepare(value: unknown, registryBytes = REGISTRY) {
  return prepareCreatePackWithMissingAssets({ value, registryBytes, packsBytes: PACKS, channelsBytes: CHANNELS });
}

describe("Create Pack with missing Assets", () => {
  it("constructs one deterministic future Registry and Pack for seven missing Assets", () => {
    const beforeRegistry = Buffer.from(REGISTRY);
    const beforePacks = Buffer.from(PACKS);
    const result = prepare(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preview.missingAssetCount).toBe(7);
    expect(result.value.preview.existingAssetCount).toBe(0);
    expect(result.value.preview.pack.assetIds).toEqual(forexMembers.map(([id]) => id));
    expect(result.value.preview.counts).toMatchObject({
      registryAssetsBefore: 1,
      registryAssetsAfter: 8,
      packsBefore: 1,
      packsAfter: 2,
      packMembershipsBefore: 1,
      packMembershipsAfter: 8,
    });
    expect(result.value.preview.members.map(({ id, market, symbol, currency, channel }) => ({ id, market, symbol, currency, channel }))).toEqual(
      forexMembers.map(([id, , token]) => ({ id, market: "TVC", symbol: token.split(":")[1], currency: "USD", channel: "forex" })),
    );
    const registryText = result.value.registryAfterBytes.toString("utf8");
    expect(registryText).toContain('"dxy": { "tradingView": "TVC:DXY", "display": "U.S. Dollar Currency Index", "currency": "USD", "channel": "forex" }');
    expect(registryText.indexOf('"dxy"')).toBeLessThan(registryText.indexOf('"axy"'));
    expect(JSON.parse(result.value.packsAfterBytes.toString("utf8")).at(-1)).toEqual({
      id: "forex", display: "Forex", channel: "forex", assets: forexMembers.map(([id]) => id),
    });
    expect(REGISTRY).toEqual(beforeRegistry);
    expect(PACKS).toEqual(beforePacks);
    expect(result.value.preview.publicationEffects).toEqual({ rendered: false, published: false, released: false, discordContacted: false });
  });

  it("reports only the canonical paths that actually change", () => {
    const existingOnly = prepare(input([{ id: "aapl" }]));
    expect(existingOnly.ok).toBe(true);
    if (!existingOnly.ok) return;
    expect(existingOnly.value.preview.changedPaths).toEqual(["definitions/packs.json"]);
    expect(existingOnly.value.registryAfterBytes).toEqual(REGISTRY);

    const withMissing = prepare(input([{ id: "dxy", display: "DXY", tradingView: "TVC:DXY", currency: "USD" }]));
    expect(withMissing.ok).toBe(true);
    if (withMissing.ok) expect(withMissing.value.preview.changedPaths).toEqual(["definitions/registry.json", "definitions/packs.json"]);
  });

  it("reuses only canonical metadata for existing Assets and rejects browser overrides", () => {
    const mixed = prepare(input([
      { id: "aapl" },
      { id: "dxy", display: "U.S. Dollar Currency Index", tradingView: "TVC:DXY", currency: "USD" },
    ]));
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.value.preview.members[0]).toMatchObject({
        id: "aapl", display: "Apple", tradingView: "NASDAQ:AAPL", currency: "USD", channel: "stocks", existing: true,
      });
      expect(mixed.value.preview.members[1]).toMatchObject({ id: "dxy", channel: "forex", existing: false });
    }
    expect(prepare(input([{ id: "aapl", currency: "EUR" }]))).toMatchObject({ ok: false, reason: "existing_asset_metadata_override" });
    expect(prepare(input([{ id: "aapl" }]), REGISTRY_WITHOUT_CURRENCY)).toMatchObject({
      ok: false, reason: "existing_asset_currency_missing", memberIndex: 0, field: "currency",
    });
  });

  it.each([undefined, "", " usd", "usd", "US-D", "ABCDEFGHI"])("requires strict explicit currency: %s", (currency) => {
    expect(prepare(input([{ id: "dxy", display: "DXY", tradingView: "TVC:DXY", ...(currency === undefined ? {} : { currency }) }]))).toMatchObject({
      ok: false,
      reason: currency === undefined || currency === "" ? "missing_currency" : "invalid_currency",
      field: "currency",
    });
  });

  it("rejects unknown fields and derives market, symbol, and Asset channel from canonical inputs", () => {
    expect(prepare({ ...input(), extra: true })).toMatchObject({ ok: false, reason: "unknown_field" });
    const result = prepare(input([{ id: "dxy", display: "DXY", tradingView: "TVC:DXY", currency: "USD" }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.preview.members[0]).toMatchObject({ market: "TVC", symbol: "DXY", channel: "forex" });
  });

  it("fails duplicate membership and combined token, alias, and display conflicts case-insensitively", () => {
    expect(prepare(input([{ id: "dxy", display: "DXY", tradingView: "TVC:DXY", currency: "USD" }, { id: "dxy", display: "DXY 2", tradingView: "TVC:DXY2", currency: "USD" }]))).toMatchObject({ ok: false, reason: "duplicate_member" });
    expect(prepare(input([{ id: "dxy", display: "DXY", tradingView: "nasdaq:aapl", currency: "USD" }]))).toMatchObject({ ok: false, reason: "invalid_tradingview" });
    expect(prepare(input([{ id: "dxy", display: "DXY", tradingView: "TVC:DXY", currency: "USD", tradingViewAliases: ["NASDAQ:AAPL"] }]))).toMatchObject({ ok: false, reason: "tradingview_conflict" });
    expect(prepare(input([
      { id: "dxy", display: "Shared Index", tradingView: "TVC:DXY", currency: "USD" },
      { id: "exy", display: "shared-index", tradingView: "TVC:EXY", currency: "USD" },
    ]))).toMatchObject({ ok: false, reason: "display_conflict" });
    expect(prepare(input([
      { id: "dxy", display: "DXY", tradingView: "TVC:DXY", currency: "USD", tradingViewAliases: ["TVC:SHARED"] },
      { id: "exy", display: "EXY", tradingView: "TVC:EXY", currency: "USD", tradingViewAliases: ["tvc:shared"] },
    ]))).toMatchObject({ ok: false, reason: "tradingview_conflict" });
  });

  it("is deterministic and binds currency-bearing future bytes into the preview identity", () => {
    const first = prepare(input());
    const second = prepare(input());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.preview).toEqual(second.value.preview);
    expect(first.value.registryAfterBytes).toEqual(second.value.registryAfterBytes);
    const changed = prepare(input([{ id: "dxy", display: "DXY", tradingView: "TVC:DXY", currency: "EUR" }]));
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.value.preview.sourceState.registryAfterSha256).not.toBe(first.value.preview.sourceState.registryAfterSha256);
  });
});

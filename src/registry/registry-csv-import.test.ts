import { describe, expect, it } from "vitest";

import { buildPacks } from "../packs/packs.ts";
import { buildRegistry } from "./registry.ts";
import { previewRegistryCsvImport } from "./registry-csv-import.ts";

const channels = { crypto: "1", stocks: "2" };
const rawRegistry = {
  btc: { tradingView: "CRYPTO:BTCUSD", display: "Bitcoin", currency: "USD", channel: "crypto" },
};
const rawPacks = [
  { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] },
  { id: "stocks", display: "Stocks", channel: "stocks", assets: ["btc"] },
];

function context(csvText: string) {
  const registry = buildRegistry(rawRegistry, channels);
  const packs = buildPacks(rawPacks, new Set(registry.all().map((asset) => asset.id)), new Set(Object.keys(channels)));
  return previewRegistryCsvImport({ csvText, rawRegistry, rawPacks, channels, assets: registry.all(), packs });
}

describe("Registry CSV import preview", () => {
  it("validates additions, aliases, and one optional Pack membership as one candidate", () => {
    const result = context([
      "id,display_name,tradingview_symbol,currency,channel,aliases,pack_ids",
      'aapl,"Apple, Inc.",NASDAQ:AAPL,USD,stocks,APPLE|APPLE_INC,stocks',
    ].join("\n"));

    expect(result.issues).toEqual([]);
    expect(result.rows).toEqual([expect.objectContaining({
      rowNumber: 2,
      id: "aapl",
      displayName: "Apple, Inc.",
      aliases: ["APPLE", "APPLE_INC"],
      packIds: ["stocks"],
    })]);
    expect(result.packMembershipCount).toBe(1);
    const registry = JSON.parse(result.registryAfterBytes!.toString("utf8")) as Record<string, unknown>;
    const packs = JSON.parse(result.packsAfterBytes!.toString("utf8")) as Array<{ id: string; assets: string[] }>;
    expect(registry.aapl).toEqual(expect.objectContaining({ tradingView: "NASDAQ:AAPL", display: "Apple, Inc." }));
    expect(packs.find((pack) => pack.id === "stocks")?.assets.at(-1)).toBe("aapl");
  });

  it("reports duplicate identifiers, existing display conflicts, unknown channels, and unknown Packs without candidates", () => {
    const result = context([
      "id,display_name,tradingview_symbol,currency,channel,aliases,pack_ids",
      "btc,Bitcoin,NASDAQ:BTC,USD,missing,,unknown",
      "btc,Other,NASDAQ:OTHER,USD,stocks,,",
    ].join("\n"));

    expect(result.registryAfterBytes).toBeNull();
    expect(result.packsAfterBytes).toBeNull();
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "asset_id_conflict",
      "display_conflict",
      "unknown_channel",
      "unknown_pack",
      "duplicate_import_id",
    ]));
  });


  it("reports invalid TradingView, currency, alias, and canonical filename-token collisions", () => {
    const invalid = context([
      "id,display_name,tradingview_symbol,currency,channel,aliases,pack_ids",
      "bad_asset,Bad Asset,UNQUALIFIED,US$,stocks,DUP|dup,",
    ].join("\n"));
    expect(invalid.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "invalid_tradingview_symbol",
      "invalid_currency",
      "duplicate_alias",
    ]));

    const collision = context([
      "id,display_name,tradingview_symbol,currency,channel,aliases,pack_ids",
      "eth,Example,NASDAQ:ETH,USD,stocks,BTCUSD,",
    ].join("\n"));
    expect(collision.issues).toContainEqual(expect.objectContaining({ code: "candidate_validation_failed" }));
    expect(collision.registryAfterBytes).toBeNull();
  });

  it("rejects multiple Pack memberships because current Workspace architecture is disjoint", () => {
    const result = context([
      "id,display_name,tradingview_symbol,currency,channel,pack_ids",
      "aapl,Apple,NASDAQ:AAPL,USD,stocks,stocks|crypto",
    ].join("\n"));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "multiple_pack_memberships_unsupported", rowNumber: 2 }));
  });

  it("rejects malformed headers and unterminated quoted fields", () => {
    expect(context("id,display_name\naapl,Apple").issues.map((entry) => entry.code)).toContain("missing_header");
    expect(context('id,display_name,tradingview_symbol,currency,channel\naapl,"Apple,NASDAQ:AAPL,USD,stocks').issues).toContainEqual(expect.objectContaining({ code: "invalid_csv" }));
  });
});

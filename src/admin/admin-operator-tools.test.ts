import { describe, expect, it } from "vitest";

import type { Asset } from "../types.ts";
import type { Pack } from "../packs/packs.ts";
import {
  buildAliasChangePreview,
  buildPackMaintenancePreview,
  parsePackMaintenanceInput,
} from "./admin-operator-tools.ts";

const assets: readonly Asset[] = Object.freeze([
  Object.freeze({ id: "btc", tradingView: "CRYPTO:BTCUSD", display: "Bitcoin", currency: "USD", channel: "crypto" }),
  Object.freeze({ id: "eth", tradingView: "CRYPTO:ETHUSD", tradingViewAliases: Object.freeze(["ETHUSD"]), display: "Ethereum", currency: "USD", channel: "crypto" }),
  Object.freeze({ id: "aapl", tradingView: "NASDAQ:AAPL", display: "Apple", currency: "USD", channel: "stocks" }),
]);
const packs: readonly Pack[] = Object.freeze([
  Object.freeze({ id: "crypto", display: "Crypto", channel: "crypto", assets: Object.freeze(["btc", "eth"]) }),
  Object.freeze({ id: "stocks", display: "Stocks", channel: "stocks", assets: Object.freeze(["aapl"]) }),
]);
const channels = new Set(["crypto", "stocks"]);

function update(overrides: Partial<{
  displayName: string;
  logicalChannel: string;
  assetIds: readonly string[];
  packOrder: readonly string[];
}> = {}) {
  return {
    operation: "update" as const,
    packId: "crypto",
    displayName: overrides.displayName ?? "Digital Assets",
    logicalChannel: overrides.logicalChannel ?? "crypto",
    assetIds: overrides.assetIds ?? ["eth", "btc"],
    packOrder: overrides.packOrder ?? ["stocks", "crypto"],
  };
}

describe("Administration hidden operator-tool governance", () => {
  it("parses only strict Pack maintenance inputs", () => {
    expect(parsePackMaintenanceInput(update())).toEqual(update());
    expect(() => parsePackMaintenanceInput({ ...update(), surprise: true })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(() => parsePackMaintenanceInput({ operation: "delete", packId: "../crypto" })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
  });

  it("reviews rename, member order, and Pack order together with exact current-source custody", () => {
    const preview = buildPackMaintenancePreview({
      value: update(),
      packs,
      assets,
      channelNames: channels,
      packsSha256: "a".repeat(64),
      workspaceState: "empty",
      capturedCount: 0,
      boundThreadCount: 0,
    });
    expect(preview).toMatchObject({
      operation: "update",
      packId: "crypto",
      ready: true,
      confirmation: "APPLY PACK CRYPTO",
      sourceState: { packsSha256: "a".repeat(64) },
    });
    expect(preview.changes.map((change) => change.field)).toEqual(["displayName", "assetOrder", "packOrder"]);
    expect(preview.candidatePacks.map((pack) => pack.id)).toEqual(["stocks", "crypto"]);
  });

  it("blocks membership edits over non-Empty Workspace state and route edits with thread bindings", () => {
    const membership = buildPackMaintenancePreview({
      value: update({ assetIds: ["btc"] }),
      packs,
      assets,
      channelNames: channels,
      packsSha256: "b".repeat(64),
      workspaceState: "building",
      capturedCount: 1,
      boundThreadCount: 0,
    });
    expect(membership.ready).toBe(false);
    expect(membership.blockers).toContainEqual(expect.objectContaining({ code: "pack_not_empty" }));

    const route = buildPackMaintenancePreview({
      value: update({ displayName: "Crypto", logicalChannel: "stocks", assetIds: ["btc", "eth"], packOrder: ["crypto", "stocks"] }),
      packs,
      assets,
      channelNames: channels,
      packsSha256: "c".repeat(64),
      workspaceState: "empty",
      capturedCount: 0,
      boundThreadCount: 2,
    });
    expect(route.ready).toBe(false);
    expect(route.blockers).toContainEqual(expect.objectContaining({ code: "thread_bindings_exist" }));
  });

  it("enforces the global Registry alias namespace and preserves exact stored casing on removal", () => {
    expect(() => buildAliasChangePreview({
      value: { assetId: "aapl", operation: "add", alias: "ETHUSD" },
      asset: assets[2]!,
      registrySha256: "d".repeat(64),
      allAssets: assets,
    })).toThrowError(expect.objectContaining({ code: "alias_conflict" }));

    const remove = buildAliasChangePreview({
      value: { assetId: "eth", operation: "remove", alias: "ethusd" },
      asset: assets[1]!,
      registrySha256: "e".repeat(64),
      allAssets: assets,
    });
    expect(remove).toMatchObject({
      operation: "remove",
      alias: "ETHUSD",
      aliasesAfter: [],
      confirmation: "APPLY ALIAS ETH",
    });
  });
});

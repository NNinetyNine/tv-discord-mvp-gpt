import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { AdminService } from "./admin-service.ts";
import { PACK_DRAFT_TYPE } from "./admin-types.ts";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function createService(repositoryRoot = resolve(".")) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-service-test-"));
  cleanup.push(workspaceRoot);
  return AdminService.create({ repositoryRoot, workspaceRoot });
}

async function mutableRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visionx-admin-registry-source-"));
  cleanup.push(root);
  await Promise.all([
    cp(resolve("definitions"), join(root, "definitions"), { recursive: true }),
    cp(resolve("config"), join(root, "config"), { recursive: true }),
    mkdir(join(root, "assets"), { recursive: true }),
  ]);
  return root;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

describe("AdminService", () => {
  it("loads exact canonical counts and fingerprint", async () => {
    const service = await createService();
    expect(service.status()).toMatchObject({
      canonicalState: "controlled_write",
      canonicalStateReadOnly: false,
      registryAssetCount: 131,
      packCount: 5,
      packMembershipCount: 131,
      registryFingerprint: "4838e483af6e28c2b9b1d5e64c883e1d8f0252aabc263fe091c047c7525e8294",
      auditGapCount: 228,
    });
  });

  it("reports exact canonical source hashes", async () => {
    const service = await createService();
    expect(service.status()).toMatchObject({
      registrySourceSha256: "1fd070bea3d0e99942046694d174cf4d330834019ae829a20d7eb209b7e88d5a",
      packSourceSha256: "29a8284033f1c67466f7a50b54a64d208e72e8dcce25e1cd897a650bdbc3c0b4",
      channelConfigurationSha256: "11bda2d95b9a93497c673f400bd78fd0215df18a02b2915089e397c13e5b0aad",
    });
  });

  it.each([
    ["aapl", "aapl"],
    ["Apple", "aapl"],
    ["AAPL", "aapl"],
    ["stocks", "aapl"],
  ])("searches Assets by %s", async (query, expectedId) => {
    const result = (await createService()).searchAssets({ query, limit: 100 });
    expect(result.assets.some((asset) => asset.id === expectedId)).toBe(true);
  });

  it("matches every Registry search token across canonical identity, currency, channel, and Pack context", async () => {
    const service = await createService();
    expect(service.searchAssets({ query: "Apple stocks", limit: 100 }).assets.map((asset) => asset.id)).toContain("aapl");
    expect(service.searchAssets({ query: "Bitcoin crypto", limit: 100 }).assets.map((asset) => asset.id)).toContain("btc");
    expect(service.searchAssets({ query: "Apple crypto", limit: 100 }).assets).toEqual([]);
  });

  it("filters Registry search by exact current Pack while preserving text search", async () => {
    const service = await createService();
    const stocks = service.searchAssets({ packId: "stocks", query: "Apple", limit: 100 });
    expect(stocks.packId).toBe("stocks");
    expect(stocks.assets.map((asset) => asset.id)).toEqual(["aapl"]);
    expect(service.searchAssets({ packId: "crypto", query: "Apple", limit: 100 }).assets).toEqual([]);
    expect(() => service.searchAssets({ packId: "missing" })).toThrowError(expect.objectContaining({ code: "pack_not_found" }));
  });

  it("paginates one deterministic Registry search without overlapping Assets", async () => {
    const service = await createService();
    const first = service.searchAssets({ query: "stocks", offset: 0, limit: 3 });
    const second = service.searchAssets({ query: "stocks", offset: 3, limit: 3 });
    expect(first.total).toBeGreaterThan(3);
    expect(new Set([...first.assets, ...second.assets].map((asset) => asset.id)).size).toBe(6);
    expect(first.assets.map((asset) => asset.id)).toEqual([...first.assets.map((asset) => asset.id)].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("returns Assets in stable id order", async () => {
    const ids = (await createService()).searchAssets({ limit: 100 }).assets.map((asset) => asset.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("keeps every Registry Asset discoverable while identifying exact standalone-render reconciliation blockers", async () => {
    const options = (await createService()).standaloneRenderOptions();
    expect(options.timeframes).toEqual(expect.arrayContaining(["1H", "1D", "4D", "1W"]));
    expect(options.assets).toContainEqual({
      id: "btc",
      displayName: "Bitcoin / U.S. Dollar",
      tradingViewSymbol: "CRYPTO:BTCUSD",
      logicalChannel: "crypto",
      currency: "USD",
      renderReady: true,
      reconciliationIssues: [],
    });
    expect(options.assets).toContainEqual({
      id: "aapl",
      displayName: "Apple",
      tradingViewSymbol: "NASDAQ:AAPL",
      logicalChannel: "stocks",
      currency: "USD",
      renderReady: true,
      reconciliationIssues: [],
    });
    expect(options.assets).toHaveLength(131);
    expect(options.renderableAssetCount).toBe(17);
    expect(options.reconciliationRequiredCount).toBe(114);
    expect(options.unavailableAssetCount).toBe(options.reconciliationRequiredCount);
    expect(options.assets.filter((asset) => asset.renderReady)).toHaveLength(options.renderableAssetCount);
  });

  it("enforces bounded Asset search results", async () => {
    const service = await createService();
    expect(service.searchAssets({ limit: 2 }).assets).toHaveLength(2);
    expect(() => service.searchAssets({ limit: 101 })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
  });

  it("returns Pack membership for selected Assets", async () => {
    expect((await createService()).getAsset("aapl").packIds).toEqual(["stocks"]);
  });

  it("returns typed unknown Asset failure", async () => {
    const service = await createService();
    expect(() => service.getAsset("missing")).toThrowError(expect.objectContaining({ code: "asset_not_found", status: 404 }));
  });

  it("prepares and applies governed Registry add and metadata updates without changing Pack membership", async () => {
    const root = await mutableRepository();
    const service = await createService(root);
    const added = await service.prepareRegistryAssetChange({
      operation: "add",
      asset: {
        id: "qa_asset",
        displayName: "QA Asset",
        tradingViewSymbol: "NASDAQ:QA",
        currency: "USD",
        channel: "stocks",
      },
    });
    expect(added).toMatchObject({
      operation: "add",
      asset: { id: "qa_asset", displayName: "QA Asset", packIds: [] },
      effects: { registryChanged: true, packMembershipChanged: false, logoChanged: false, discordContacted: false },
    });
    await service.applyPreparedRegistryAssetChange(added.changeId, "APPLY REGISTRY ASSET CHANGE");
    expect(service.getAsset("qa_asset")).toMatchObject({
      tradingViewSymbol: "NASDAQ:QA",
      currency: "USD",
      logicalChannel: "stocks",
      packIds: [],
    });

    const updated = await service.prepareRegistryAssetChange({
      operation: "update",
      asset: {
        id: "qa_asset",
        displayName: "QA Asset Renamed",
        tradingViewSymbol: "NYSE:QA",
        currency: "CAD",
        channel: "crypto",
      },
    });
    await service.applyPreparedRegistryAssetChange(updated.changeId, "APPLY REGISTRY ASSET CHANGE");
    expect(service.getAsset("qa_asset")).toMatchObject({
      displayName: "QA Asset Renamed",
      tradingViewSymbol: "NYSE:QA",
      currency: "CAD",
      logicalChannel: "crypto",
      packIds: [],
    });
  });

  it("previews and atomically applies a valid Registry CSV import with optional Pack membership", async () => {
    const root = await mutableRepository();
    const service = await createService(root);
    const preview = service.prepareRegistryCsvImport({
      fileName: "assets.csv",
      csvText: [
        "id,display_name,tradingview_symbol,currency,channel,pack_ids",
        "qa_csv,QA CSV Asset,NASDAQ:QACSV,USD,stocks,stocks",
      ].join("\n"),
    });
    expect(preview).toMatchObject({
      valid: true,
      additionCount: 1,
      packMembershipCount: 1,
      effects: { registryChanged: true, packMembershipChanged: true, discordContacted: false },
    });
    const applied = await service.applyRegistryCsvImport(preview.previewId, "APPLY REGISTRY CSV IMPORT");
    expect(applied).toMatchObject({ importedAssetCount: 1, packMembershipCount: 1 });
    expect(service.getAsset("qa_csv")).toMatchObject({
      displayName: "QA CSV Asset",
      packIds: ["stocks"],
    });
  });


  it("serializes canonical CSV source application and rejects a second stale preview", async () => {
    const root = await mutableRepository();
    const service = await createService(root);
    const first = service.prepareRegistryCsvImport({
      fileName: "first.csv",
      csvText: "id,display_name,tradingview_symbol,currency,channel\ncsv_first,CSV First,NASDAQ:CSVFIRST,USD,stocks",
    });
    const second = service.prepareRegistryCsvImport({
      fileName: "second.csv",
      csvText: "id,display_name,tradingview_symbol,currency,channel\ncsv_second,CSV Second,NASDAQ:CSVSECOND,USD,stocks",
    });

    const [firstResult, secondResult] = await Promise.allSettled([
      service.applyRegistryCsvImport(first.previewId, "APPLY REGISTRY CSV IMPORT"),
      service.applyRegistryCsvImport(second.previewId, "APPLY REGISTRY CSV IMPORT"),
    ]);
    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult).toMatchObject({ status: "rejected", reason: { code: "stale_registry_state" } });
    expect(service.getAsset("csv_first")).toMatchObject({ displayName: "CSV First" });
    expect(() => service.getAsset("csv_second")).toThrowError(expect.objectContaining({ code: "asset_not_found" }));
  });

  it("returns a reviewable invalid CSV preview and refuses unknown preview application", async () => {
    const service = await createService();
    const preview = service.prepareRegistryCsvImport({
      fileName: "invalid.csv",
      csvText: "id,display_name,tradingview_symbol,currency,channel,pack_ids\naapl,Apple,NASDAQ:AAPL,USD,missing,unknown",
    });
    expect(preview.valid).toBe(false);
    expect(preview.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["asset_id_conflict", "unknown_channel", "unknown_pack"]));
    await expect(service.applyRegistryCsvImport(preview.previewId, "APPLY REGISTRY CSV IMPORT")).rejects.toMatchObject({ code: "registry_csv_import_not_found" });
  });

  it("stores canonical Registry logos with exact-current hash protection", async () => {
    const root = await mutableRepository();
    const service = await createService(root);
    const bytes = await sharp({
      create: { width: 96, height: 96, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
    }).png().toBuffer();
    const competingBytes = await sharp({
      create: { width: 96, height: 96, channels: 4, background: { r: 60, g: 40, b: 20, alpha: 1 } },
    }).png().toBuffer();
    expect(await service.inspectRegistryAssetLogo("btc")).toMatchObject({ exists: false });
    const competing = await Promise.allSettled([
      service.storeRegistryAssetLogo("btc", bytes, null, "STORE REGISTRY ASSET LOGO"),
      service.storeRegistryAssetLogo("btc", competingBytes, null, "STORE REGISTRY ASSET LOGO"),
    ]);
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(competing.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "stale_asset_state" } });
    const status = await service.inspectRegistryAssetLogo("btc") as any;
    expect(status).toMatchObject({ exists: true, evidence: { width: 96, height: 96 } });
    await service.removeRegistryAssetLogo("btc", status.evidence.sha256, "REMOVE REGISTRY ASSET LOGO");
    expect(await service.inspectRegistryAssetLogo("btc")).toMatchObject({ exists: false });
  });

  it("blocks retirement while Pack or Thread ownership remains and retires an unowned Asset from a current preview", async () => {
    const root = await mutableRepository();
    const service = await createService(root);
    const blocked = await service.previewRegistryAssetRetirement("btc");
    expect(blocked.blockingPackIds).toContain("crypto");
    await expect(service.retireRegistryAsset("btc", blocked.previewId, "RETIRE BTC")).rejects.toMatchObject({ code: "stale_asset_state" });

    const added = await service.prepareRegistryAssetChange({
      operation: "add",
      asset: { id: "retire_me", displayName: "Retire Me", tradingViewSymbol: "NASDAQ:RETIRE", currency: "USD", channel: "stocks" },
    });
    await service.applyPreparedRegistryAssetChange(added.changeId, "APPLY REGISTRY ASSET CHANGE");
    const preview = await service.previewRegistryAssetRetirement("retire_me");
    expect(preview).toMatchObject({ blockingPackIds: [], blockingThreadRoutes: [] });
    await service.retireRegistryAsset("retire_me", preview.previewId, "RETIRE RETIRE_ME");
    expect(() => service.getAsset("retire_me")).toThrowError(expect.objectContaining({ code: "asset_not_found" }));
  });

  it("preserves exact canonical Pack order", async () => {
    const service = await createService();
    expect(service.listPacks().map((pack) => pack.id)).toEqual(["crypto", "stocks", "indices", "commodities", "etfs"]);
    expect(service.getPack("crypto").assets.slice(0, 4).map((asset) => asset.id)).toEqual(["akt", "zec", "pepe", "doge"]);
  });

  it("returns typed unknown Pack failure", async () => {
    const service = await createService();
    expect(() => service.getPack("missing")).toThrowError(expect.objectContaining({ code: "pack_not_found", status: 404 }));
  });

  it("creates, updates, validates, exports, and deletes a draft", async () => {
    const service = await createService();
    const created = await service.createDraft({
      schemaVersion: 1,
      draftType: PACK_DRAFT_TYPE,
      id: "qa-pack",
      displayName: "QA Pack",
      description: "Service verification.",
      assetIds: ["aapl", "btc", "gold"],
      revision: 1,
    });
    expect(created.validation.valid).toBe(true);
    const updated = await service.updateDraft("qa-pack", 1, { ...created.draft, assetIds: ["gold", "aapl", "btc"] });
    expect(updated.draft).toMatchObject({ revision: 2, assetIds: ["gold", "aapl", "btc"] });
    expect((await service.validateDraft("qa-pack")).valid).toBe(true);
    expect(JSON.parse((await service.exportDraft("qa-pack")).toString("utf8"))).toEqual(updated.draft);
    await service.deleteDraft("qa-pack", 2);
    await expect(service.getDraft("qa-pack")).rejects.toMatchObject({ code: "draft_not_found" });
  });

  it("reports stale draft references after refresh without mutating the draft", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-source-copy-"));
    cleanup.push(sourceRoot);
    await import("node:fs/promises").then(({ cp }) => cp(resolve("definitions"), join(sourceRoot, "definitions"), { recursive: true }));
    await import("node:fs/promises").then(({ cp }) => cp(resolve("config"), join(sourceRoot, "config"), { recursive: true }));
    const service = await createService(sourceRoot);
    await service.createDraft({ schemaVersion: 1, draftType: PACK_DRAFT_TYPE, id: "qa-pack", displayName: "QA Pack", assetIds: ["aapl"], revision: 1 });
    const draftBefore = await service.exportDraft("qa-pack");
    const registryPath = join(sourceRoot, "definitions/registry.json");
    const packsPath = join(sourceRoot, "definitions/packs.json");
    const raw = JSON.parse(await readFile(registryPath, "utf8"));
    const packs = JSON.parse(await readFile(packsPath, "utf8"));
    delete raw.aapl;
    for (const pack of packs) pack.assets = pack.assets.filter((assetId: string) => assetId !== "aapl");
    await writeFile(registryPath, `${JSON.stringify(raw, null, 2)}\n`);
    await writeFile(packsPath, `${JSON.stringify(packs, null, 2)}\n`);
    await service.refresh();
    const record = await service.getDraft("qa-pack");
    expect(record.validation.errors[0]?.code).toBe("draft_asset_not_found");
    expect(await service.exportDraft("qa-pack")).toEqual(draftBefore);
  });

  it("does not mutate canonical source bytes while managing drafts", async () => {
    const registryPath = resolve("definitions/registry.json");
    const packsPath = resolve("definitions/packs.json");
    const channelsPath = resolve("config/channels.json");
    const before = await Promise.all([registryPath, packsPath, channelsPath].map(async (path) => sha256(await readFile(path))));
    const service = await createService();
    await service.createDraft({ schemaVersion: 1, draftType: PACK_DRAFT_TYPE, id: "qa-pack", displayName: "QA Pack", assetIds: [], revision: 1 });
    await service.deleteDraft("qa-pack", 1);
    const after = await Promise.all([registryPath, packsPath, channelsPath].map(async (path) => sha256(await readFile(path))));
    expect(after).toEqual(before);
  });
});

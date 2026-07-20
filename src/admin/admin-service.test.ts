import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AdminService } from "./admin-service.ts";
import { PACK_DRAFT_TYPE } from "./admin-types.ts";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function createService(repositoryRoot = resolve(".")) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-service-test-"));
  cleanup.push(workspaceRoot);
  return AdminService.create({ repositoryRoot, workspaceRoot });
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

describe("AdminService", () => {
  it("loads exact canonical counts and fingerprint", async () => {
    const service = await createService();
    expect(service.status()).toMatchObject({
      canonicalStateReadOnly: true,
      registryAssetCount: 131,
      packCount: 5,
      packMembershipCount: 131,
      registryFingerprint: "2ba08b1d9454f321a40eb1be90ca52653fea61d71c4be2a62ce9c092533c63b9",
      auditGapCount: 262,
    });
  });

  it("reports exact canonical source hashes", async () => {
    const service = await createService();
    expect(service.status()).toMatchObject({
      registrySourceSha256: "1da65e9cade5d5dd516e726787ac9a9ac8f916543de35ccb9d823bd2bb4b1286",
      packSourceSha256: "29a8284033f1c67466f7a50b54a64d208e72e8dcce25e1cd897a650bdbc3c0b4",
      channelConfigurationSha256: "a33158a14b8442a7f02d238f415869bc2d0bcc5e4c514a75cc6934d5d5363bed",
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

  it("returns Assets in stable id order", async () => {
    const ids = (await createService()).searchAssets({ limit: 100 }).assets.map((asset) => asset.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b, "en")));
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

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { AdminService } from "./admin-service.ts";
import { ADMIN_CSP, ADMIN_REQUEST_BODY_LIMIT, startAdminHttpServer, type RunningAdminHttpServer } from "./admin-http-server.ts";
import { PACK_DRAFT_TYPE } from "./admin-types.ts";

const cleanup: string[] = [];
const servers: RunningAdminHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function start(options: { readonly chartDownloadsRoot?: string } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-http-test-"));
  cleanup.push(workspaceRoot);
  const service = await AdminService.create({
    repositoryRoot: resolve("."),
    workspaceRoot,
    ...(options.chartDownloadsRoot === undefined ? {} : {
      chartDownloadsRoot: options.chartDownloadsRoot,
    }),
  });
  const server = await startAdminHttpServer({ service, host: "127.0.0.1", port: 0 });
  servers.push(server);
  return { service, server };
}

async function jsonRequest(url: string, path: string, init?: RequestInit) {
  const response = await fetch(`${url}${path}`, init);
  const body = await response.json() as any;
  return { response, body };
}

function draft(assetIds = ["aapl", "btc", "gold"]) {
  return { schemaVersion: 1, draftType: PACK_DRAFT_TYPE, id: "qa-pack", displayName: "QA Pack", description: "HTTP verification.", assetIds, revision: 1 };
}

async function framedPng(): Promise<Buffer> {
  const width = 160;
  const height = 110;
  const channels = 4;
  const data = Buffer.alloc(width * height * channels, 31);
  for (let offset = 3; offset < data.length; offset += channels) data[offset] = 255;
  const set = (x: number, y: number, value: number): void => {
    const offset = (y * width + x) * channels;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  };
  for (let y = 10; y <= 90; y += 1) {
    for (let x = 7; x <= 152; x += 1) set(x, y, 20);
  }
  for (let x = 7; x <= 152; x += 1) { set(x, 10, 45); set(x, 90, 45); }
  for (let y = 10; y <= 90; y += 1) { set(7, y, 45); set(152, y, 45); }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

describe("Admin HTTP server", () => {
  it("binds to loopback and supports port zero", async () => {
    const { server } = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/u);
    expect(server.port).toBeGreaterThan(0);
  });

  it("rejects a non-loopback host", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-http-test-")); cleanup.push(workspaceRoot);
    const service = await AdminService.create({ repositoryRoot: resolve("."), workspaceRoot });
    await expect(startAdminHttpServer({ service, host: "0.0.0.0", port: 0 })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("returns exact status counts and hashes", async () => {
    const { server } = await start();
    const { response, body } = await jsonRequest(server.url, "/api/v1/status");
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      registryAssetCount: 131,
      packCount: 5,
      packMembershipCount: 131,
      auditGapCount: 230,
      registrySourceSha256: "922bd65da2b222d6bfae647e155829c2c4de9b2767c7d57795530fef821b66b2",
    });
  });

  it("returns bounded deterministic Asset search", async () => {
    const { server } = await start();
    const { body } = await jsonRequest(server.url, "/api/v1/assets?q=stock&limit=5");
    expect(body.data.assets.length).toBeLessThanOrEqual(5);
    const ids = body.data.assets.map((asset: { id: string }) => asset.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("renders and downloads a standalone publication without canonical source mutation", async () => {
    const { service, server } = await start();
    const canonicalPaths = ["definitions/registry.json", "definitions/packs.json", "config/channels.json"].map((path) => resolve(path));
    const before = await Promise.all(canonicalPaths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));

    const options = await jsonRequest(server.url, "/api/v1/standalone-render/options");
    expect(options.body.data.timeframes).toContain("4D");
    expect(options.body.data.assets).toContainEqual(expect.objectContaining({ id: "btc", tradingViewSymbol: "CRYPTO:BTCUSD", currency: "USD" }));

    const query = new URLSearchParams({
      assetId: "btc",
      timeframe: "6H",
      filename: "BTCUSD_2026-07-22_18-58-01.png",
    });
    const response = await fetch(`${server.url}/api/v1/standalone-renders?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: await framedPng(),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.data).toMatchObject({
      asset: { id: "btc" },
      timeframe: "6H",
      dataAsOf: "2026-07-22",
      effects: { packWorkspaceChanged: false, staged: false, released: false, discordContacted: false },
    });

    const publication = await fetch(`${server.url}${body.data.publicationUrl}`);
    expect(publication.status).toBe(200);
    expect(publication.headers.get("content-type")).toBe("image/png");
    const publicationBytes = Buffer.from(await publication.arrayBuffer());
    expect(createHash("sha256").update(publicationBytes).digest("hex")).toBe(body.data.outputSha256);
    const receipt = await fetch(`${server.url}${body.data.receiptUrl}`);
    expect(receipt.headers.get("content-type")).toContain("application/json");
    expect((await receipt.json() as any).metadata.timeframe).toBe("6H");

    const after = await Promise.all(canonicalPaths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    expect(after).toEqual(before);
    expect(await readdir(service.standaloneRenders.root)).toEqual([body.data.renderId]);
  });

  it("rejects invalid standalone requests and removes failed render tasks", async () => {
    const { service, server } = await start();
    const invalidTimeframe = new URLSearchParams({
      assetId: "btc",
      timeframe: "hourly",
      filename: "BTCUSD_2026-07-22_18-58-01.png",
    });
    const invalid = await fetch(`${server.url}/api/v1/standalone-renders?${invalidTimeframe.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: await framedPng(),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as any).error.code).toBe("invalid_standalone_render");

    const mismatch = new URLSearchParams({
      assetId: "btc",
      timeframe: "1D",
      filename: "ETHUSD_2026-07-22_18-58-01.png",
    });
    const failed = await fetch(`${server.url}/api/v1/standalone-renders?${mismatch.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: await framedPng(),
    });
    expect(failed.status).toBe(400);
    expect((await failed.json() as any).error.code).toBe("standalone_render_failed");
    expect(await readdir(service.standaloneRenders.root)).toEqual([]);
  });

  it("reviews before staging, accepts revisions, and exposes exact Pack progress without publishing", async () => {
    const { service, server } = await start();
    const canonicalPaths = ["definitions/registry.json", "definitions/packs.json", "config/channels.json"].map((path) => resolve(path));
    const before = await Promise.all(canonicalPaths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));

    const initial = await jsonRequest(server.url, "/api/v1/pack-workspace");
    const crypto = initial.body.data.packs.find((pack: any) => pack.id === "crypto");
    const etfs = initial.body.data.packs.find((pack: any) => pack.id === "etfs");
    expect(initial.body.data.publishAvailable).toBe(false);
    expect(crypto).toMatchObject({ timeframe: "1D", state: "empty", capturedCount: 0, totalCount: 16 });
    expect(etfs.timeframe).toBe("4D");
    expect(crypto.assets.find((asset: any) => asset.id === "btc")).toMatchObject({
      renderReady: true,
      captured: false,
      revisions: 0,
    });
    expect(crypto.assets.every((asset: any) => asset.renderReady === true)).toBe(true);

    const preview = async (date: string) => {
      const query = new URLSearchParams({
        packId: "crypto",
        assetId: "btc",
        filename: `BTCUSD_${date}_18-58-01.png`,
      });
      const response = await fetch(`${server.url}/api/v1/pack-workspace/previews?${query.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: await framedPng(),
      });
      expect(response.status).toBe(201);
      return (await response.json() as any).data;
    };

    const first = await preview("2026-07-22");
    expect(first).toMatchObject({
      packId: "crypto",
      asset: { id: "btc" },
      timeframe: "1D",
      dataAsOf: "2026-07-22",
      nextRevision: 1,
      effects: { workspaceChanged: false, staged: false, released: false, discordContacted: false },
    });
    const unchanged = await jsonRequest(server.url, "/api/v1/pack-workspace");
    expect(unchanged.body.data.packs.find((pack: any) => pack.id === "crypto")).toMatchObject({ capturedCount: 0, state: "empty" });

    const publicationResponse = await fetch(`${server.url}${first.publicationUrl}`);
    const firstPublication = Buffer.from(await publicationResponse.arrayBuffer());
    expect(publicationResponse.headers.get("content-type")).toBe("image/png");
    expect(createHash("sha256").update(firstPublication).digest("hex")).toBe(first.outputSha256);
    expect((await (await fetch(`${server.url}${first.receiptUrl}`)).json() as any).metadata.timeframe).toBe("1D");

    const accepted = await jsonRequest(server.url, `/api/v1/pack-workspace/previews/${first.previewId}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(accepted.body.data).toMatchObject({
      accepted: true,
      assetId: "btc",
      revisions: 1,
      packState: "building",
      capturedCount: 1,
      totalCount: 16,
      effects: { staged: true, workspaceChanged: true, released: false, discordContacted: false },
    });
    expect(await readFile(join(service.packRenders.stagingRoot, "active", "btc.png"))).toEqual(firstPublication);
    expect((await fetch(`${server.url}${first.publicationUrl}`)).status).toBe(404);

    const second = await preview("2026-07-23");
    expect(second.nextRevision).toBe(2);
    const secondPublication = Buffer.from(await (await fetch(`${server.url}${second.publicationUrl}`)).arrayBuffer());
    const replacement = await jsonRequest(server.url, `/api/v1/pack-workspace/previews/${second.previewId}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(replacement.body.data).toMatchObject({ revisions: 2, capturedCount: 1, packState: "building" });
    expect(await readFile(join(service.packRenders.stagingRoot, "active", "btc.png"))).toEqual(secondPublication);

    const current = await jsonRequest(server.url, "/api/v1/pack-workspace");
    const currentBtc = current.body.data.packs.find((pack: any) => pack.id === "crypto").assets.find((asset: any) => asset.id === "btc");
    expect(currentBtc).toMatchObject({
      captured: true,
      artifactReady: true,
      revisions: 2,
    });
    expect(currentBtc.revisionHistory.map((revision: any) => revision.revision)).toEqual([1, 2]);
    expect(currentBtc.revisionHistory).toContainEqual(expect.objectContaining({
      revision: 2,
      current: true,
      confirmed: true,
    }));
    expect(Buffer.from(await (await fetch(`${server.url}${currentBtc.revisionHistory[0].publicationUrl}`)).arrayBuffer())).toEqual(firstPublication);

    const deleteCurrent = await jsonRequest(
      server.url,
      "/api/v1/pack-workspace/packs/crypto/assets/btc/revisions/2",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "delete_revision", expectedCurrentRevision: 2 }),
      },
    );
    expect(deleteCurrent.body.data).toMatchObject({
      deleted: true,
      deletedRevision: 2,
      restoredRevision: 1,
      currentRevision: 1,
      remainingRevisionCount: 1,
      effects: { workspaceChanged: true, stagingChanged: true, released: false, discordContacted: false },
    });
    expect(await readFile(join(service.packRenders.stagingRoot, "active", "btc.png"))).toEqual(firstPublication);
    const afterRevisionDelete = await jsonRequest(server.url, "/api/v1/pack-workspace");
    expect(afterRevisionDelete.body.data.packs.find((pack: any) => pack.id === "crypto").assets.find((asset: any) => asset.id === "btc")).toMatchObject({
      captured: true,
      revisions: 1,
      revisionHistory: [expect.objectContaining({ revision: 1, current: true })],
    });

    const unconfirmedAssetReset = await jsonRequest(
      server.url,
      "/api/v1/pack-workspace/packs/crypto/assets/btc/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "", expectedRevisions: 1 }),
      },
    );
    expect(unconfirmedAssetReset.response.status).toBe(400);
    expect(unconfirmedAssetReset.body.error.code).toBe("pack_workspace_reset_confirmation_invalid");

    const staleAssetReset = await jsonRequest(
      server.url,
      "/api/v1/pack-workspace/packs/crypto/assets/btc/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "reset_asset", expectedRevisions: 2 }),
      },
    );
    expect(staleAssetReset.response.status).toBe(409);
    expect(staleAssetReset.body.error.code).toBe("pack_workspace_reset_state_conflict");
    expect(await readFile(join(service.packRenders.stagingRoot, "active", "btc.png"))).toEqual(firstPublication);

    const assetReset = await jsonRequest(
      server.url,
      "/api/v1/pack-workspace/packs/crypto/assets/btc/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "reset_asset", expectedRevisions: 1 }),
      },
    );
    expect(assetReset.body.data).toMatchObject({
      outcome: "asset_reset",
      resetAssetIds: ["btc"],
      packState: "empty",
      capturedCount: 0,
      stagedArtifactCount: 1,
      stagingCleared: true,
      effects: { workspaceChanged: true, stagingCleared: true, released: false, discordContacted: false },
    });
    expect(await readdir(join(service.packRenders.stagingRoot, "active"))).toEqual([]);
    const afterAssetReset = await jsonRequest(server.url, "/api/v1/pack-workspace");
    expect(afterAssetReset.body.data.packs.find((pack: any) => pack.id === "crypto").assets.find((asset: any) => asset.id === "btc")).toMatchObject({
      captured: false,
      artifactReady: false,
      revisions: 0,
      revisionHistory: [],
    });

    const third = await preview("2026-07-24");
    expect(third.nextRevision).toBe(1);
    const thirdAccepted = await jsonRequest(server.url, `/api/v1/pack-workspace/previews/${third.previewId}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(thirdAccepted.body.data).toMatchObject({ revisions: 1, capturedCount: 1, packState: "building" });

    const stalePackReset = await jsonRequest(
      server.url,
      "/api/v1/pack-workspace/packs/crypto/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "reset_pack", expectedCapturedAssetIds: [] }),
      },
    );
    expect(stalePackReset.response.status).toBe(409);
    expect(stalePackReset.body.error.code).toBe("pack_workspace_reset_state_conflict");

    const packReset = await jsonRequest(
      server.url,
      "/api/v1/pack-workspace/packs/crypto/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "reset_pack", expectedCapturedAssetIds: ["btc"] }),
      },
    );
    expect(packReset.body.data).toMatchObject({
      outcome: "pack_reset",
      resetAssetIds: ["btc"],
      packState: "empty",
      capturedCount: 0,
      stagedArtifactCount: 1,
      stagingCleared: true,
      effects: { workspaceChanged: true, stagingCleared: true, released: false, discordContacted: false },
    });
    expect(await readdir(join(service.packRenders.stagingRoot, "active"))).toEqual([]);
    const afterPackReset = await jsonRequest(server.url, "/api/v1/pack-workspace");
    expect(afterPackReset.body.data.packs.find((pack: any) => pack.id === "crypto")).toMatchObject({ state: "empty", capturedCount: 0 });

    const after = await Promise.all(canonicalPaths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    expect(after).toEqual(before);
  });

  it("starts and scans one governed Pack capture session without creating no-op revisions", async () => {
    const downloads = await mkdtemp(join(tmpdir(), "visionx-admin-downloads-test-"));
    cleanup.push(downloads);
    const { server } = await start({ chartDownloadsRoot: downloads });

    const before = await jsonRequest(server.url, "/api/v1/pack-workspace/capture-session?packId=crypto");
    expect(before.body.data).toMatchObject({
      configured: true,
      active: false,
      readinessReason: "session_not_started",
    });
    const started = await jsonRequest(server.url, "/api/v1/pack-workspace/capture-session/start", {
      method: "POST",
      body: JSON.stringify({ packId: "crypto" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(started.response.status).toBe(201);
    expect(started.body.data).toMatchObject({
      session: { active: true, packId: "crypto", candidateCount: 0 },
      effects: { workspaceChanged: false, stagingChanged: false, discordContacted: false },
    });
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const filename = `BTCUSD_${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}_${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}.png`;
    await writeFile(join(downloads, filename), await framedPng());

    const scan = await jsonRequest(server.url, "/api/v1/pack-workspace/capture-session/scan", {
      method: "POST",
      body: JSON.stringify({ packId: "crypto" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(scan.body.data).toMatchObject({
      scan: { queued: [{ assetId: "btc", filename }], unchangedAssetIds: [] },
      effects: { previewsQueued: 1, workspaceChanged: false, stagingChanged: false, discordContacted: false },
    });

    const repeated = await jsonRequest(server.url, "/api/v1/pack-workspace/capture-session/scan", {
      method: "POST",
      body: JSON.stringify({ packId: "crypto" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(repeated.body.data).toMatchObject({
      scan: { queued: [], unchangedAssetIds: ["btc"] },
      effects: { previewsQueued: 0, workspaceChanged: false, stagingChanged: false, discordContacted: false },
    });
  });

  it("discards a Pack preview without staging or changing Workspace progress", async () => {
    const { service, server } = await start();
    const query = new URLSearchParams({
      packId: "crypto",
      assetId: "btc",
      filename: "BTCUSD_2026-07-22_18-58-01.png",
    });
    const response = await fetch(`${server.url}/api/v1/pack-workspace/previews?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: await framedPng(),
    });
    const preview = (await response.json() as any).data;

    const discarded = await jsonRequest(server.url, `/api/v1/pack-workspace/previews/${preview.previewId}`, { method: "DELETE" });
    expect(discarded.body.data).toMatchObject({
      discarded: true,
      effects: { workspaceChanged: false, staged: false, released: false, discordContacted: false },
    });
    expect((await fetch(`${server.url}${preview.publicationUrl}`)).status).toBe(404);
    expect(await readdir(join(service.packRenders.stagingRoot))).toEqual([]);
    const state = await jsonRequest(server.url, "/api/v1/pack-workspace");
    expect(state.body.data.packs.find((pack: any) => pack.id === "crypto")).toMatchObject({ capturedCount: 0, state: "empty" });
  });

  it("returns exact Pack ordering", async () => {
    const { server } = await start();
    const { body } = await jsonRequest(server.url, "/api/v1/packs/crypto");
    expect(body.data.assets.slice(0, 4).map((asset: { id: string }) => asset.id)).toEqual(["akt", "zec", "pepe", "doge"]);
  });

  it("returns typed 404 responses", async () => {
    const { server } = await start();
    const asset = await jsonRequest(server.url, "/api/v1/assets/missing");
    const pack = await jsonRequest(server.url, "/api/v1/packs/missing");
    expect(asset.response.status).toBe(404);
    expect(asset.body.error.code).toBe("asset_not_found");
    expect(pack.body.error.code).toBe("pack_not_found");
  });

  it("creates, updates, validates, exports, and deletes a draft through HTTP", async () => {
    const { server } = await start();
    const created = await jsonRequest(server.url, "/api/v1/pack-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: draft() }) });
    expect(created.response.status).toBe(201);
    expect(created.body.data.draft.revision).toBe(1);
    const updateDraft = { ...created.body.data.draft, assetIds: ["gold", "aapl", "btc"] };
    const updated = await jsonRequest(server.url, "/api/v1/pack-drafts/qa-pack", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, draft: updateDraft }) });
    expect(updated.body.data.draft).toMatchObject({ revision: 2, assetIds: ["gold", "aapl", "btc"] });
    const validation = await jsonRequest(server.url, "/api/v1/pack-drafts/qa-pack/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(validation.body.data.valid).toBe(true);
    const exported = await fetch(`${server.url}/api/v1/pack-drafts/qa-pack/export`);
    expect(JSON.parse(await exported.text()).assetIds).toEqual(["gold", "aapl", "btc"]);
    const deleted = await jsonRequest(server.url, "/api/v1/pack-drafts/qa-pack", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 2 }) });
    expect(deleted.body.data.deleted).toBe(true);
  });

  it("returns a revision conflict without mutation", async () => {
    const { server } = await start();
    await jsonRequest(server.url, "/api/v1/pack-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: draft() }) });
    const first = await jsonRequest(server.url, "/api/v1/pack-drafts/qa-pack", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, draft: { ...draft(), displayName: "Revision 2" } }) });
    expect(first.body.data.draft.revision).toBe(2);
    const stale = await jsonRequest(server.url, "/api/v1/pack-drafts/qa-pack", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, draft: { ...draft(), displayName: "Stale" } }) });
    expect(stale.response.status).toBe(409);
    expect(stale.body.error.code).toBe("draft_revision_conflict");
    const current = await jsonRequest(server.url, "/api/v1/pack-drafts/qa-pack");
    expect(current.body.data.draft.displayName).toBe("Revision 2");
  });

  it("rejects malformed and duplicate-field JSON", async () => {
    const { server } = await start();
    const malformed = await jsonRequest(server.url, "/api/v1/pack-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    const duplicate = await jsonRequest(server.url, "/api/v1/pack-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"draft":{},"draft":{}}' });
    expect(malformed.body.error.code).toBe("invalid_json");
    expect(duplicate.body.error.code).toBe("invalid_json");
  });

  it("rejects oversized request bodies", async () => {
    const { server } = await start();
    const result = await jsonRequest(server.url, "/api/v1/pack-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: "x".repeat(ADMIN_REQUEST_BODY_LIMIT) }) });
    expect(result.response.status).toBe(413);
    expect(result.body.error.code).toBe("request_body_too_large");
  });

  it("rejects the wrong content type", async () => {
    const { server } = await start();
    const result = await jsonRequest(server.url, "/api/v1/pack-drafts", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(result.response.status).toBe(415);
    expect(result.body.error.code).toBe("invalid_content_type");
  });

  it("rejects cross-origin state-changing requests", async () => {
    const { server } = await start();
    const result = await jsonRequest(server.url, "/api/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.invalid" }, body: "{}" });
    expect(result.response.status).toBe(403);
    expect(result.body.error.code).toBe("origin_rejected");
  });

  it("rejects encoded route traversal", async () => {
    const { server } = await start();
    const result = await fetch(`${server.url}/api/v1/pack-drafts/%2e%2e%2fdefinitions`);
    expect(result.status).toBe(404);
    expect(((await result.json()) as any).error.code).toBe("route_not_found");
  });

  it("exposes no absolute paths in API errors", async () => {
    const { server } = await start();
    const result = await jsonRequest(server.url, "/api/v1/pack-drafts/missing");
    expect(JSON.stringify(result.body)).not.toContain(resolve("."));
    expect(JSON.stringify(result.body)).not.toContain(tmpdir());
  });

  it.each(["/", "/styles.css", "/app.js", "/visionx-emblem.png", "/visionx-wordmark.png"])("serves static UI asset %s with security headers", async (path) => {
    const { server } = await start();
    const response = await fetch(`${server.url}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(ADMIN_CSP);
  });

  it("serves the Pack Workspace, thread routing, Pack builder, standalone renderer, and read-only Registry without external resources", async () => {
    const { server } = await start();
    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).toContain("PACK BUILDER");
    expect(html).toContain("PACK WORKSPACE");
    expect(html).toContain("DISCORD THREAD ROUTING");
    expect(html).toContain("PACK ROUTING READINESS");
    expect(html).toContain("INSPECT &amp; ADOPT");
    expect(html).toContain("INSPECT &amp; PROVISION");
    expect(html).toContain("EXPLICIT CONFIRMATION REQUIRED");
    expect(html).toContain("PUBLISH UNAVAILABLE");
    expect(html).toContain("/visionx-emblem.png");
    expect(html).toContain("/visionx-wordmark.png");
    expect(html).toContain("CREATE PACK");
    expect(html).toContain("STANDALONE RENDERER");
    expect(html).toContain("REGISTRY");
    expect(html).not.toContain("Asset registrations");
    expect(html).not.toContain("Pack drafts");
    expect(html).not.toMatch(/https?:\/\//u);
  });

  it("refreshes current source state without modifying canonical bytes", async () => {
    const { server } = await start();
    const paths = ["definitions/registry.json", "definitions/packs.json", "config/channels.json"].map((path) => resolve(path));
    const before = await Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    const result = await jsonRequest(server.url, "/api/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(result.body.data.registryAssetCount).toBe(131);
    const after = await Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    expect(after).toEqual(before);
  });

  it("closes gracefully", async () => {
    const { server } = await start();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(fetch(`${server.url}/api/v1/status`)).rejects.toThrow();
  });
});

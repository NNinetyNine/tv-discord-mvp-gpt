import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

async function start() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-http-test-"));
  cleanup.push(workspaceRoot);
  const service = await AdminService.create({ repositoryRoot: resolve("."), workspaceRoot });
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
      auditGapCount: 260,
      registrySourceSha256: "20c060e458285aa51dd38764a3b56516ba2ae35c44d05b58e283f1a76747d6cc",
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

  it("serves the Pack builder, standalone renderer, and read-only Registry without external resources", async () => {
    const { server } = await start();
    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).toContain("PACK BUILDER");
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

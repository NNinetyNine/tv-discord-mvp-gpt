import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startAdminHttpServer, type RunningAdminHttpServer } from "./admin-http-server.ts";
import { AdminService } from "./admin-service.ts";

const cleanup: string[] = [];
const servers: RunningAdminHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => { await server.close().catch(() => undefined); }));
  await Promise.all(cleanup.splice(0).map(async (path) => { await rm(path, { recursive: true, force: true }); }));
});

async function start() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "visionx-hidden-tools-http-repo-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-hidden-tools-http-workspace-"));
  const downloadsRoot = await mkdtemp(join(tmpdir(), "visionx-hidden-tools-http-downloads-"));
  cleanup.push(repositoryRoot, workspaceRoot, downloadsRoot);
  await Promise.all([
    cp(resolve("definitions"), join(repositoryRoot, "definitions"), { recursive: true }),
    cp(resolve("config"), join(repositoryRoot, "config"), { recursive: true }),
    writeFile(join(downloadsRoot, "AAPL_2026-07-23_22-00-00.png"), "chart"),
  ]);
  const service = await AdminService.create({ repositoryRoot, workspaceRoot, chartDownloadsRoot: downloadsRoot });
  const image = join(workspaceRoot, "release-source.png");
  await writeFile(image, "release-chart");
  const release = service.releases.createThreadedRelease({
    packId: "historical",
    packDisplay: "Historical",
    forumChannelId: "177777777777777777",
    startedAt: "2026-07-23T22:00:00.000Z",
    analyses: [{ assetId: "aapl", display: "Apple", capturedAt: "2026-07-23T21:59:00.000Z", sourceImagePath: image, threadId: "188888888888888888" }],
  });
  const server = await startAdminHttpServer({ service, host: "127.0.0.1", port: 0 });
  servers.push(server);
  return { server, releaseId: release.releaseId };
}

async function json(url: string, path: string, init?: RequestInit) {
  const response = await fetch(`${url}${path}`, init);
  return { response, body: await response.json() as any };
}

describe("Administration hidden operator-function HTTP", () => {
  it("serves audits, governed maintenance and aliases, and read-only Release artifacts", async () => {
    const { server, releaseId } = await start();
    const tools = await json(server.url, "/api/v1/operator-tools");
    expect(tools.body.data).toMatchObject({ status: { packCount: 5 }, exportAudit: { available: true }, archive: { releaseCount: 1 } });
    const audit = await json(server.url, "/api/v1/operator-tools/export-audit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(audit.body.data).toMatchObject({ scannedCount: 1, resolvedCount: 1, effects: { discordContacted: false } });

    const maintenance = await json(server.url, "/api/v1/packs/maintenance");
    const stocks = maintenance.body.data.packs.find((pack: any) => pack.id === "stocks");
    const preview = await json(server.url, "/api/v1/packs/maintenance/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ change: {
        operation: "update",
        packId: "stocks",
        displayName: "Equities",
        logicalChannel: "stocks",
        assetIds: stocks.assetIds,
        packOrder: maintenance.body.data.packs.map((pack: any) => pack.id),
      } }),
    });
    expect(preview.response.status).toBe(201);
    expect(preview.body.data).toMatchObject({ ready: true, confirmation: "APPLY PACK STOCKS" });
    const applied = await json(server.url, `/api/v1/packs/maintenance/${preview.body.data.previewId}/apply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: preview.body.data.confirmation }),
    });
    expect(applied.body.data).toMatchObject({ applied: true, effects: { discordContacted: false } });

    const alias = await json(server.url, "/api/v1/assets/aapl/aliases/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ change: { assetId: "aapl", operation: "add", alias: "APPLE_HTTP" } }),
    });
    expect(alias.response.status).toBe(201);
    const aliasApplied = await json(server.url, `/api/v1/assets/aapl/aliases/${alias.body.data.previewId}/apply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: alias.body.data.confirmation }),
    });
    expect(aliasApplied.body.data.asset.tradingViewAliases).toContain("APPLE_HTTP");

    const archive = await json(server.url, "/api/v1/releases");
    expect(archive.body.data.releases[0]).toMatchObject({ packId: "historical", packCurrent: false });
    const detail = await json(server.url, `/api/v1/releases/historical/${releaseId}`);
    expect(detail.body.data.analyses[0]).toMatchObject({ assetId: "aapl" });
    const record = await fetch(`${server.url}/api/v1/releases/historical/${releaseId}/release.json`);
    expect(record.headers.get("content-disposition")).toContain("attachment");
    expect(await record.text()).toContain(releaseId);
    const image = await fetch(`${server.url}/api/v1/releases/historical/${releaseId}/images/aapl.png`);
    expect(image.headers.get("content-type")).toContain("image/png");
    expect(await image.text()).toBe("release-chart");
  });
});

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startAdminHttpServer, type RunningAdminHttpServer } from "./admin-http-server.ts";
import { AdminService } from "./admin-service.ts";

const cleanup: string[] = [];
const servers: RunningAdminHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "visionx-admin-pack-builder-repo-")); cleanup.push(root);
  const workspace = await mkdtemp(join(tmpdir(), "visionx-admin-pack-builder-workspace-")); cleanup.push(workspace);
  await mkdir(join(root, "definitions")); await mkdir(join(root, "config"));
  const registry = Buffer.from('{\n  "aapl": { "tradingView": "NASDAQ:AAPL", "display": "Apple", "currency": "USD", "channel": "stocks" }\n}\n');
  const packs = Buffer.from('[\n  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl"]\n  }\n]\n');
  const channels = Buffer.from('{\n  "stocks": "1527846988270534827",\n  "forex": "1528609079822516305"\n}\n');
  await writeFile(join(root, "definitions/registry.json"), registry);
  await writeFile(join(root, "definitions/packs.json"), packs);
  await writeFile(join(root, "config/channels.json"), channels);
  const service = await AdminService.create({ repositoryRoot: root, workspaceRoot: workspace });
  return { root, workspace, registry, packs, channels, service };
}

function input() {
  return {
    schemaVersion: 1,
    pack: { id: "forex", display: "Forex", channel: "forex" },
    members: [
      { id: "dxy", display: "U.S. Dollar Currency Index", tradingView: "TVC:DXY", currency: "USD" },
      { id: "exy", display: "Euro Currency Index", tradingView: "TVC:EXY", currency: "USD" },
    ],
  };
}

async function request(server: RunningAdminHttpServer, path: string, body: unknown, origin = server.url) {
  const response = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

describe("Administration Create Pack front door", () => {
  it("previews without mutation and creates one atomic business result", async () => {
    const f = await fixture();
    const preview = await f.service.previewPackCreation(input());
    expect(preview).toMatchObject({ missingAssetCount: 2, existingAssetCount: 0, publicationEffects: { rendered: false, published: false, released: false, discordContacted: false } });
    expect(await readFile(join(f.root, "definitions/registry.json"))).toEqual(f.registry);
    expect(await readFile(join(f.root, "definitions/packs.json"))).toEqual(f.packs);
    const created = await f.service.createPackFromPreview("forex", preview.previewId);
    expect(created).toMatchObject({ created: true, packId: "forex", status: { registryAssetCount: 3, packCount: 2, packMembershipCount: 3 } });
    expect(f.service.getAsset("dxy")).toMatchObject({ tradingViewSymbol: "TVC:DXY", currency: "USD", logicalChannel: "forex" });
    expect(f.service.getPack("forex").assets.map((asset) => asset.id)).toEqual(["dxy", "exy"]);
    expect(await readFile(join(f.root, "config/channels.json"))).toEqual(f.channels);
  });

  it("preserves current input and preview in the confined workspace", async () => {
    const f = await fixture();
    const preview = await f.service.previewPackCreation(input());
    const state = await f.service.packCreationState("forex");
    expect(state).toMatchObject({ packId: "forex", input: input(), preview: { previewId: preview.previewId } });
    expect(JSON.stringify(state)).not.toContain(f.root);
    expect(JSON.stringify(state)).not.toContain(f.workspace);
  });

  it("serves strict preview/create routes and rejects foreign-origin writes and browser authority fields", async () => {
    const f = await fixture();
    const server = await startAdminHttpServer({ service: f.service, host: "127.0.0.1", port: 0 }); servers.push(server);
    const preview = await request(server, "/api/v1/packs/create/preview", { input: input() });
    expect(preview.response.status).toBe(200);
    expect(preview.body.data.previewId).toMatch(/^[a-f0-9]{64}$/u);
    const foreign = await request(server, "/api/v1/packs/create", { packId: "forex", previewId: preview.body.data.previewId }, "https://evil.invalid");
    expect(foreign.response.status).toBe(403);
    expect(foreign.body.error.code).toBe("origin_rejected");
    const authority = await request(server, "/api/v1/packs/create", { packId: "forex", previewId: preview.body.data.previewId, registryBytes: "arbitrary" });
    expect(authority.response.status).toBe(400);
    expect(authority.body.error.code).toBe("invalid_request");
    const created = await request(server, "/api/v1/packs/create", { packId: "forex", previewId: preview.body.data.previewId });
    expect(created.response.status).toBe(201);
    expect(created.body.data.created).toBe(true);
  });

  it("refreshes preview state and reports stale definitions without losing stored work", async () => {
    const f = await fixture();
    const preview = await f.service.previewPackCreation(input());
    await writeFile(join(f.root, "definitions/registry.json"), Buffer.concat([f.registry.subarray(0, f.registry.length - 2), Buffer.from(',\n  "msft": { "tradingView": "NASDAQ:MSFT", "display": "Microsoft", "currency": "USD", "channel": "stocks" }\n}\n')]));
    await expect(f.service.createPackFromPreview("forex", preview.previewId)).rejects.toMatchObject({ code: "stale_registry_state", status: 409 });
    expect(await f.service.packCreationState("forex")).toMatchObject({ input: input(), preview: { previewId: preview.previewId } });
    expect(await readFile(join(f.root, "definitions/packs.json"))).toEqual(f.packs);
  });

  it("does not mutate canonical files when validation fails", async () => {
    const f = await fixture();
    const before = await Promise.all(["definitions/registry.json", "definitions/packs.json", "config/channels.json"].map(async (path) => createHash("sha256").update(await readFile(join(f.root, path))).digest("hex")));
    await expect(f.service.previewPackCreation({ ...input(), members: [{ id: "dxy", display: "DXY", tradingView: "TVC:DXY", currency: "usd" }] })).rejects.toMatchObject({ code: "invalid_pack_builder_input" });
    const after = await Promise.all(["definitions/registry.json", "definitions/packs.json", "config/channels.json"].map(async (path) => createHash("sha256").update(await readFile(join(f.root, path))).digest("hex")));
    expect(after).toEqual(before);
  });
});

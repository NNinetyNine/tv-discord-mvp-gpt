import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStagingStore } from "../wiring/staging.ts";
import type { PublisherSessionShape } from "../wiring/publish-pack.ts";
import { AdminService } from "./admin-service.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const PACKS = Object.freeze([
  Object.freeze({ id: "alpha", display: "Alpha", channel: "crypto", assets: Object.freeze(["asset_a"]) }),
  Object.freeze({ id: "beta", display: "Beta", channel: "stocks", assets: Object.freeze(["asset_b"]) }),
  Object.freeze({ id: "gamma", display: "Gamma", channel: "indices", assets: Object.freeze(["asset_c"]) }),
]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function publicationRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visionx-admin-publication-repository-"));
  cleanup.push(root);
  await Promise.all([
    mkdir(join(root, "definitions"), { recursive: true }),
    mkdir(join(root, "config"), { recursive: true }),
    mkdir(join(root, "assets"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "definitions/registry.json"), `${JSON.stringify({
      asset_a: { tradingView: "NASDAQ:AAA", display: "Asset A", currency: "USD", channel: "crypto" },
      asset_b: { tradingView: "NASDAQ:BBB", display: "Asset B", currency: "USD", channel: "stocks" },
      asset_c: { tradingView: "NASDAQ:CCC", display: "Asset C", currency: "USD", channel: "indices" },
    }, null, 2)}\n`),
    writeFile(join(root, "definitions/packs.json"), `${JSON.stringify(PACKS, null, 2)}\n`),
    writeFile(join(root, "config/channels.json"), `${JSON.stringify({
      crypto: "111111111111111111",
      stocks: "222222222222222222",
      indices: "333333333333333333",
    }, null, 2)}\n`),
    writeFile(join(root, "config/asset-threads.json"), `${JSON.stringify({
      schemaVersion: 1,
      packs: {
        alpha: { asset_a: "411111111111111111" },
        beta: { asset_b: "422222222222222222" },
        gamma: { asset_c: "433333333333333333" },
      },
    }, null, 2)}\n`),
  ]);
  return root;
}

function fakePublisher() {
  const attempts: string[] = [];
  const posts: string[] = [];
  let failThreadId: string | null = null;
  let message = 0;
  return {
    attempts,
    posts,
    setFailure(threadId: string | null) { failThreadId = threadId; },
    async open(): Promise<PublisherSessionShape> {
      return {
        async post(threadId) {
          attempts.push(threadId);
          if (threadId === failThreadId) throw new Error(`Discord failed for ${threadId}`);
          posts.push(threadId);
          message += 1;
          return { messageId: `message-${message}` };
        },
        async close() {},
      };
    },
  };
}

async function createPublicationService() {
  const repositoryRoot = await publicationRepository();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-publication-workspace-"));
  const downloadsRoot = await mkdtemp(join(tmpdir(), "visionx-admin-publication-downloads-"));
  cleanup.push(workspaceRoot, downloadsRoot);
  const publisher = fakePublisher();
  const service = await AdminService.create({
    repositoryRoot,
    workspaceRoot,
    chartDownloadsRoot: downloadsRoot,
    openPublisherSession: publisher.open,
  });
  return { service, publisher };
}

async function seedReadyPacks(service: AdminService, packIds: readonly string[]): Promise<void> {
  const selected = new Set(packIds);
  const captures: Array<{ assetId: string; capturedAt: string; revisions: number }> = [];
  const staging = createStagingStore(service.packRenders.stagingRoot);
  let index = 0;
  for (const pack of PACKS) {
    if (!selected.has(pack.id)) continue;
    const candidates: Record<string, unknown> = {};
    for (const assetId of pack.assets) {
      index += 1;
      const bytes = Buffer.from(`publication:${pack.id}:${assetId}`);
      const sourcePath = join(service.publication.root, `${assetId}.png`);
      await writeFile(sourcePath, bytes);
      staging.stage(assetId, sourcePath);
      captures.push({ assetId, capturedAt: "2026-07-23T12:00:00.000Z", revisions: 1 });
      candidates[assetId] = {
        assetId,
        filename: `${assetId.toUpperCase()}_2026-07-23_12-00-00.png`,
        sourceSha256: sha256(bytes),
        size: bytes.length,
        modifiedAt: "2026-07-23T12:00:00.000Z",
        exportedAt: "2026-07-23T12:00:00.000Z",
        previewId: index.toString(16).padStart(32, "0"),
        state: "accepted",
        acceptedAt: "2026-07-23T12:01:00.000Z",
        acceptedRevision: 1,
      };
    }
    await writeFile(join(service.packCaptureSessions.root, `${pack.id}.json`), `${JSON.stringify({
      schemaVersion: 1,
      recordType: "visionx.pack-capture-session",
      sessionId: (100 + index).toString(16).padStart(32, "0"),
      packId: pack.id,
      startedAt: "2026-07-23T11:55:00.000Z",
      maxSpanMs: 3_600_000,
      baseline: {},
      candidates,
    }, null, 2)}\n`);
  }
  await writeFile(service.packRenders.sessionPath, `${JSON.stringify({ version: 3, captures }, null, 2)}\n`);
}

describe("Admin multi-Pack publication", () => {
  it("preflights every selected Pack and publishes only that subset in canonical order", async () => {
    const { service, publisher } = await createPublicationService();
    await seedReadyPacks(service, ["alpha", "beta", "gamma"]);

    const preview = await service.preparePackPublication({ packIds: ["gamma", "alpha"] });
    expect(preview).toMatchObject({
      valid: true,
      confirmation: "PUBLISH 2 PACKS",
      selectedPackIds: ["alpha", "gamma"],
      effects: { releasesCreated: 2, discordPostsPlanned: 2, unselectedPacksChanged: false },
    });

    const result = await service.applyPackPublication(preview.previewId, preview.confirmation);
    expect(result).toMatchObject({
      outcome: "published",
      selectedPackIds: ["alpha", "gamma"],
      notAttemptedPackIds: [],
      cleanupWarnings: [],
      effects: { releasesCreated: 2, packsReset: ["alpha", "gamma"] },
    });
    expect(result.published.map((item) => item.packId)).toEqual(["alpha", "gamma"]);
    expect(publisher.posts).toEqual(["411111111111111111", "433333333333333333"]);
    expect(service.releases.listReleases("alpha")).toHaveLength(1);
    expect(service.releases.listReleases("beta")).toHaveLength(0);
    expect(service.releases.listReleases("gamma")).toHaveLength(1);

    const state = await service.packWorkspaceState();
    expect(state.packs.find((pack) => pack.id === "alpha")?.capturedCount).toBe(0);
    expect(state.packs.find((pack) => pack.id === "beta")?.capturedCount).toBe(1);
    expect(state.packs.find((pack) => pack.id === "gamma")?.capturedCount).toBe(0);
    expect((await service.packCaptureSessionState("alpha")).acceptedCount).toBe(0);
    expect((await service.packCaptureSessionState("beta")).acceptedCount).toBe(1);
  });

  it("refuses the entire selection before Discord when any selected Pack is blocked", async () => {
    const { service, publisher } = await createPublicationService();
    await seedReadyPacks(service, ["alpha"]);

    const preview = await service.preparePackPublication({ packIds: ["alpha", "beta"] });
    expect(preview.valid).toBe(false);
    expect(preview.packs.find((pack) => pack.id === "beta")?.publication.blockers.map((item) => item.code))
      .toEqual(expect.arrayContaining(["pack_incomplete", "missing_staged_images", "capture_session_not_ready"]));
    await expect(service.applyPackPublication(preview.previewId, preview.confirmation))
      .rejects.toMatchObject({ code: "pack_publication_blocked" });
    expect(publisher.attempts).toEqual([]);
    expect(service.releases.listReleases("alpha")).toEqual([]);
  });

  it("rejects a stale combined preview before the first external action", async () => {
    const { service, publisher } = await createPublicationService();
    await seedReadyPacks(service, ["alpha"]);
    const preview = await service.preparePackPublication({ packIds: ["alpha"] });
    const staged = createStagingStore(service.packRenders.stagingRoot).get("asset_a");
    if (staged === null) throw new Error("expected staged Asset A");
    await writeFile(staged.path, "changed after review");

    await expect(service.applyPackPublication(preview.previewId, preview.confirmation))
      .rejects.toMatchObject({ code: "pack_publication_state_changed" });
    expect(publisher.attempts).toEqual([]);
    expect(service.releases.listReleases("alpha")).toEqual([]);
  });

  it("reports truthful partial completion, leaves the failed Release resumable, and skips later Packs", async () => {
    const { service, publisher } = await createPublicationService();
    await seedReadyPacks(service, ["alpha", "beta", "gamma"]);
    publisher.setFailure("422222222222222222");
    const preview = await service.preparePackPublication({ packIds: ["alpha", "beta", "gamma"] });

    const result = await service.applyPackPublication(preview.previewId, preview.confirmation);
    expect(result).toMatchObject({
      outcome: "partially_published",
      failed: { outcome: "publish_interrupted", packId: "beta", failedAssetId: "asset_b" },
      notAttemptedPackIds: ["gamma"],
      cleanupWarnings: [],
      effects: { releasesCreated: 2, packsReset: ["alpha"] },
    });
    expect(result.published.map((item) => item.packId)).toEqual(["alpha"]);
    expect(publisher.attempts).toEqual(["411111111111111111", "422222222222222222"]);
    expect(service.releases.listReleases("alpha")[0]?.publishedAt).not.toBeNull();
    expect(service.releases.listReleases("beta")[0]?.publishedAt).toBeNull();
    expect(service.releases.listReleases("gamma")).toEqual([]);

    publisher.setFailure(null);
    const resumed = await service.resumePackPublication("beta", "RESUME BETA");
    expect(resumed).toMatchObject({ result: { ok: true, outcome: "resumed", packId: "beta" }, cleanupWarnings: [] });
    expect(publisher.posts).toEqual(["411111111111111111", "422222222222222222"]);
    const state = await service.packWorkspaceState();
    expect(state.packs.find((pack) => pack.id === "alpha")?.capturedCount).toBe(0);
    expect(state.packs.find((pack) => pack.id === "beta")?.capturedCount).toBe(0);
    expect(state.packs.find((pack) => pack.id === "gamma")?.capturedCount).toBe(1);
  });

  it("requires an explicit supersession policy before publishing fresh past an interrupted Release", async () => {
    const { service, publisher } = await createPublicationService();
    await seedReadyPacks(service, ["alpha"]);
    publisher.setFailure("411111111111111111");
    const firstPreview = await service.preparePackPublication({ packIds: ["alpha"] });
    const interrupted = await service.applyPackPublication(firstPreview.previewId, firstPreview.confirmation);
    expect(interrupted).toMatchObject({
      outcome: "failed",
      failed: { outcome: "publish_interrupted", packId: "alpha" },
    });

    publisher.setFailure(null);
    const blocked = await service.preparePackPublication({ packIds: ["alpha"] });
    expect(blocked).toMatchObject({
      valid: false,
      packs: [{
        id: "alpha",
        action: "publish",
        publication: { state: "interrupted", ready: false },
      }],
    });
    expect(blocked.packs[0]?.publication.blockers.map((blocker) => blocker.code))
      .toContain("interrupted_release_exists");

    const superseded = await service.preparePackPublication({
      packIds: ["alpha"],
      supersedePackIds: ["alpha"],
    });
    expect(superseded).toMatchObject({
      valid: true,
      supersedePackIds: ["alpha"],
      packs: [{ id: "alpha", action: "supersede", publication: { ready: true } }],
    });
    const published = await service.applyPackPublication(superseded.previewId, superseded.confirmation);
    expect(published).toMatchObject({ outcome: "published", selectedPackIds: ["alpha"] });
    const releases = service.releases.listReleases("alpha");
    expect(releases).toHaveLength(2);
    expect(releases.filter((release) => release.publishedAt === null)).toHaveLength(1);
    expect(releases.filter((release) => release.publishedAt !== null)).toHaveLength(1);
  });

  it("keeps publication disabled without a configured publisher while still surfacing exact blockers", async () => {
    const repositoryRoot = await publicationRepository();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-publication-disabled-"));
    cleanup.push(workspaceRoot);
    const service = await AdminService.create({ repositoryRoot, workspaceRoot });
    await seedReadyPacks(service, ["alpha"]);
    const state = await service.packWorkspaceState();
    const alpha = state.packs.find((pack) => pack.id === "alpha");
    expect(state.publishAvailable).toBe(false);
    expect(alpha?.publication.ready).toBe(false);
    expect(alpha?.publication.blockers).toContainEqual({ code: "discord_unavailable" });
  });
});

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Pack } from "../packs/packs.ts";
import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import { AdminPackCaptureSessionWorkspace } from "./admin-pack-capture-session-workspace.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const pack: Pack = Object.freeze({
  id: "crypto",
  display: "Crypto",
  channel: "crypto",
  assets: Object.freeze(["btc", "eth"]),
});
const resolver = createResolver(buildRegistry({
  btc: {
    tradingView: "CRYPTO:BTCUSD",
    display: "Bitcoin / U.S. Dollar",
    currency: "USD",
    channel: "crypto",
  },
  eth: {
    tradingView: "CRYPTO:ETHUSD",
    display: "Ethereum / U.S. Dollar",
    currency: "USD",
    channel: "crypto",
  },
}, { crypto: "123" }));

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "visionx-capture-session-workspace-"));
  const downloads = await mkdtemp(join(tmpdir(), "visionx-chart-downloads-"));
  cleanup.push(workspace, downloads);
  return {
    downloads,
    sessions: await AdminPackCaptureSessionWorkspace.open(workspace, downloads),
  };
}

function now(hour: number, minute: number): Date {
  return new Date(2026, 6, 23, hour, minute, 0, 0);
}

describe("Admin Pack capture sessions", () => {
  it("requires an explicitly configured non-symlink Downloads folder", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "visionx-capture-session-workspace-"));
    cleanup.push(workspace);
    const sessions = await AdminPackCaptureSessionWorkspace.open(workspace);
    expect(await sessions.state(pack)).toMatchObject({
      configured: false,
      active: false,
      readinessReason: "downloads_folder_not_configured",
    });
    await expect(sessions.start(pack, now(10, 0))).rejects.toMatchObject({
      code: "chart_downloads_not_configured",
    });
  });

  it("persists a configurable Downloads folder and can clear only capture-session baselines", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "visionx-capture-session-workspace-"));
    const downloads = await mkdtemp(join(tmpdir(), "visionx-chart-downloads-configured-"));
    cleanup.push(workspace, downloads);
    const sessions = await AdminPackCaptureSessionWorkspace.open(workspace);

    expect(await sessions.configureDownloadsRoot(downloads)).toBe(await realpath(downloads));
    expect((await sessions.state(pack)).configured).toBe(true);
    await sessions.start(pack, now(10, 0));
    expect(await sessions.clearAllSessions()).toBe(1);
    expect(await sessions.state(pack)).toMatchObject({ configured: true, active: false });

    const reopened = await AdminPackCaptureSessionWorkspace.open(workspace);
    expect(reopened.downloadsRoot).toBe(await realpath(downloads));
  });

  it("snapshots the folder baseline so pre-session charts are never queued", async () => {
    const { downloads, sessions } = await fixture();
    await writeFile(join(downloads, "BTCUSD_2026-07-22_09-00-00.png"), Buffer.from("old btc"));
    await sessions.start(pack, now(10, 0));

    const plan = await sessions.planScan(pack, resolver, now(10, 15));
    expect(plan.queued).toEqual([]);
    expect(plan.ignored).toContainEqual({
      filename: "BTCUSD_2026-07-22_09-00-00.png",
      reason: "baseline_unchanged",
    });
  });

  it("queues the newest eligible export for every Pack Asset in canonical order", async () => {
    const { downloads, sessions } = await fixture();
    const started = await sessions.start(pack, now(10, 0));
    await writeFile(join(downloads, "BTCUSD_2026-07-23_10-05-00.png"), Buffer.from("btc v1"));
    await writeFile(join(downloads, "BTCUSD_2026-07-23_10-10-00.png"), Buffer.from("btc v2"));
    await writeFile(join(downloads, "ETHUSD_2026-07-23_10-08-00.png"), Buffer.from("eth v1"));

    const plan = await sessions.planScan(pack, resolver, now(10, 15));
    expect(plan.sessionId).toBe(started.sessionId);
    expect(plan.queued.map((item) => [item.assetId, item.filename])).toEqual([
      ["btc", "BTCUSD_2026-07-23_10-10-00.png"],
      ["eth", "ETHUSD_2026-07-23_10-08-00.png"],
    ]);
  });

  it("rejects exports whose embedded TradingView timestamp is outside the current session", async () => {
    const { downloads, sessions } = await fixture();
    await sessions.start(pack, now(10, 0));
    await writeFile(join(downloads, "BTCUSD_2026-07-22_10-02-00.png"), Buffer.from("yesterday"));

    const plan = await sessions.planScan(pack, resolver, now(10, 15));
    expect(plan.queued).toEqual([]);
    expect(plan.ignored).toContainEqual({
      filename: "BTCUSD_2026-07-22_10-02-00.png",
      reason: "outside_session_window",
    });
  });

  it("treats the same source hash as a no-op and queues only a genuinely newer Asset", async () => {
    const { downloads, sessions } = await fixture();
    const started = await sessions.start(pack, now(10, 0));
    await writeFile(join(downloads, "BTCUSD_2026-07-23_10-05-00.png"), Buffer.from("btc v1"));
    await writeFile(join(downloads, "ETHUSD_2026-07-23_10-06-00.png"), Buffer.from("eth v1"));
    const first = await sessions.planScan(pack, resolver, now(10, 10));
    await sessions.commitScan(pack, started.sessionId ?? "", first.queued.map((item, index) => ({
      ...item,
      previewId: String(index + 1).padStart(32, "a"),
    })));

    const unchanged = await sessions.planScan(pack, resolver, now(10, 15));
    expect(unchanged.queued).toEqual([]);
    expect(unchanged.unchangedAssetIds).toEqual(["btc", "eth"]);

    await writeFile(join(downloads, "BTCUSD_2026-07-23_10-20-00.png"), Buffer.from("btc v2"));
    const update = await sessions.planScan(pack, resolver, now(10, 25));
    expect(update.queued.map((item) => item.assetId)).toEqual(["btc"]);
    expect(update.unchangedAssetIds).toEqual(["eth"]);
  });

  it("reports complete same-session coverage within the maximum export span", async () => {
    const { downloads, sessions } = await fixture();
    const started = await sessions.start(pack, now(10, 0));
    await writeFile(join(downloads, "BTCUSD_2026-07-23_10-05-00.png"), Buffer.from("btc"));
    await writeFile(join(downloads, "ETHUSD_2026-07-23_10-55-00.png"), Buffer.from("eth"));
    const plan = await sessions.planScan(pack, resolver, now(11, 0));
    const queued = plan.queued.map((item, index) => ({
      ...item,
      previewId: `${index + 1}`.repeat(32),
    }));
    let state = await sessions.commitScan(pack, started.sessionId ?? "", queued);
    expect(state).toMatchObject({
      publishReady: false,
      pendingCount: 2,
      readinessReason: "previews_pending",
    });
    await sessions.markAccepted(queued[0]?.previewId ?? "", 1, now(11, 1));
    await sessions.markAccepted(queued[1]?.previewId ?? "", 1, now(11, 2));
    state = await sessions.state(pack);
    expect(state).toMatchObject({
      publishReady: true,
      acceptedCount: 2,
      pendingCount: 0,
      exportSpanMinutes: 50,
      readinessReason: "ready",
    });
  });

  it("removes only a discarded pending preview from the session queue", async () => {
    const { downloads, sessions } = await fixture();
    const started = await sessions.start(pack, now(10, 0));
    await writeFile(join(downloads, "BTCUSD_2026-07-23_10-05-00.png"), Buffer.from("btc"));
    const plan = await sessions.planScan(pack, resolver, now(10, 10));
    const previewId = "a".repeat(32);
    await sessions.commitScan(pack, started.sessionId ?? "", [{
      ...plan.queued[0]!,
      previewId,
    }]);
    await sessions.removePendingPreview(previewId);
    expect(await sessions.state(pack)).toMatchObject({
      candidateCount: 0,
      pendingCount: 0,
      missingAssetIds: ["btc", "eth"],
    });
  });

  it("removes matching accepted revisions so deletion or reset cannot leave false readiness", async () => {
    const { downloads, sessions } = await fixture();
    const started = await sessions.start(pack, now(10, 0));
    await writeFile(join(downloads, "BTCUSD_2026-07-23_10-05-00.png"), Buffer.from("btc"));
    await writeFile(join(downloads, "ETHUSD_2026-07-23_10-06-00.png"), Buffer.from("eth"));
    const plan = await sessions.planScan(pack, resolver, now(10, 10));
    const queued = plan.queued.map((item, index) => ({
      ...item,
      previewId: `${index + 1}`.repeat(32),
    }));
    await sessions.commitScan(pack, started.sessionId ?? "", queued);
    await sessions.markAccepted(queued[0]?.previewId ?? "", 2, now(10, 11));
    await sessions.markAccepted(queued[1]?.previewId ?? "", 1, now(10, 12));
    expect((await sessions.state(pack)).publishReady).toBe(true);

    await sessions.removeAcceptedRevision("crypto", "btc", 1);
    expect((await sessions.state(pack)).publishReady).toBe(true);
    await sessions.removeAcceptedRevision("crypto", "btc", 2);
    expect(await sessions.state(pack)).toMatchObject({
      publishReady: false,
      acceptedCount: 1,
      missingAssetIds: ["btc"],
      readinessReason: "assets_missing",
    });

    await sessions.clearAcceptedAssets("crypto", ["eth"]);
    expect(await sessions.state(pack)).toMatchObject({
      acceptedCount: 0,
      missingAssetIds: ["btc", "eth"],
    });
  });
});

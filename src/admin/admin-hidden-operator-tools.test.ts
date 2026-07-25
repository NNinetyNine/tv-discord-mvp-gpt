import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AdminService } from "./admin-service.ts";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(async (path) => { await rm(path, { recursive: true, force: true }); })); });

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "visionx-hidden-tools-repo-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-hidden-tools-workspace-"));
  const downloadsRoot = await mkdtemp(join(tmpdir(), "visionx-hidden-tools-downloads-"));
  cleanup.push(repositoryRoot, workspaceRoot, downloadsRoot);
  await Promise.all([
    cp(resolve("definitions"), join(repositoryRoot, "definitions"), { recursive: true }),
    cp(resolve("config"), join(repositoryRoot, "config"), { recursive: true }),
    mkdir(join(repositoryRoot, "assets"), { recursive: true }),
  ]);
  const packsPath = join(repositoryRoot, "definitions/packs.json");
  const packsText = await readFile(packsPath, "utf8");
  if (!packsText.includes('"asts", "aapl", "axp"')) throw new Error("stocks fixture missing");
  await writeFile(packsPath, packsText.replace('"asts", "aapl", "axp"', '"asts", "axp"'));
  return {
    repositoryRoot,
    workspaceRoot,
    downloadsRoot,
    service: await AdminService.create({ repositoryRoot, workspaceRoot, chartDownloadsRoot: downloadsRoot }),
  };
}

describe("Administration existing Pack, alias, audit, and Release surfaces", () => {
  it("applies reviewed current-Pack maintenance and governed alias changes", async () => {
    const { service } = await fixture();
    const maintenance = await service.packMaintenanceState() as any;
    expect(maintenance.heldAssets.map((asset: any) => asset.id)).toContain("aapl");
    const stocks = maintenance.packs.find((pack: any) => pack.id === "stocks");
    const nextOrder = maintenance.packs.map((pack: any) => pack.id);
    nextOrder.splice(nextOrder.indexOf("stocks"), 1);
    nextOrder.unshift("stocks");

    const preview = await service.preparePackMaintenance({
      operation: "update",
      packId: "stocks",
      displayName: "Equities",
      logicalChannel: "",
      assetIds: [...stocks.assetIds, "aapl"],
      packOrder: nextOrder,
    });
    expect(preview).toMatchObject({
      ready: true,
      confirmation: "APPLY PACK STOCKS",
      changes: expect.not.arrayContaining([expect.objectContaining({ field: "logicalChannel" })]),
    });
    await service.applyPackMaintenance(preview.previewId, preview.confirmation);
    expect(service.getPack("stocks")).toMatchObject({ displayName: "Equities", membershipCount: stocks.assetIds.length + 1 });
    expect(service.getPack("stocks").assets.at(-1)?.id).toBe("aapl");
    expect(service.listPacks()[0]?.id).toBe("stocks");

    const alias = await service.prepareRegistryAliasChange("aapl", { assetId: "aapl", operation: "add", alias: "APPLE_ALT" });
    await service.applyRegistryAliasChange("aapl", alias.previewId, alias.confirmation);
    expect(service.getAsset("aapl").tradingViewAliases).toContain("APPLE_ALT");

    const remove = await service.prepareRegistryAliasChange("aapl", { assetId: "aapl", operation: "remove", alias: "apple_alt" });
    expect(remove.alias).toBe("APPLE_ALT");
    await service.applyRegistryAliasChange("aapl", remove.previewId, remove.confirmation);
    expect(service.getAsset("aapl").tradingViewAliases ?? []).not.toContain("APPLE_ALT");
  });

  it("audits configured exports read-only and browses historical Release custody", async () => {
    const { service, workspaceRoot, downloadsRoot } = await fixture();
    await Promise.all([
      writeFile(join(downloadsRoot, "AAPL_2026-07-23_21-00-00.png"), "one"),
      writeFile(join(downloadsRoot, "AAPL_2026-07-23_21-05-00.png"), "two"),
      writeFile(join(downloadsRoot, "UNKNOWN_2026-07-23_21-10-00.png"), "three"),
    ]);
    const exports = await service.auditChartExports() as any;
    expect(exports).toMatchObject({ scannedCount: 3, resolvedCount: 2, unresolvedCount: 1, duplicateGroupCount: 1 });
    expect(exports.effects).toEqual({ repositoryChanged: false, workspaceChanged: false, stagingChanged: false, discordContacted: false });

    const source = join(workspaceRoot, "archived-source.png");
    await writeFile(source, "archived-image");
    const release = service.releases.createThreadedRelease({
      packId: "retired_pack",
      packDisplay: "Retired Pack",
      forumChannelId: "177777777777777777",
      startedAt: "2026-07-23T21:00:00.000Z",
      analyses: [{ assetId: "aapl", display: "Apple", capturedAt: "2026-07-23T20:59:00.000Z", sourceImagePath: source, threadId: "188888888888888888" }],
    });
    service.releases.recordPost("retired_pack", release.releaseId, "aapl", "199999999999999999", "2026-07-23T21:01:00.000Z");
    service.releases.markPublished("retired_pack", release.releaseId, "2026-07-23T21:02:00.000Z");

    const archive = service.releaseArchiveState() as any;
    expect(archive).toMatchObject({ releaseCount: 1, publishedCount: 1, interruptedCount: 0 });
    expect(archive.releases[0]).toMatchObject({ packId: "retired_pack", packCurrent: false, state: "published" });
    const detail = service.releaseArchiveDetail("retired_pack", release.releaseId) as any;
    expect(detail.analyses[0]).toMatchObject({ assetId: "aapl", threadId: "188888888888888888", discordMessageId: "199999999999999999" });
    expect(service.releaseRecordBytes("retired_pack", release.releaseId).toString("utf8")).toContain(release.releaseId);
    expect((await service.releaseImageBytes("retired_pack", release.releaseId, "aapl.png")).toString("utf8")).toBe("archived-image");
  });
});

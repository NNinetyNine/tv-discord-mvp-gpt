import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminPackRenderWorkspace, type PackRenderPreviewTask } from "./admin-pack-render-workspace.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "visionx-pack-render-workspace-"));
  cleanup.push(value);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function renderedTask(workspace: AdminPackRenderWorkspace): Promise<{
  readonly task: PackRenderPreviewTask;
  readonly output: Buffer;
  readonly receipt: Buffer;
}> {
  const task = await workspace.createPreview(
    "BTCUSD_2026-07-22_18-58-01.png",
    Buffer.from("TRADINGVIEW SOURCE"),
  );
  const output = Buffer.from("VISIONX PUBLICATION");
  const receipt = Buffer.from('{"receipt":true}\n');
  await writeFile(task.outputPath, output);
  await writeFile(task.receiptPath, receipt);
  await workspace.finalizePreview(task, {
    packId: "crypto",
    assetId: "btc",
    sourceBasename: "BTCUSD_2026-07-22_18-58-01.png",
    timeframe: "1D",
    dataAsOf: "2026-07-22",
    outputSha256: sha256(output),
    registrySourceSha256: "a".repeat(64),
    packSourceSha256: "b".repeat(64),
    channelConfigurationSha256: "c".repeat(64),
  });
  return { task, output, receipt };
}

describe("Admin Pack render workspace", () => {
  it("preserves immutable preview evidence and transitions one claim exactly once", async () => {
    const workspace = await AdminPackRenderWorkspace.open(await root());
    const { task, output, receipt } = await renderedTask(workspace);

    expect(task.previewId).toMatch(/^[a-f0-9]{32}$/u);
    expect(await workspace.readPreviewArtifact(task.previewId, "publication.png")).toEqual(output);
    expect(await workspace.readPreviewArtifact(task.previewId, "receipt.json")).toEqual(receipt);

    const claimed = await workspace.claimPreview(task.previewId);
    expect(claimed.record).toMatchObject({ packId: "crypto", assetId: "btc", timeframe: "1D" });
    await expect(workspace.readPreviewArtifact(task.previewId, "publication.png")).rejects.toMatchObject({ code: "pack_render_preview_not_found" });

    await workspace.releaseClaim(task.previewId);
    expect(await workspace.readPreviewArtifact(task.previewId, "publication.png")).toEqual(output);
    await workspace.claimPreview(task.previewId);
    await workspace.completeClaim(task.previewId);
    await expect(workspace.claimPreview(task.previewId)).rejects.toMatchObject({ code: "pack_render_preview_not_found" });
    expect(await readFile(join(workspace.root, "accepted", task.previewId, "publication.png"))).toEqual(output);
  });

  it("detects evidence tampering before display or acceptance", async () => {
    const workspace = await AdminPackRenderWorkspace.open(await root());
    const { task } = await renderedTask(workspace);
    await writeFile(task.outputPath, Buffer.from("changed"));

    await expect(workspace.readPreviewArtifact(task.previewId, "publication.png")).rejects.toMatchObject({
      code: "invalid_pack_render_preview",
    });
    await expect(workspace.claimPreview(task.previewId)).rejects.toMatchObject({
      code: "invalid_pack_render_preview",
    });
    expect(await readFile(task.receiptPath)).toEqual(Buffer.from('{"receipt":true}\n'));
  });

  it("discards only an unaccepted preview", async () => {
    const workspace = await AdminPackRenderWorkspace.open(await root());
    const keep = await renderedTask(workspace);
    const discard = await renderedTask(workspace);

    await workspace.discardPreview(discard.task.previewId);

    expect(await workspace.readPreviewArtifact(keep.task.previewId, "publication.png")).toEqual(keep.output);
    await expect(workspace.readPreviewArtifact(discard.task.previewId, "publication.png")).rejects.toMatchObject({
      code: "pack_render_preview_not_found",
    });
  });

  it("rejects unsafe source inputs and a symlinked Pack workspace root", async () => {
    const workspaceRoot = await root();
    const workspace = await AdminPackRenderWorkspace.open(workspaceRoot);
    await expect(workspace.createPreview("../BTCUSD.png", Buffer.from("x"))).rejects.toMatchObject({
      code: "invalid_pack_render_preview",
    });
    await expect(workspace.createPreview("BTCUSD.png", Buffer.alloc(0))).rejects.toMatchObject({
      code: "invalid_pack_render_preview",
    });

    const symlinkRoot = await root();
    const target = await root();
    await symlink(target, join(symlinkRoot, "pack-workspace"), "dir");
    await expect(AdminPackRenderWorkspace.open(symlinkRoot)).rejects.toMatchObject({ code: "workspace_path_unsafe" });
  });
});

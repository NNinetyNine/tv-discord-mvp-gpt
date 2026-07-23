import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkspace } from "../packs/workspace.ts";
import { AdminPackRenderWorkspace } from "./admin-pack-render-workspace.ts";
import { AdminPackRevisionWorkspace } from "./admin-pack-revision-workspace.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "visionx-pack-revision-workspace-"));
  cleanup.push(value);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function acceptedPreview(
  renders: AdminPackRenderWorkspace,
  date: string,
  outputLabel: string,
) {
  const task = await renders.createPreview(
    `BTCUSD_${date}_18-58-01.png`,
    Buffer.from(`SOURCE ${date}`),
  );
  const output = Buffer.from(`PUBLICATION ${outputLabel}`);
  const receipt = Buffer.from(`{"date":"${date}"}\n`);
  await writeFile(task.outputPath, output);
  await writeFile(task.receiptPath, receipt);
  await renders.finalizePreview(task, {
    packId: "crypto",
    assetId: "btc",
    sourceBasename: `BTCUSD_${date}_18-58-01.png`,
    timeframe: "1D",
    dataAsOf: date,
    outputSha256: sha256(output),
    registrySourceSha256: "a".repeat(64),
    packSourceSha256: "b".repeat(64),
    channelConfigurationSha256: "c".repeat(64),
  });
  return { claimed: await renders.claimPreview(task.previewId), output, receipt };
}

describe("Admin Pack revision workspace", () => {
  it("preserves confirmed revision evidence and deletes exactly one selected revision", async () => {
    const workspaceRoot = await root();
    const renders = await AdminPackRenderWorkspace.open(workspaceRoot);
    const revisions = await AdminPackRevisionWorkspace.open(workspaceRoot);
    const first = await acceptedPreview(renders, "2026-07-22", "ONE");
    const second = await acceptedPreview(renders, "2026-07-23", "TWO");

    await revisions.commit(first.claimed, 1, "2026-07-22T20:00:00.000Z");
    await renders.completeClaim(first.claimed.record.previewId);
    await revisions.commit(second.claimed, 2, "2026-07-23T20:00:00.000Z");
    await renders.completeClaim(second.claimed.record.previewId);

    expect((await revisions.list("crypto", "btc")).map((entry) => entry.revision)).toEqual([1, 2]);
    expect(await revisions.readArtifact("crypto", "btc", 1, "publication.png")).toEqual(first.output);
    expect(await revisions.readArtifact("crypto", "btc", 2, "receipt.json")).toEqual(second.receipt);

    await revisions.delete("crypto", "btc", 1);
    expect((await revisions.list("crypto", "btc")).map((entry) => entry.revision)).toEqual([2]);
    expect(await revisions.readArtifact("crypto", "btc", 2, "publication.png")).toEqual(second.output);
    await expect(revisions.readArtifact("crypto", "btc", 1, "publication.png")).rejects.toMatchObject({
      code: "pack_revision_not_found",
    });
  });

  it("reconstructs only the active Workspace instance from retained accepted evidence", async () => {
    const workspaceRoot = await root();
    const renders = await AdminPackRenderWorkspace.open(workspaceRoot);
    const revisions = await AdminPackRevisionWorkspace.open(workspaceRoot);
    const old = await acceptedPreview(renders, "2026-07-20", "OLD");
    await renders.completeClaim(old.claimed.record.previewId);
    const current = await acceptedPreview(renders, "2026-07-23", "CURRENT");
    await renders.completeClaim(current.claimed.record.previewId);

    const workspace = createWorkspace([
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] },
    ], [{ assetId: "btc", capturedAt: "2026-07-23T21:00:00.000Z", revisions: 1 }]);
    await revisions.reconcile(workspace, await renders.listAcceptedPreviews());

    const history = await revisions.list("crypto", "btc");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      revision: 1,
      previewId: current.claimed.record.previewId,
      dataAsOf: "2026-07-23",
    });
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkspace } from "../packs/workspace.ts";
import { createStagingStore } from "../wiring/staging.ts";
import { resetPackWorkspaceAsset, resetPackWorkspacePack } from "./reset-pack-workspace.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-pack-workspace-reset-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runtime() {
  const workspace = createWorkspace([
    { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
    { id: "stocks", display: "Stocks", channel: "stocks", assets: ["aapl"] },
  ]);
  const staging = createStagingStore(join(root, "staging"));
  const source = join(root, "source.png");
  writeFileSync(source, Buffer.from("publication"));
  return { workspace, staging, source };
}

describe("reset Pack Workspace", () => {
  it("resets one confirmed Asset, clears its stage, and preserves every other Analysis", () => {
    const { workspace, staging, source } = runtime();
    workspace.capture("btc", "t1");
    workspace.capture("btc", "t2");
    workspace.capture("eth", "t3");
    staging.stage("btc", source);
    staging.stage("eth", source);

    const result = resetPackWorkspaceAsset(
      { packId: "crypto", assetId: "btc", expectedRevisions: 2 },
      { workspace, staging },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: "asset_reset",
      resetAssetIds: ["btc"],
      packState: "building",
      capturedCount: 1,
      remainingRequiredAssetIds: ["btc"],
      stagedArtifactCount: 1,
      stagingCleared: true,
    });
    expect(workspace.captureOf("btc")).toBeNull();
    expect(workspace.captureOf("eth")?.revisions).toBe(1);
    expect(staging.has("btc")).toBe(false);
    expect(readFileSync(staging.get("eth")!.path)).toEqual(Buffer.from("publication"));
  });

  it("rejects stale Asset confirmation without changing Workspace or staging", () => {
    const { workspace, staging, source } = runtime();
    workspace.capture("btc", "t1");
    workspace.capture("btc", "t2");
    staging.stage("btc", source);

    const result = resetPackWorkspaceAsset(
      { packId: "crypto", assetId: "btc", expectedRevisions: 1 },
      { workspace, staging },
    );

    expect(result).toMatchObject({ ok: false, outcome: "state_conflict" });
    expect(workspace.captureOf("btc")?.revisions).toBe(2);
    expect(staging.has("btc")).toBe(true);
  });

  it("reports failed Asset staging cleanup without restoring discarded Workspace work", () => {
    const { workspace, staging, source } = runtime();
    workspace.capture("btc", "t1");
    staging.stage("btc", source);
    const failingStaging = {
      ...staging,
      unstage: () => { throw new Error("simulated cleanup failure"); },
    };

    const result = resetPackWorkspaceAsset(
      { packId: "crypto", assetId: "btc", expectedRevisions: 1 },
      { workspace, staging: failingStaging },
    );

    expect(result).toMatchObject({ ok: true, outcome: "asset_reset", stagingCleared: false });
    expect(workspace.captureOf("btc")).toBeNull();
    expect(staging.has("btc")).toBe(true);
  });

  it("resets one confirmed Pack while preserving another Pack and held work", () => {
    const { workspace, staging, source } = runtime();
    workspace.capture("btc", "t1");
    workspace.capture("eth", "t2");
    workspace.capture("aapl", "t3");
    workspace.capture("held", "t4");
    for (const assetId of ["btc", "eth", "aapl"]) staging.stage(assetId, source);

    const result = resetPackWorkspacePack(
      { packId: "crypto", expectedCapturedAssetIds: ["btc", "eth"] },
      { workspace, staging },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: "pack_reset",
      resetAssetIds: ["btc", "eth"],
      packState: "empty",
      capturedCount: 0,
      remainingRequiredAssetIds: ["btc", "eth"],
      stagedArtifactCount: 2,
      stagingCleared: true,
    });
    expect(workspace.captureOf("aapl")).not.toBeNull();
    expect(workspace.captureOf("held")).not.toBeNull();
    expect(staging.has("aapl")).toBe(true);
  });

  it("rejects stale Pack confirmation without partial reset", () => {
    const { workspace, staging, source } = runtime();
    workspace.capture("btc", "t1");
    workspace.capture("eth", "t2");
    staging.stage("btc", source);

    const result = resetPackWorkspacePack(
      { packId: "crypto", expectedCapturedAssetIds: ["btc"] },
      { workspace, staging },
    );

    expect(result).toMatchObject({ ok: false, outcome: "state_conflict" });
    expect(workspace.capturedFor("crypto").map((capture) => capture.assetId)).toEqual(["btc", "eth"]);
    expect(staging.has("btc")).toBe(true);
  });

  it("verifies Pack staging is actually empty after cleanup returns", () => {
    const { workspace, staging, source } = runtime();
    workspace.capture("btc", "t1");
    staging.stage("btc", source);
    const ineffectiveStaging = { ...staging, clear: () => undefined };

    const result = resetPackWorkspacePack(
      { packId: "crypto", expectedCapturedAssetIds: ["btc"] },
      { workspace, staging: ineffectiveStaging },
    );

    expect(result).toMatchObject({ ok: true, outcome: "pack_reset", stagingCleared: false });
    expect(workspace.packState("crypto")).toBe("empty");
    expect(staging.has("btc")).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pack } from "../packs/packs.ts";
import type { Snapshot, SnapshotSource } from "../snapshot/snapshot.ts";
import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import { createWorkspace, type Workspace } from "../packs/workspace.ts";
import { createPersistentWorkspace } from "../packs/persistence.ts";
import { createStagingStore, type StagingStore } from "./staging.ts";
import { captureOnce, type CaptureOnceDeps } from "./capture-once.ts";

// ---- fixtures (independent of config/*.json) -------------------------------

const channels = { crypto: "", stocks: "", indices: "" };
const registryData = {
  btc:  { tradingView: "BTCUSD", display: "Bitcoin",  channel: "crypto" },
  eth:  { tradingView: "ETHUSD", display: "Ethereum", channel: "crypto" },
  aapl: { tradingView: "AAPL",   display: "Apple",    channel: "stocks" },
  spx:  { tradingView: "SPX",    display: "S&P 500",  channel: "indices" }, // in registry, in NO pack
};
const resolver = createResolver(buildRegistry(registryData, channels));

const packs: Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", assets: ["aapl"] },
];

const passValidator: CaptureOnceDeps["validate"] = () => ({ ok: true, checks: { notBlank: true } });
const failValidator: CaptureOnceDeps["validate"] = () => ({ ok: false, checks: { notBlank: false }, reason: "blank image" });

/** A fake SnapshotSource (no real ingest/browser) returning a chosen Snapshot. */
function fakeSource(opts: {
  filename: string;
  imagePath: string;
  capturedAt?: string;
  fail?: boolean;
}): SnapshotSource {
  return {
    async capture(): Promise<Snapshot> {
      if (opts.fail) throw new Error("capture boom");
      return {
        imagePath: opts.imagePath,
        capturedAt: opts.capturedAt ?? "2026-06-25T01:00:00.000Z",
        suggestedFilename: opts.filename,
      };
    },
  };
}

// ---- shared temp state ------------------------------------------------------

let stagingBase: string;
let srcDir: string;
let imagePath: string; // a real source PNG that exists on disk
let staging: StagingStore;

beforeEach(() => {
  stagingBase = mkdtempSync(join(tmpdir(), "visionx-orch-staging-"));
  srcDir = mkdtempSync(join(tmpdir(), "visionx-orch-src-"));
  imagePath = join(srcDir, "snap.png");
  writeFileSync(imagePath, "PNGDATA", "utf8");
  staging = createStagingStore(stagingBase);
});
afterEach(() => {
  rmSync(stagingBase, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

function deps(
  source: SnapshotSource,
  validate: CaptureOnceDeps["validate"],
  workspace: Workspace,
): CaptureOnceDeps {
  return { capturer: source, resolver, workspace, staging, validate };
}

/** Snapshot of all observable Workspace + Staging state, for invariant checks. */
function snap(workspace: Workspace) {
  return {
    captured: workspace.captures().map((c) => c.assetId).sort(),
    staging: staging.list().map((s) => s.assetId),
  };
}

// ---- accept path ------------------------------------------------------------

describe("captureOnce — accept path (routing by identity)", () => {
  it("stages a valid capture and records the fact on the workspace", async () => {
    const workspace = createWorkspace(packs);
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), passValidator, workspace),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome).toBe("staged");
      expect(r.asset.id).toBe("btc");
      expect(r.revisions).toBe(1);
      expect(existsSync(r.stagedPath)).toBe(true);
    }
    expect(workspace.captureOf("btc")).not.toBeNull();
    expect(workspace.packState("crypto")).toBe("building");
    expect(staging.has("btc")).toBe(true);
  });

  it("recapture increments revisions (replacement derived as revisions > 1) without duplicating", async () => {
    const workspace = createWorkspace(packs);
    await captureOnce(deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), passValidator, workspace));
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_02-00-00.png", imagePath }), passValidator, workspace),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.revisions).toBe(2);
      expect(r.revisions > 1).toBe(true); // "replaced", derived
    }
    expect(workspace.captures()).toHaveLength(1);
    expect(staging.list().map((s) => s.assetId)).toEqual(["btc"]);
  });

  it("captures an asset from ANY pack — no active-pack gate exists", async () => {
    const workspace = createWorkspace(packs);
    const r = await captureOnce(
      deps(fakeSource({ filename: "AAPL_2026-06-25_01-21-06.png", imagePath }), passValidator, workspace),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe("aapl");
    // Membership affected only what it counts toward: stocks is now complete.
    expect(workspace.packState("stocks")).toBe("complete");
    expect(workspace.packState("crypto")).toBe("empty");
  });

  it("captures an asset in NO pack — held work simply exists (§4.6)", async () => {
    const workspace = createWorkspace(packs);
    const r = await captureOnce(
      deps(fakeSource({ filename: "SPX_2026-06-25_01-30-00.png", imagePath }), passValidator, workspace),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe("spx");
    expect(workspace.captureOf("spx")).not.toBeNull();
    expect(staging.has("spx")).toBe(true);
    // Counts toward nothing: every pack view is unaffected.
    expect(workspace.packState("crypto")).toBe("empty");
    expect(workspace.packState("stocks")).toBe("empty");
  });

  it("auto-persists through the persisted workspace surface", async () => {
    const sessionPath = join(srcDir, "session.json");
    const workspace = createPersistentWorkspace({ packs, path: sessionPath });
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath, capturedAt: "T-CAP" }), passValidator, workspace),
    );

    expect(r.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(sessionPath, "utf8"));
    expect(onDisk.captures.map((c: { assetId: string }) => c.assetId)).toEqual(["btc"]);
    expect(onDisk.captures[0].capturedAt).toBe("T-CAP");
    expect(onDisk.captures[0].revisions).toBe(1);
  });
});

// ---- operational rejections (result shape) ----------------------------------

describe("captureOnce — operational outcomes (result shape)", () => {
  it("capture_failed when the source throws", async () => {
    const workspace = createWorkspace(packs);
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath, fail: true }), passValidator, workspace),
    );
    expect(r).toMatchObject({ ok: false, outcome: "capture_failed" });
  });

  it("unparseable_filename for an empty filename", async () => {
    const workspace = createWorkspace(packs);
    const r = await captureOnce(deps(fakeSource({ filename: "", imagePath }), passValidator, workspace));
    expect(r).toMatchObject({ ok: false, outcome: "unparseable_filename" });
  });

  it("unknown_symbol carries the symbol", async () => {
    const workspace = createWorkspace(packs);
    const r = await captureOnce(
      deps(fakeSource({ filename: "DOGEUSD_2026-06-25_01-30-00.png", imagePath }), passValidator, workspace),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "unknown_symbol") expect(r.symbol).toBe("DOGEUSD");
    else throw new Error("expected unknown_symbol");
  });

  it("validation_failed carries the asset, reason, and checks", async () => {
    const workspace = createWorkspace(packs);
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), failValidator, workspace),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "validation_failed") {
      expect(r.asset.id).toBe("btc");
      expect(r.reason).toMatch(/blank/);
      expect(r.checks).toEqual({ notBlank: false });
    } else throw new Error("expected validation_failed");
  });

  it("staging_failed when the source image is missing", async () => {
    const workspace = createWorkspace(packs);
    const missing = join(srcDir, "does-not-exist.png");
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath: missing }), passValidator, workspace),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "staging_failed") expect(r.asset.id).toBe("btc");
    else throw new Error("expected staging_failed");
  });
});

// ---- invariants: every non-success leaves Workspace AND Staging unchanged ----

describe("captureOnce — invariants (no side effects on non-success)", () => {
  it("capture_failed leaves workspace and staging unchanged", async () => {
    const workspace = createWorkspace(packs);
    const before = snap(workspace);
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath, fail: true }), passValidator, workspace),
    );
    expect(r.ok).toBe(false);
    expect(snap(workspace)).toEqual(before);
  });

  it("unparseable_filename leaves workspace and staging unchanged", async () => {
    const workspace = createWorkspace(packs);
    const before = snap(workspace);
    const r = await captureOnce(deps(fakeSource({ filename: "", imagePath }), passValidator, workspace));
    expect(r.ok).toBe(false);
    expect(snap(workspace)).toEqual(before);
  });

  it("unknown_symbol leaves workspace and staging unchanged", async () => {
    const workspace = createWorkspace(packs);
    const before = snap(workspace);
    const r = await captureOnce(
      deps(fakeSource({ filename: "DOGEUSD_2026-06-25_01-30-00.png", imagePath }), passValidator, workspace),
    );
    expect(r.ok).toBe(false);
    expect(snap(workspace)).toEqual(before);
  });

  it("validation_failed leaves workspace and staging unchanged (nothing staged)", async () => {
    const workspace = createWorkspace(packs);
    const before = snap(workspace);
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), failValidator, workspace),
    );
    expect(r.ok).toBe(false);
    expect(snap(workspace)).toEqual(before);
    expect(staging.has("btc")).toBe(false);
  });

  it("staging_failed leaves the workspace unchanged (capture fact never recorded)", async () => {
    const workspace = createWorkspace(packs);
    const before = snap(workspace);
    const missing = join(srcDir, "does-not-exist.png");
    const r = await captureOnce(
      deps(fakeSource({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath: missing }), passValidator, workspace),
    );
    expect(r.ok).toBe(false);
    expect(snap(workspace)).toEqual(before);
    expect(staging.has("btc")).toBe(false);
  });
});
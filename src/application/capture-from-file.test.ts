import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub branding (sharp side-effects) so the file source's copy+brand stays a
// pure unit-level concern; these tests prove application receipt semantics.
vi.mock("../capture/branding.ts", () => ({ applyBranding: vi.fn(async () => {}) }));

import type { Pack } from "../packs/packs.ts";
import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import { createWorkspace, type Workspace } from "../packs/workspace.ts";
import { createPersistentWorkspace } from "../packs/persistence.ts";
import { createStagingStore, type StagingStore } from "../wiring/staging.ts";
import {
  captureFromFile,
  type CaptureFromFileDeps,
  type CaptureFromFileReceipt,
} from "./capture-from-file.ts";

// ---- fixtures (independent of config/*.json) -------------------------------

const channels = { crypto: "", stocks: "", indices: "" };
const registryData = {
  btc: { tradingView: "BTCUSD", display: "Bitcoin", channel: "crypto" },
  eth: { tradingView: "ETHUSD", display: "Ethereum", channel: "crypto" },
  aapl: { tradingView: "AAPL", display: "Apple", channel: "stocks" },
  brkb: {
    tradingView: "BRK.B",
    display: "Berkshire Hathaway",
    channel: "stocks",
  },
  spx: { tradingView: "SPX", display: "S&P 500", channel: "indices" },
};
const registry = buildRegistry(registryData, channels);
const resolver = createResolver(registry);

const packs: Pack[] = [
  { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", channel: "stocks", assets: ["aapl", "brkb"] },
];

const passValidator: CaptureFromFileDeps["validate"] = () => ({
  ok: true,
  checks: { notBlank: true },
});
const failValidator: CaptureFromFileDeps["validate"] = () => ({
  ok: false,
  checks: { notBlank: false, readable: true },
  reason: "blank image",
});

// ---- temp state -------------------------------------------------------------

let exportDir: string;
let secondExportDir: string;
let outDir: string;
let stagingBase: string;
let staging: StagingStore;

beforeEach(() => {
  exportDir = mkdtempSync(join(tmpdir(), "visionx-cff-export-"));
  secondExportDir = mkdtempSync(join(tmpdir(), "visionx-cff-upload-"));
  outDir = mkdtempSync(join(tmpdir(), "visionx-cff-out-"));
  stagingBase = mkdtempSync(join(tmpdir(), "visionx-cff-staging-"));
  process.env.IMAGE_OUTPUT_DIR = outDir;
  staging = createStagingStore(stagingBase);
});
afterEach(() => {
  rmSync(exportDir, { recursive: true, force: true });
  rmSync(secondExportDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(stagingBase, { recursive: true, force: true });
  delete process.env.IMAGE_OUTPUT_DIR;
  vi.clearAllMocks();
});

function makeExport(name: string, contents = "PNGDATA"): string {
  const path = join(exportDir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

function makeUpload(name: string, contents = "PNGDATA"): string {
  const path = join(secondExportDir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

function importFile(
  filePath: string,
  workspace: Workspace,
  overrides: Partial<Pick<CaptureFromFileDeps, "staging" | "validate">> = {},
): Promise<CaptureFromFileReceipt> {
  return captureFromFile({
    filePath,
    resolver,
    registry,
    workspace,
    staging: overrides.staging ?? staging,
    validate: overrides.validate ?? passValidator,
  });
}

describe("captureFromFile — canonical successful receipt", () => {
  it("returns immutable Pack facts after the first accepted import", async () => {
    const workspace = createWorkspace(packs);
    const filename = "BTCUSD_2026-06-25_01-18-55.png";
    const receipt = await importFile(makeExport(filename), workspace);

    expect(receipt).toEqual({
      ok: true,
      outcome: "staged",
      originalBasename: filename,
      assetId: "btc",
      assetDisplay: "Bitcoin",
      revisions: 1,
      placement: {
        kind: "pack",
        packId: "crypto",
        packDisplay: "Crypto",
        packState: "building",
        capturedCount: 1,
        totalCount: 2,
        remainingRequiredAssets: [{ id: "eth", display: "Ethereum" }],
      },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    if (receipt.ok && receipt.placement.kind === "pack") {
      expect(Object.isFrozen(receipt.placement)).toBe(true);
      expect(Object.isFrozen(receipt.placement.remainingRequiredAssets)).toBe(true);
      expect(Object.isFrozen(receipt.placement.remainingRequiredAssets[0])).toBe(true);
    }
    expect(workspace.captureOf("btc")?.revisions).toBe(1);
    expect(staging.has("btc")).toBe(true);
  });

  it("re-imports as one current capture, increments revision, and replaces the staged image", async () => {
    const workspace = createWorkspace(packs);
    await importFile(
      makeExport("BTCUSD_2026-06-25_01-18-55.png", "FIRST-IMAGE"),
      workspace,
    );
    expect(readFileSync(staging.get("btc")!.path, "utf8")).toBe("FIRST-IMAGE");

    const receipt = await importFile(
      makeExport("BTCUSD_2026-06-25_02-00-00.png", "SECOND-IMAGE"),
      workspace,
    );

    expect(receipt.ok).toBe(true);
    if (receipt.ok) expect(receipt.revisions).toBe(2);
    expect(workspace.captures()).toEqual([
      expect.objectContaining({ assetId: "btc", revisions: 2 }),
    ]);
    expect(staging.list().map((image) => image.assetId)).toEqual(["btc"]);
    expect(readFileSync(staging.get("btc")!.path, "utf8")).toBe("SECOND-IMAGE");
  });

  it("imports an Asset in no Pack as held work without inventing a Pack", async () => {
    const workspace = createWorkspace(packs);
    const receipt = await importFile(
      makeExport("SPX_2026-06-25_01-30-00.png"),
      workspace,
    );

    expect(receipt).toEqual({
      ok: true,
      outcome: "staged",
      originalBasename: "SPX_2026-06-25_01-30-00.png",
      assetId: "spx",
      assetDisplay: "S&P 500",
      revisions: 1,
      placement: { kind: "held" },
    });
    expect(workspace.captureOf("spx")).not.toBeNull();
    expect(staging.has("spx")).toBe(true);
    expect(workspace.packState("crypto")).toBe("empty");
    expect(workspace.packState("stocks")).toBe("empty");
  });

  it("preserves unrelated Workspace state", async () => {
    const workspace = createWorkspace(packs);
    const existing = workspace.capture("aapl", "2026-06-24T00:00:00.000Z");

    await importFile(makeExport("BTCUSD_2026-06-25_01-18-55.png"), workspace);

    expect(workspace.captureOf("aapl")).toEqual(existing);
    expect(workspace.captureOf("btc")?.revisions).toBe(1);
    expect(workspace.captures()).toHaveLength(2);
  });

  it("persists the capture and revision across application-use-case reconstruction", async () => {
    const sessionPath = join(outDir, "session.json");
    const firstWorkspace = createPersistentWorkspace({ packs, path: sessionPath });
    const first = await importFile(
      makeExport("ETHUSD_2026-06-25_01-18-55.png", "FIRST"),
      firstWorkspace,
    );
    expect(first.ok && first.revisions).toBe(1);

    const reconstructedWorkspace = createPersistentWorkspace({ packs, path: sessionPath });
    const second = await importFile(
      makeExport("ETHUSD_2026-06-25_02-18-55.png", "SECOND"),
      reconstructedWorkspace,
    );

    expect(second.ok && second.revisions).toBe(2);
    expect(reconstructedWorkspace.captures()).toHaveLength(1);
    const onDisk = JSON.parse(readFileSync(sessionPath, "utf8"));
    expect(onDisk.captures).toEqual([
      expect.objectContaining({ assetId: "eth", revisions: 2 }),
    ]);
  });

  it("produces equivalent semantic receipts from desktop-like and upload-like directories", async () => {
    const filename = "AAPL_2026-06-25_01-21-06.png";
    const desktopWorkspace = createWorkspace(packs);
    const uploadWorkspace = createWorkspace(packs);
    const desktopStagingRoot = mkdtempSync(
      join(tmpdir(), "visionx-cff-desktop-staging-"),
    );
    const uploadStagingRoot = mkdtempSync(
      join(tmpdir(), "visionx-cff-upload-staging-"),
    );
    const desktopStaging = createStagingStore(desktopStagingRoot);
    const uploadStaging = createStagingStore(uploadStagingRoot);

    try {
      const desktopReceipt = await importFile(makeExport(filename), desktopWorkspace, {
        staging: desktopStaging,
      });
      const uploadReceipt = await importFile(makeUpload(filename), uploadWorkspace, {
        staging: uploadStaging,
      });

      expect(uploadReceipt).toEqual(desktopReceipt);
    } finally {
      rmSync(desktopStagingRoot, { recursive: true, force: true });
      rmSync(uploadStagingRoot, { recursive: true, force: true });
    }
  });
});

describe("captureFromFile — canonical rejection receipts", () => {
  it("preserves unparseable_filename without state changes", async () => {
    const workspace = createWorkspace(packs);
    const receipt = await importFile(makeExport(".png"), workspace);

    expect(receipt).toEqual({
      ok: false,
      outcome: "unparseable_filename",
      originalBasename: ".png",
      filename: ".png",
    });
    expect(workspace.captures()).toEqual([]);
    expect(staging.list()).toEqual([]);
  });

  it("preserves unknown_symbol and its normalized token", async () => {
    const workspace = createWorkspace(packs);
    const receipt = await importFile(
      makeExport("DOGEUSD_2026-06-25_01-30-00.png"),
      workspace,
    );

    expect(receipt).toEqual({
      ok: false,
      outcome: "unknown_symbol",
      originalBasename: "DOGEUSD_2026-06-25_01-30-00.png",
      symbol: "DOGEUSD",
    });
    expect(workspace.captures()).toEqual([]);
    expect(staging.list()).toEqual([]);
  });

  it("preserves validation failure evidence without staging or recording", async () => {
    const workspace = createWorkspace(packs);
    const receipt = await importFile(
      makeExport("BTCUSD_2026-06-25_01-18-55.png"),
      workspace,
      { validate: failValidator },
    );

    expect(receipt).toEqual({
      ok: false,
      outcome: "validation_failed",
      originalBasename: "BTCUSD_2026-06-25_01-18-55.png",
      assetId: "btc",
      assetDisplay: "Bitcoin",
      reason: "blank image",
      checks: { notBlank: false, readable: true },
    });
    if (!receipt.ok && receipt.outcome === "validation_failed") {
      expect(Object.isFrozen(receipt.checks)).toBe(true);
    }
    expect(workspace.captures()).toEqual([]);
    expect(staging.list()).toEqual([]);
  });

  it("preserves staging failure evidence without recording the Workspace fact", async () => {
    const workspace = createWorkspace(packs);
    const failingStaging: StagingStore = {
      ...staging,
      stage(): never {
        throw new Error("disk unavailable");
      },
    };
    const receipt = await importFile(
      makeExport("BTCUSD_2026-06-25_01-18-55.png"),
      workspace,
      { staging: failingStaging },
    );

    expect(receipt).toEqual({
      ok: false,
      outcome: "staging_failed",
      originalBasename: "BTCUSD_2026-06-25_01-18-55.png",
      assetId: "btc",
      assetDisplay: "Bitcoin",
      detail: "disk unavailable",
    });
    expect(workspace.captures()).toEqual([]);
  });

  it("preserves source acquisition failure", async () => {
    const workspace = createWorkspace(packs);
    const missing = join(exportDir, "does-not-exist.png");
    const receipt = await importFile(missing, workspace);

    expect(receipt).toMatchObject({
      ok: false,
      outcome: "capture_failed",
      originalBasename: "does-not-exist.png",
    });
    expect(workspace.captures()).toEqual([]);
    expect(staging.list()).toEqual([]);
  });
});

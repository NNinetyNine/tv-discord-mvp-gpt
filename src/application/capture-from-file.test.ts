import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub branding (sharp side-effects) so the file source's copy+brand stays a
// pure unit-level concern; this phase proves orchestration, not image processing.
vi.mock("../capture/branding.ts", () => ({ applyBranding: vi.fn(async () => {}) }));

import type { Pack } from "../packs/packs.ts";
import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import { createSession } from "../packs/session.ts";
import { createPersistentSession } from "../packs/persistence.ts";
import { createStagingStore, type StagingStore } from "../wiring/staging.ts";
import { captureFromFile, type CaptureFromFileDeps } from "./capture-from-file.ts";

// ---- fixtures (independent of config/*.json) -------------------------------

const channels = { crypto: "", stocks: "", indices: "" };
const registryData = {
  btc:  { tradingView: "BTCUSD", display: "Bitcoin",  channel: "crypto" },
  eth:  { tradingView: "ETHUSD", display: "Ethereum", channel: "crypto" },
  aapl: { tradingView: "AAPL",   display: "Apple",    channel: "stocks" },
  brkb: { tradingView: "BRK.B",  display: "Berkshire Hathaway", channel: "stocks" },
};
const resolver = createResolver(buildRegistry(registryData, channels));

const packs: Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", assets: ["aapl", "brkb"] },
];

const passValidator: CaptureFromFileDeps["validate"] = () => ({ ok: true, checks: { notBlank: true } });

// ---- temp state -------------------------------------------------------------

let exportDir: string; // where "TradingView-exported" PNGs live
let outDir: string;    // custody copies (IMAGE_OUTPUT_DIR)
let stagingBase: string;
let staging: StagingStore;

beforeEach(() => {
  exportDir = mkdtempSync(join(tmpdir(), "visionx-cff-export-"));
  outDir = mkdtempSync(join(tmpdir(), "visionx-cff-out-"));
  stagingBase = mkdtempSync(join(tmpdir(), "visionx-cff-staging-"));
  process.env.IMAGE_OUTPUT_DIR = outDir;
  staging = createStagingStore(stagingBase);
});
afterEach(() => {
  rmSync(exportDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(stagingBase, { recursive: true, force: true });
  delete process.env.IMAGE_OUTPUT_DIR;
  vi.clearAllMocks();
});

/** Write a fake exported PNG with a real TradingView-style filename. */
function makeExport(name: string): string {
  const p = join(exportDir, name);
  writeFileSync(p, "PNGDATA", "utf8");
  return p;
}

describe("captureFromFile — end-to-end through captureOnce", () => {
  it("ingests an exported file, resolves, validates, stages, and records", async () => {
    const session = createSession(packs); // active = crypto
    const r = await captureFromFile({
      filePath: makeExport("BTCUSD_2026-06-25_01-18-55.png"),
      resolver,
      session,
      staging,
      validate: passValidator,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome).toBe("staged");
      expect(r.asset.id).toBe("btc");
      expect(r.packId).toBe("crypto");
      expect(existsSync(r.stagedPath)).toBe(true);
    }
    expect(session.capturedAssets().map((c) => c.assetId)).toEqual(["btc"]);
    expect(staging.has("crypto", "btc")).toBe(true);
  });

  it("preserves an awkward native filename through the whole chain (BRK.B)", async () => {
    const session = createSession(packs);
    session.advance(); // -> stocks active (brkb lives there)
    const r = await captureFromFile({
      filePath: makeExport("BRK.B_2026-06-25_01-00-00.png"),
      resolver,
      session,
      staging,
      validate: passValidator,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.id).toBe("brkb"); // BRK.B survived ingest -> resolve
    expect(staging.has("stocks", "brkb")).toBe(true);
  });

  it("auto-persists through a persistent session", async () => {
    const sessionPath = join(outDir, "session.json");
    const session = createPersistentSession({ packs, path: sessionPath });
    const r = await captureFromFile({
      filePath: makeExport("ETHUSD_2026-06-25_01-18-55.png"),
      resolver,
      session,
      staging,
      validate: passValidator,
    });

    expect(r.ok).toBe(true);
    // Version-2 persisted shape: workspace capture facts (with revision counts).
    const onDisk = JSON.parse(readFileSync(sessionPath, "utf8"));
    expect(onDisk.captures.map((c: { assetId: string }) => c.assetId)).toEqual(["eth"]);
    expect(onDisk.captures[0].revisions).toBe(1); // first capture: revision 1 persisted
  });
});

describe("captureFromFile — outcomes pass through unaltered", () => {
  it("returns not_in_active_pack for an exported asset outside the active pack", async () => {
    const session = createSession(packs); // active = crypto; aapl is in stocks
    const r = await captureFromFile({
      filePath: makeExport("AAPL_2026-06-25_01-21-06.png"),
      resolver,
      session,
      staging,
      validate: passValidator,
    });

    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "not_in_active_pack") {
      expect(r.asset.id).toBe("aapl");
      expect(r.activePackId).toBe("crypto");
    } else throw new Error("expected not_in_active_pack");
    expect(staging.has("crypto", "aapl")).toBe(false);
    expect(session.capturedAssets()).toEqual([]);
  });

  it("returns unknown_symbol for an exported file with no registry match", async () => {
    const session = createSession(packs);
    const r = await captureFromFile({
      filePath: makeExport("DOGEUSD_2026-06-25_01-30-00.png"),
      resolver,
      session,
      staging,
      validate: passValidator,
    });
    expect(r).toMatchObject({ ok: false, outcome: "unknown_symbol" });
  });

  it("maps a missing export file to capture_failed (ingest throws, caught by captureOnce)", async () => {
    const session = createSession(packs);
    const r = await captureFromFile({
      filePath: join(exportDir, "does-not-exist.png"),
      resolver,
      session,
      staging,
      validate: passValidator,
    });
    expect(r).toMatchObject({ ok: false, outcome: "capture_failed" });
    expect(session.capturedAssets()).toEqual([]);
  });
});
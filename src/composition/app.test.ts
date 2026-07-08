import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

// Stub branding so the file source's copy+brand stays a pure unit concern;
// this phase proves composition/assembly, not image processing.
vi.mock("../capture/branding.ts", () => ({ applyBranding: vi.fn(async () => {}) }));

import type { Asset } from "../types.ts";
import type { ValidationPolicy } from "../validation/validate-image.ts";
import { buildApp, type App } from "./app.ts";

let sessionDir: string;
let stagingDir: string;
let archiveDir: string;
let exportDir: string;
let outDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "visionx-app-session-"));
  stagingDir = mkdtempSync(join(tmpdir(), "visionx-app-staging-"));
  archiveDir = mkdtempSync(join(tmpdir(), "visionx-app-archive-"));
  exportDir = mkdtempSync(join(tmpdir(), "visionx-app-export-"));
  outDir = mkdtempSync(join(tmpdir(), "visionx-app-out-"));
  // NOTE: IMAGE_OUTPUT_DIR is read by the file-ingest source (file-source.ts) for
  // its custody-copy location — NOT by buildApp, which no longer touches env.
  process.env.IMAGE_OUTPUT_DIR = outDir;
});
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(archiveDir, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  delete process.env.IMAGE_OUTPUT_DIR;
  vi.clearAllMocks();
});

// A complete validation policy with a tiny minBytes so small generated PNGs
// pass the intrinsic size check. Dimensions stay unenforced (null).
const TEST_POLICY: ValidationPolicy = { minBytes: 1, blankStddevFloor: 4, expectedDimensions: null };

function makeApp(): App {
  return buildApp({
    sessionPath: join(sessionDir, "session.json"),
    stagingDir,
    archiveDir,
    validationPolicy: TEST_POLICY,
  });
}

/**
 * The full Asset record for the active pack, found via the real catalog: the
 * first Asset in registry.all() whose id belongs to the active pack. Starting
 * from the catalog record (which carries both id and tradingView) avoids any
 * id->tradingView reverse-engineering, and scanning all() decouples the test
 * from the pack's internal asset ordering.
 */
function activePackAssetFromCatalog(app: App): Asset {
  const pack = app.session.activePack();
  if (pack === null) throw new Error("no active pack in real config");
  const packAssetIds = new Set(pack.assets);
  const asset = app.registry.all().find((a) => packAssetIds.has(a.id));
  if (asset === undefined) {
    throw new Error(`no registry asset matches any id in active pack "${pack.id}"`);
  }
  return asset;
}

/** Write a real, non-blank PNG named with the given TradingView export filename. */
async function makeExportPng(filename: string): Promise<string> {
  const p = join(exportDir, filename);
  const w = 40, h = 30, ch = 3;
  const buf = Buffer.alloc(w * h * ch);
  for (let i = 0; i < w * h; i++) {
    buf[i * ch] = i % 256;
    buf[i * ch + 1] = (i * 2) % 256;
    buf[i * ch + 2] = (i * 3) % 256;
  }
  await sharp(buf, { raw: { width: w, height: h, channels: ch } }).png().toFile(p);
  return p;
}

describe("buildApp — assembles against real config", () => {
  it("exposes registry, resolver, session, staging, releases, and the two services", () => {
    const app = makeApp();
    expect(typeof app.captureFromFile).toBe("function");
    expect(typeof app.publishActivePack).toBe("function");
    expect(typeof app.resolver.resolve).toBe("function");
    expect(app.registry.all().length).toBeGreaterThan(0); // real catalog loaded
    expect(app.session.activePack()).not.toBeNull(); // real packs.json -> active pack
    expect(app.session.activePack()!.assets.length).toBeGreaterThan(0);
    // Release store assembled against the injected archive root: a fresh
    // archive answers (empty), with no Discord involvement.
    const activeId = app.session.activePack()!.id;
    expect(app.releases.listReleases(activeId)).toEqual([]);
  });

  it("maps an active-pack asset to its full Asset via the catalog", () => {
    const app = makeApp();
    const asset = activePackAssetFromCatalog(app);
    // The catalog record carries both id and tradingView — no reverse-engineering.
    expect(app.session.activePack()!.assets).toContain(asset.id);
    expect(typeof asset.tradingView).toBe("string");
    expect(asset.tradingView.length).toBeGreaterThan(0);
    expect(typeof asset.display).toBe("string");
  });

  it("captures a real exported file end-to-end into the SHARED session + staging", async () => {
    const app = makeApp();
    const pack = app.session.activePack()!;
    const asset = activePackAssetFromCatalog(app);

    // Build the export filename from the asset's real TradingView token.
    const exportPath = await makeExportPng(`${asset.tradingView}_2026-06-25_01-18-55.png`);
    const r = await app.captureFromFile(exportPath);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.asset.id).toBe(asset.id);
      expect(r.packId).toBe(pack.id);
    }
    // shared app state reflects the capture
    expect(app.session.capturedAssets().map((c) => c.assetId)).toContain(asset.id);
    expect(app.staging.has(pack.id, asset.id)).toBe(true);
  });
});
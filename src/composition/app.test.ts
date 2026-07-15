import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
    registryPath: join(process.cwd(), "definitions", "registry.json"),
    packsPath: join(process.cwd(), "definitions", "packs.json"),
    channelsPath: join(process.cwd(), "config", "channels.json"),
    validationPolicy: TEST_POLICY,
  });
}

/**
 * The full Asset record for the first pack, found via the real catalog: the
 * first Asset in registry.all() whose id belongs to that pack. Starting
 * from the catalog record (which carries both id and tradingView) avoids any
 * id->tradingView reverse-engineering, and scanning all() decouples the test
 * from the pack's internal asset ordering.
 */
function firstPackAssetFromCatalog(app: App): Asset {
  const pack = app.workspace.packs()[0];
  if (pack === undefined) throw new Error("no packs in real config");
  const packAssetIds = new Set(pack.assets);
  const asset = app.registry.all().find((a) => packAssetIds.has(a.id));
  if (asset === undefined) {
    throw new Error(`no registry asset matches any id in pack "${pack.id}"`);
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
  it("exposes registry, resolver, workspace, staging, releases, and the services", () => {
    const app = makeApp();
    expect(typeof app.captureFromFile).toBe("function");
    expect(typeof app.publishPack).toBe("function");
    expect(typeof app.resumePack).toBe("function");
    expect(typeof app.resolver.resolve).toBe("function");
    expect(typeof app.workspace.captureOf).toBe("function");
    expect(app.registry.all().length).toBeGreaterThan(0); // real catalog loaded
    expect(app.workspace.packs().length).toBeGreaterThan(0); // real packs.json loaded
    expect(app.workspace.packs()[0]!.assets.length).toBeGreaterThan(0);
    // Release store assembled against the injected archive root: a fresh
    // archive answers (empty), with no Discord involvement.
    const firstId = app.workspace.packs()[0]!.id;
    expect(app.releases.listReleases(firstId)).toEqual([]);
  });

  it("maps a pack asset to its full Asset via the catalog", () => {
    const app = makeApp();
    const asset = firstPackAssetFromCatalog(app);
    // The catalog record carries both id and tradingView — no reverse-engineering.
    expect(app.workspace.packs()[0]!.assets).toContain(asset.id);
    expect(typeof asset.tradingView).toBe("string");
    expect(asset.tradingView.length).toBeGreaterThan(0);
    expect(typeof asset.display).toBe("string");
  });

  it("captures a real exported file end-to-end into the SHARED workspace + staging", async () => {
    const app = makeApp();
    const asset = firstPackAssetFromCatalog(app);

    // Build the export filename from the asset's real TradingView token.
    const exportPath = await makeExportPng(`${asset.tradingView}_2026-06-25_01-18-55.png`);
    const r = await app.captureFromFile(exportPath);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assetId).toBe(asset.id);
      expect(r.originalBasename).toBe(
        `${asset.tradingView}_2026-06-25_01-18-55.png`,
      );
      expect(r.assetDisplay).toBe(asset.display);
      expect(r.revisions).toBe(1);
      expect(r.placement.kind).toBe("pack");
      if (r.placement.kind === "pack") {
        expect(r.placement.packId).toBe(app.workspace.packs()[0]!.id);
        expect(r.placement.totalCount).toBe(app.workspace.packs()[0]!.assets.length);
      }
    }
    // Shared app state reflects the capture (staging custody is asset-keyed).
    expect(app.workspace.captureOf(asset.id)).not.toBeNull();
    expect(app.staging.has(asset.id)).toBe(true);
  });

  it("exposes the canonical receipt and preserves it across App reconstruction", async () => {
    const firstApp = makeApp();
    const asset = firstPackAssetFromCatalog(firstApp);
    const firstPath = await makeExportPng(
      `${asset.tradingView}_2026-06-25_01-18-55.png`,
    );

    const first = await firstApp.captureFromFile(firstPath);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.assetId).toBe(asset.id);
      expect(first.revisions).toBe(1);
      expect(first.placement.kind).toBe("pack");
    }

    const reconstructedApp = makeApp();
    expect(reconstructedApp.workspace.captureOf(asset.id)?.revisions).toBe(1);

    const secondPath = await makeExportPng(
      `${asset.tradingView}_2026-06-25_02-18-55.png`,
    );
    const second = await reconstructedApp.captureFromFile(secondPath);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.assetId).toBe(asset.id);
      expect(second.revisions).toBe(2);
    }
  });

  it("importing through the App creates no Release or archive effects", async () => {
    const app = makeApp();
    const asset = firstPackAssetFromCatalog(app);
    const exportPath = await makeExportPng(
      `${asset.tradingView}_2026-06-25_01-18-55.png`,
    );

    const receipt = await app.captureFromFile(exportPath);
    expect(receipt.ok).toBe(true);

    for (const pack of app.workspace.packs()) {
      expect(app.releases.listReleases(pack.id)).toEqual([]);
    }
    expect(readdirSync(archiveDir)).toEqual([]);
  });
});
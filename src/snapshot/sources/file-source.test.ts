import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub branding (sharp side-effects) so this stays a pure ingest unit test.
vi.mock("../../capture/branding.ts", () => ({ applyBranding: vi.fn(async () => {}) }));

import { ingestFile, createFileSnapshotSource, FileIngestError } from "./file-source.ts";
import { applyBranding } from "../../capture/branding.ts";

let srcDir: string;
let outDir: string;

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), "visionx-export-"));
  outDir = mkdtempSync(join(tmpdir(), "visionx-out-"));
  process.env.IMAGE_OUTPUT_DIR = outDir; // direct custody copies into a temp dir
});
afterEach(() => {
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  delete process.env.IMAGE_OUTPUT_DIR;
  vi.clearAllMocks();
});

function makeExport(name: string): string {
  const p = join(srcDir, name);
  writeFileSync(p, "PNGDATA", "utf8");
  return p;
}

describe("ingestFile — filename preservation", () => {
  it("preserves the native TradingView filename exactly as suggestedFilename", async () => {
    const snap = await ingestFile(makeExport("BTCUSD_2026-06-25_01-18-55.png"));
    expect(snap.suggestedFilename).toBe("BTCUSD_2026-06-25_01-18-55.png");
  });

  it("does not sanitize awkward real filenames (BRK.B, NOVO_B, futures !)", async () => {
    for (const name of [
      "BRK.B_2026-06-25_01-00-00.png",
      "NOVO_B_2026-06-25_01-00-00.png",
      "HG1!_2026-06-25_01-00-00.png",
    ]) {
      const snap = await ingestFile(makeExport(name));
      expect(snap.suggestedFilename).toBe(name); // byte-for-byte
    }
  });
});

describe("ingestFile — custody copy + branding", () => {
  it("copies into VisionX custody (original left intact) and points imagePath at the copy", async () => {
    const original = makeExport("ETHUSD_2026-06-25_01-18-55.png");
    const snap = await ingestFile(original);

    expect(existsSync(original)).toBe(true); // copy, not move
    expect(snap.imagePath).not.toBe(original); // points at the custody copy
    expect(snap.imagePath.startsWith(outDir)).toBe(true);
    expect(existsSync(snap.imagePath)).toBe(true);
  });

  it("brands the custody copy, never the original", async () => {
    const original = makeExport("AAPL_2026-06-25_01-21-06.png");
    const snap = await ingestFile(original);
    expect(applyBranding).toHaveBeenCalledWith(snap.imagePath);
    expect(applyBranding).not.toHaveBeenCalledWith(original);
  });

  it("returns an ISO-8601 capturedAt", async () => {
    const snap = await ingestFile(makeExport("SPX_2026-06-25_01-21-06.png"));
    expect(snap.capturedAt).toBe(new Date(snap.capturedAt).toISOString());
  });
});

describe("ingestFile — fail closed", () => {
  it("throws FileIngestError when the named file does not exist", async () => {
    await expect(ingestFile(join(srcDir, "missing.png"))).rejects.toThrow(FileIngestError);
  });
});

describe("createFileSnapshotSource — SnapshotSource conformance", () => {
  it("capture() ingests the bound file and returns the Snapshot", async () => {
    const path = makeExport("BTCUSD_2026-06-25_01-18-55.png");
    const source = createFileSnapshotSource(path);
    const snap = await source.capture();
    expect(snap.suggestedFilename).toBe("BTCUSD_2026-06-25_01-18-55.png");
    expect(existsSync(snap.imagePath)).toBe(true);
  });
});
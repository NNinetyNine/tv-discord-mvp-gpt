import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { validateImage, type ValidationPolicy } from "./validate-image.ts";

// Complete policies stated explicitly — no env, no defaults, fully deterministic.
const NO_DIMS: ValidationPolicy = { minBytes: 100, blankStddevFloor: 4, expectedDimensions: null };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "visionx-validate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a real PNG of the given size with a colour gradient (non-blank). */
async function makePng(name: string, width: number, height: number): Promise<string> {
  const p = join(dir, name);
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    buf[i * channels] = i % 256;
    buf[i * channels + 1] = (i * 2) % 256;
    buf[i * channels + 2] = (i * 3) % 256;
  }
  await sharp(buf, { raw: { width, height, channels } }).png().toFile(p);
  return p;
}

/** Write a flat (uniform) PNG — near-zero stddev, i.e. "blank". */
async function makeBlankPng(name: string, width: number, height: number): Promise<string> {
  const p = join(dir, name);
  await sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .png()
    .toFile(p);
  return p;
}

describe("validateImage — intrinsic checks (dimensions disabled)", () => {
  it("passes a real, non-blank image with checks.dimensions omitted", async () => {
    const img = await makePng("ok.png", 80, 60);
    const r = await validateImage(img, NO_DIMS);
    expect(r.ok).toBe(true);
    expect(r.checks.exists).toBe(true);
    expect(r.checks.size).toBe(true);
    expect(r.checks.readable).toBe(true);
    expect(r.checks.notBlank).toBe(true);
    expect("dimensions" in r.checks).toBe(false); // omitted when policy has no dimensions
  });

  it("fails closed when the file does not exist", async () => {
    const r = await validateImage(join(dir, "missing.png"), NO_DIMS);
    expect(r.ok).toBe(false);
    expect(r.checks.exists).toBe(false);
    expect(r.reason).toMatch(/file does not exist/);
  });

  it("fails when the file is below minBytes", async () => {
    const img = await makePng("tiny.png", 80, 60);
    const strict: ValidationPolicy = { minBytes: 10_000_000, blankStddevFloor: 4, expectedDimensions: null };
    const r = await validateImage(img, strict);
    expect(r.ok).toBe(false);
    expect(r.checks.size).toBe(false);
    expect(r.reason).toMatch(/file too small/);
  });

  it("fails 'not readable' for a non-image file", async () => {
    const notImg = join(dir, "notimage.png");
    writeFileSync(notImg, "x".repeat(500), "utf8"); // >minBytes but not a real image
    const r = await validateImage(notImg, NO_DIMS);
    expect(r.ok).toBe(false);
    expect(r.checks.readable).toBe(false);
    expect(r.reason).toMatch(/image not readable/);
  });

  it("fails 'blank' for a flat uniform image", async () => {
    const blank = await makeBlankPng("blank.png", 80, 60);
    const r = await validateImage(blank, NO_DIMS);
    expect(r.ok).toBe(false);
    expect(r.checks.notBlank).toBe(false);
    expect(r.reason).toMatch(/image appears blank/);
  });
});

describe("validateImage — dimension policy enforced", () => {
  it("passes when dimensions match the policy", async () => {
    const img = await makePng("dims.png", 100, 50);
    const policy: ValidationPolicy = { minBytes: 100, blankStddevFloor: 4, expectedDimensions: { width: 100, height: 50 } };
    const r = await validateImage(img, policy);
    expect(r.ok).toBe(true);
    expect(r.checks.dimensions).toBe(true);
  });

  it("fails when dimensions differ, with the legacy reason format", async () => {
    const img = await makePng("dims.png", 80, 60);
    const policy: ValidationPolicy = { minBytes: 100, blankStddevFloor: 4, expectedDimensions: { width: 100, height: 50 } };
    const r = await validateImage(img, policy);
    expect(r.ok).toBe(false);
    expect(r.checks.dimensions).toBe(false);
    expect(r.reason).toBe("dimensions 80x60 != expected 100x50");
  });
});

describe("validateImage — determinism", () => {
  it("returns an equivalent result for the same inputs (no env, no hidden state)", async () => {
    const img = await makePng("det.png", 80, 60);
    const a = await validateImage(img, NO_DIMS);
    const b = await validateImage(img, NO_DIMS);
    expect(a).toEqual(b);
  });
});
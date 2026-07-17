import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "./inspect-chart-frame.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-chart-frame-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makeFramedPng(path: string): Promise<void> {
  const width = 90;
  const height = 70;
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);
  const setPixel = (x: number, y: number, value: number): void => {
    const offset = (y * width + x) * channels;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(x, y, 31);
  }
  for (let y = 7; y <= 61; y += 1) {
    for (let x = 5; x <= 84; x += 1) setPixel(x, y, 20);
  }
  for (let x = 5; x <= 84; x += 1) {
    setPixel(x, 7, 45);
    setPixel(x, 61, 45);
  }
  for (let y = 7; y <= 61; y += 1) {
    setPixel(5, y, 45);
    setPixel(84, y, 45);
  }
  await sharp(data, { raw: { width, height, channels } }).png().toFile(path);
}

async function makeNoFramePng(path: string): Promise<void> {
  await sharp({
    create: {
      width: 40,
      height: 30,
      channels: 4,
      background: { r: 31, g: 31, b: 31, alpha: 1 },
    },
  })
    .png()
    .toFile(path);
}

describe("inspect-chart-frame command", () => {
  it("reports detections in explicit caller order", async () => {
    const first = join(root, "first.png");
    const second = join(root, "second.png");
    await makeFramedPng(first);
    await makeFramedPng(second);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      ["node", "inspect-chart-frame.ts", second, first],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const report = JSON.parse(stdout[0] ?? "") as {
      readonly results: readonly {
        readonly originalBasename: string;
        readonly detection: { readonly ok: boolean; readonly left?: number };
      }[];
    };
    expect(report.results.map((result) => result.originalBasename)).toEqual([
      "second.png",
      "first.png",
    ]);
    expect(report.results.every((result) => result.detection.ok)).toBe(true);
    expect(report.results.map((result) => result.detection.left)).toEqual([5, 5]);
  });

  it("returns nonzero and preserves a typed failure for any failed input", async () => {
    const valid = join(root, "valid.png");
    const invalid = join(root, "invalid.png");
    await makeFramedPng(valid);
    await makeNoFramePng(invalid);

    const stdout: string[] = [];
    const exitCode = await main(
      ["node", "inspect-chart-frame.ts", valid, invalid],
      (text) => stdout.push(text),
      () => undefined,
    );

    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout[0] ?? "") as {
      readonly results: readonly { readonly detection: { readonly ok: boolean; readonly reason?: string } }[];
    };
    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.detection.ok).toBe(true);
    expect(report.results[1]?.detection).toMatchObject({
      ok: false,
      reason: "no_frame_candidate",
    });
  });

  it("does not modify the supplied image", async () => {
    const imagePath = join(root, "source.png");
    await makeFramedPng(imagePath);
    const beforeBytes = readFileSync(imagePath);
    const beforeStat = statSync(imagePath);

    await main(["node", "inspect-chart-frame.ts", imagePath], () => undefined, () => undefined);

    const afterStat = statSync(imagePath);
    expect(readFileSync(imagePath)).toEqual(beforeBytes);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("returns usage when no explicit paths are supplied", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      ["node", "inspect-chart-frame.ts"],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Usage: npx tsx src/scripts/inspect-chart-frame.ts <image> [image ...]",
    ]);
  });
});

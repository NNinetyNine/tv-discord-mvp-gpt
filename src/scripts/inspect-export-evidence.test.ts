import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "./inspect-export-evidence.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-export-evidence-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makePng(path: string, width: number, height: number): Promise<void> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * channels;
    data[offset] = pixel % 256;
    data[offset + 1] = (pixel * 3) % 256;
    data[offset + 2] = (pixel * 7) % 256;
  }
  await sharp(data, { raw: { width, height, channels } }).png().toFile(path);
}

describe("inspect-export-evidence command", () => {
  it("writes one deterministic JSON report with observations in supplied order", async () => {
    const first = join(root, "first.png");
    const second = join(root, "second.png");
    await makePng(first, 5, 4);
    await makePng(second, 9, 7);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      ["node", "inspect-export-evidence.ts", second, first],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);

    const report = JSON.parse(stdout[0] ?? "") as {
      readonly observations: readonly {
        readonly originalBasename: string;
        readonly width: number;
      }[];
    };
    expect(report.observations.map((observation) => observation.originalBasename)).toEqual([
      "second.png",
      "first.png",
    ]);
    expect(report.observations.map((observation) => observation.width)).toEqual([9, 5]);
  });

  it("emits no successful partial report when any requested file fails", async () => {
    const valid = join(root, "valid.png");
    const missing = join(root, "missing.png");
    await makePng(valid, 5, 4);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      ["node", "inspect-export-evidence.ts", valid, missing],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0] ?? "")).toEqual({
      error: {
        reason: "missing_file",
        inputPath: missing,
        detail: "file does not exist",
      },
    });
  });

  it("fails with usage when no explicit file paths are supplied", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      ["node", "inspect-export-evidence.ts"],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Usage: npx tsx src/scripts/inspect-export-evidence.ts <image> [image ...]",
    ]);
  });

  it("reports a corrupt requested file as a request failure rather than a catalogue entry", async () => {
    const corrupt = join(root, "corrupt.png");
    writeFileSync(corrupt, "not an image", "utf8");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      ["node", "inspect-export-evidence.ts", corrupt],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
      error: {
        reason: "unreadable_image",
        inputPath: corrupt,
      },
    });
  });
});

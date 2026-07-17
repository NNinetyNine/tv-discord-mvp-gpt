import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  main,
  parseRenderChartPublicationArguments,
  RENDER_CHART_PUBLICATION_USAGE,
} from "./render-chart-publication.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-render-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makeFramedPng(path: string): Promise<void> {
  const width = 160;
  const height = 110;
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);
  const set = (x: number, y: number, value: number): void => {
    const offset = (y * width + x) * channels;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) set(x, y, 31);
  }
  for (let y = 10; y <= 90; y += 1) {
    for (let x = 7; x <= 152; x += 1) set(x, y, 20);
  }
  for (let x = 7; x <= 152; x += 1) {
    set(x, 10, 45);
    set(x, 90, 45);
  }
  for (let y = 10; y <= 90; y += 1) {
    set(7, y, 45);
    set(152, y, 45);
  }
  await sharp(data, { raw: { width, height, channels } }).png().toFile(path);
}

function argumentsFor(paths: {
  readonly input: string;
  readonly metadata: string;
  readonly output: string;
  readonly receipt: string;
}): string[] {
  return [
    "node",
    "render-chart-publication.ts",
    "--input",
    paths.input,
    "--metadata",
    paths.metadata,
    "--output",
    paths.output,
    "--receipt",
    paths.receipt,
  ];
}

describe("render-chart-publication command", () => {
  it("rejects missing required flags and prints concise usage", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      ["node", "render-chart-publication.ts", "--input", "source.png"],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );
    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe(RENDER_CHART_PUBLICATION_USAGE);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({ ok: false, reason: "invalid_arguments" });
  });

  it("rejects duplicate flags", () => {
    expect(parseRenderChartPublicationArguments([
      "node",
      "render-chart-publication.ts",
      "--input",
      "a.png",
      "--input",
      "b.png",
    ])).toMatchObject({ ok: false, reason: "invalid_arguments" });
  });

  it("rejects unknown flags and positional paths", () => {
    expect(parseRenderChartPublicationArguments([
      "node",
      "render-chart-publication.ts",
      "--unknown",
      "value",
    ])).toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(parseRenderChartPublicationArguments([
      "node",
      "render-chart-publication.ts",
      "source.png",
    ])).toMatchObject({ ok: false, reason: "invalid_arguments" });
  });

  it("rejects missing flag values", () => {
    expect(parseRenderChartPublicationArguments([
      "node",
      "render-chart-publication.ts",
      "--input",
      "--metadata",
      "metadata.json",
    ])).toMatchObject({ ok: false, reason: "invalid_arguments" });
  });

  it("renders from four explicit paths and emits one structured success result", async () => {
    const paths = {
      input: join(root, "source.png"),
      metadata: join(root, "metadata.json"),
      output: join(root, "publication.png"),
      receipt: join(root, "publication.receipt.json"),
    };
    await makeFramedPng(paths.input);
    writeFileSync(paths.metadata, JSON.stringify({
      title: "BTC PERPETUAL FUTURES",
      symbol: "BTCUSD",
      timeframe: "5M",
      market: "BINANCE",
      currency: "USD",
      dataSource: "BINANCE",
      dataAsOf: "2026-07-17",
      chartAttribution: "Chart source: TradingView",
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      argumentsFor(paths),
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      ok: true,
      outputBasename: "publication.png",
      receiptBasename: "publication.receipt.json",
      receipt: { template: { width: 2048, layoutId: "chart_width_driven" } },
    });
    expect(readFileSync(paths.output).byteLength).toBeGreaterThan(0);
    expect(readFileSync(paths.receipt, "utf8").endsWith("\n")).toBe(true);
  });
});

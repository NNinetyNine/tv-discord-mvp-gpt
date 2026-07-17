import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChartPublicationMetadata } from "../rendering/chart-publication-template.ts";
import { renderChartPublication } from "../rendering/render-chart-publication.ts";
import {
  main,
  parseReviewChartPublicationArguments,
  REVIEW_CHART_PUBLICATION_USAGE,
} from "./review-chart-publication.ts";

const METADATA: ChartPublicationMetadata = Object.freeze({
  title: "BTC PERPETUAL FUTURES",
  symbol: "BTCUSD",
  timeframe: "5M",
  market: "BINANCE",
  dataSource: "BINANCE",
  dataAsOf: "2026-07-17",
  chartAttribution: "Chart source: TradingView",
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-review-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function createInputs(): Promise<{
  readonly source: string;
  readonly publication: string;
  readonly renderReceipt: string;
  readonly review: string;
  readonly output: string;
}> {
  const paths = Object.freeze({
    source: join(root, "source.png"),
    publication: join(root, "publication.png"),
    renderReceipt: join(root, "publication.receipt.json"),
    review: join(root, "review.json"),
    output: join(root, "publication.review.json"),
  });
  const width = 180;
  const height = 120;
  const channels = 4;
  const data = Buffer.alloc(width * height * channels, 31);
  for (let offset = 3; offset < data.length; offset += channels) data[offset] = 255;
  const set = (x: number, y: number, value: number): void => {
    const offset = (y * width + x) * channels;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  };
  for (let y = 10; y <= 100; y += 1) {
    for (let x = 7; x <= 172; x += 1) set(x, y, 20);
  }
  for (let x = 7; x <= 172; x += 1) {
    set(x, 10, 45);
    set(x, 100, 45);
  }
  for (let y = 10; y <= 100; y += 1) {
    set(7, y, 45);
    set(172, y, 45);
  }
  const source = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  writeFileSync(paths.source, source);
  const rendered = await renderChartPublication(source, METADATA);
  if (!rendered.ok) throw new Error(rendered.detail);
  writeFileSync(paths.publication, rendered.outputPng);
  writeFileSync(paths.renderReceipt, rendered.receiptBytes);
  writeFileSync(paths.review, JSON.stringify({
    schemaVersion: 1,
    decision: "approved",
    reviewerId: "visionx-curator",
    reviewedAt: "2026-07-17T20:45:00Z",
    referenceId: "visionx.discord-chart.target-v1",
  }));
  return paths;
}

function argv(paths: Awaited<ReturnType<typeof createInputs>>, includeSource = true): string[] {
  return [
    "node",
    "review-chart-publication.ts",
    "--publication",
    paths.publication,
    "--render-receipt",
    paths.renderReceipt,
    "--review",
    paths.review,
    "--output",
    paths.output,
    ...(includeSource ? ["--source", paths.source] : []),
  ];
}

describe("review-chart-publication command", () => {
  it("rejects missing flags and prints concise usage", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      ["node", "review-chart-publication.ts", "--publication", "publication.png"],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );
    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe(REVIEW_CHART_PUBLICATION_USAGE);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({ ok: false, reason: "invalid_arguments" });
  });

  it("rejects duplicate flags, unknown flags, positional paths, and missing values", () => {
    expect(parseReviewChartPublicationArguments(["node", "script", "--publication", "a", "--publication", "b"])).toMatchObject({ ok: false });
    expect(parseReviewChartPublicationArguments(["node", "script", "--unknown", "x"])).toMatchObject({ ok: false });
    expect(parseReviewChartPublicationArguments(["node", "script", "publication.png"])).toMatchObject({ ok: false });
    expect(parseReviewChartPublicationArguments(["node", "script", "--publication", "--review", "x"])).toMatchObject({ ok: false });
  });

  it("parses the optional source exactly once", async () => {
    const paths = await createInputs();
    expect(parseReviewChartPublicationArguments(argv(paths))).toMatchObject({
      ok: true,
      options: { sourcePath: paths.source },
    });
    expect(parseReviewChartPublicationArguments([...argv(paths), "--source", paths.source])).toMatchObject({ ok: false });
  });

  it("writes one approved structured result from explicit paths", async () => {
    const paths = await createInputs();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(argv(paths), (text) => stdout.push(text), (text) => stderr.push(text));
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      ok: true,
      publicationApproved: true,
      sourceReverified: true,
      receipt: { reviewType: "visionx.chart-publication.visual-review" },
    });
    expect(existsSync(paths.output)).toBe(true);
    expect(readFileSync(paths.output, "utf8").endsWith("\n")).toBe(true);
  });

  it("returns nonzero and typed JSON for artifact failures", async () => {
    const paths = await createInputs();
    writeFileSync(paths.publication, Buffer.from("not the publication"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(argv(paths), (text) => stdout.push(text), (text) => stderr.push(text));
    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr[0] ?? "")).toMatchObject({ ok: false, reason: "publication_hash_mismatch" });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  main,
  parsePreviewChartPublicationArguments,
  PREVIEW_CHART_PUBLICATION_USAGE,
} from "./preview-chart-publication.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-chart-preview-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function common(): string[] {
  return [
    "--asset",
    "btc",
    "--input",
    join(root, "BTCUSD_2026-07-22_18-58-01.png"),
    "--output",
    join(root, "btc.preview.png"),
    "--receipt",
    join(root, "btc.preview.receipt.json"),
  ];
}

function standaloneArgv(): string[] {
  return [
    "node",
    "preview-chart-publication.ts",
    "--context",
    "standalone",
    "--timeframe",
    "4H",
    ...common(),
  ];
}

function packArgv(): string[] {
  return [
    "node",
    "preview-chart-publication.ts",
    "--context",
    "pack",
    "--pack",
    "crypto",
    ...common(),
  ];
}

describe("preview-chart-publication command", () => {
  it("parses standalone context with explicit timeframe and governed default source paths", () => {
    expect(parsePreviewChartPublicationArguments(standaloneArgv())).toEqual({
      ok: true,
      options: {
        inputPath: resolve(join(root, "BTCUSD_2026-07-22_18-58-01.png")),
        request: { context: "standalone", assetId: "btc", timeframe: "4H" },
        outputPath: resolve(join(root, "btc.preview.png")),
        receiptPath: resolve(join(root, "btc.preview.receipt.json")),
        registryPath: resolve("definitions/registry.json"),
        channelsPath: resolve("config/channels.json"),
        packsPath: resolve("definitions/packs.json"),
      },
    });
  });

  it("parses Pack context without a caller-authored timeframe", () => {
    expect(parsePreviewChartPublicationArguments(packArgv())).toMatchObject({
      ok: true,
      options: {
        request: { context: "pack", assetId: "btc", packId: "crypto" },
      },
    });
  });

  it("accepts explicit Registry, channel, and Pack source paths for isolated verification", () => {
    expect(parsePreviewChartPublicationArguments([
      ...packArgv(),
      "--registry",
      join(root, "registry.json"),
      "--channels",
      join(root, "channels.json"),
      "--packs",
      join(root, "packs.json"),
    ])).toMatchObject({
      ok: true,
      options: {
        registryPath: resolve(join(root, "registry.json")),
        channelsPath: resolve(join(root, "channels.json")),
        packsPath: resolve(join(root, "packs.json")),
      },
    });
  });

  it("rejects context-specific misuse and unsupported timeframes", () => {
    expect(parsePreviewChartPublicationArguments([
      ...standaloneArgv(),
      "--pack",
      "crypto",
    ])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments([
      ...packArgv(),
      "--timeframe",
      "1D",
    ])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments(
      standaloneArgv().map((value) => value === "4H" ? "hourly" : value),
    )).toMatchObject({ ok: false });
  });

  it("rejects missing, duplicate, unknown, positional, and valueless arguments", async () => {
    expect(parsePreviewChartPublicationArguments(["node", "script", "--input", "a.png"])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments([...standaloneArgv(), "--input", "other.png"])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments(["node", "script", "--unknown", "x"])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments(["node", "script", "source.png"])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments(["node", "script", "--input", "--context", "standalone"])).toMatchObject({ ok: false });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      ["node", "preview-chart-publication.ts", "--input", "source.png"],
      (text) => stdout.push(text),
      (text) => stderr.push(text),
    );
    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe(PREVIEW_CHART_PUBLICATION_USAGE);
  });
});

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

function argv(): string[] {
  return [
    "node",
    "preview-chart-publication.ts",
    "--input",
    join(root, "BTCUSD_2026-07-22_18-58-01.png"),
    "--profile",
    join(root, "btc-1h.profile.json"),
    "--output",
    join(root, "btc.preview.png"),
    "--receipt",
    join(root, "btc.preview.receipt.json"),
  ];
}

describe("preview-chart-publication command", () => {
  it("parses explicit artifact paths and governed default source paths", () => {
    expect(parsePreviewChartPublicationArguments(argv())).toEqual({
      ok: true,
      options: {
        inputPath: resolve(join(root, "BTCUSD_2026-07-22_18-58-01.png")),
        profilePath: resolve(join(root, "btc-1h.profile.json")),
        outputPath: resolve(join(root, "btc.preview.png")),
        receiptPath: resolve(join(root, "btc.preview.receipt.json")),
        registryPath: resolve("definitions/registry.json"),
        channelsPath: resolve("config/channels.json"),
      },
    });
  });

  it("accepts explicit Registry and channel source paths for isolated verification", () => {
    expect(parsePreviewChartPublicationArguments([
      ...argv(),
      "--registry",
      join(root, "registry.json"),
      "--channels",
      join(root, "channels.json"),
    ])).toMatchObject({
      ok: true,
      options: {
        registryPath: resolve(join(root, "registry.json")),
        channelsPath: resolve(join(root, "channels.json")),
      },
    });
  });

  it("rejects missing, duplicate, unknown, positional, and valueless arguments", async () => {
    expect(parsePreviewChartPublicationArguments(["node", "script", "--input", "a.png"])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments([...argv(), "--input", "other.png"])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments(["node", "script", "--unknown", "x"])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments(["node", "script", "source.png"])).toMatchObject({ ok: false });
    expect(parsePreviewChartPublicationArguments(["node", "script", "--input", "--profile", "x"])).toMatchObject({ ok: false });

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

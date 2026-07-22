import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkspace } from "../packs/workspace.ts";
import { createStagingStore } from "../wiring/staging.ts";
import { capturePackChartPublicationFile } from "./capture-pack-chart-publication-file.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-pack-chart-capture-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeFramedPng(path: string): Promise<void> {
  const width = 160;
  const height = 110;
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

function definitions(): { registryPath: string; channelsPath: string; packsPath: string } {
  const registryPath = join(root, "registry.json");
  const channelsPath = join(root, "channels.json");
  const packsPath = join(root, "packs.json");
  writeFileSync(registryPath, JSON.stringify({
    btc: {
      tradingView: "CRYPTO:BTCUSD",
      display: "Bitcoin / U.S. Dollar",
      currency: "USD",
      channel: "crypto",
    },
    eth: {
      tradingView: "CRYPTO:ETHUSD",
      display: "Ethereum / U.S. Dollar",
      currency: "USD",
      channel: "crypto",
    },
  }));
  writeFileSync(channelsPath, JSON.stringify({ crypto: "" }));
  writeFileSync(packsPath, JSON.stringify([
    { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
  ]));
  return { registryPath, channelsPath, packsPath };
}

async function source(name: string): Promise<string> {
  const path = join(root, name);
  await makeFramedPng(path);
  return path;
}

function destinations(label: string): { outputPath: string; receiptPath: string } {
  return {
    outputPath: join(root, `${label}.publication.png`),
    receiptPath: join(root, `${label}.publication.receipt.json`),
  };
}

describe("capture Pack chart publication file", () => {
  it("stages the rendered publication, preserves raw evidence, and records Pack progress", async () => {
    const inputPath = await source("BTCUSD_2026-07-22_18-58-01.png");
    const inputBefore = readFileSync(inputPath);
    const paths = destinations("btc-r1");
    const defs = definitions();
    const workspace = createWorkspace([
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
    ]);
    const staging = createStagingStore(join(root, "staging"));
    const validate = vi.fn(() => ({ ok: true, checks: { readable: true } }));

    const result = await capturePackChartPublicationFile(
      { ...defs, ...paths, inputPath, assetId: "btc", packId: "crypto" },
      { workspace, staging, validate, now: () => "2026-07-22T19:00:00.000Z" },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: "staged_render",
      sourceBasename: "BTCUSD_2026-07-22_18-58-01.png",
      assetId: "btc",
      packId: "crypto",
      timeframe: "1D",
      dataAsOf: "2026-07-22",
      revisions: 1,
      packState: "building",
      capturedCount: 1,
      totalCount: 2,
      remainingRequiredAssetIds: ["eth"],
    });
    expect(validate).toHaveBeenCalledWith(paths.outputPath);
    expect(readFileSync(inputPath)).toEqual(inputBefore);
    expect(existsSync(paths.receiptPath)).toBe(true);
    const output = readFileSync(paths.outputPath);
    expect(readFileSync(staging.get("btc")!.path)).toEqual(output);
    if (result.ok) expect(result.outputSha256).toBe(sha256(output));
    expect(workspace.captureOf("btc")).toEqual({
      assetId: "btc",
      capturedAt: "2026-07-22T19:00:00.000Z",
      revisions: 1,
    });
  });

  it("replaces only the current staged artifact and increments revision", async () => {
    const defs = definitions();
    const workspace = createWorkspace([
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
    ]);
    const staging = createStagingStore(join(root, "staging"));
    const dependencies = {
      workspace,
      staging,
      validate: () => ({ ok: true, checks: { readable: true } }),
      now: () => "2026-07-23T00:00:00.000Z",
    };
    const firstPaths = destinations("btc-r1");
    const secondPaths = destinations("btc-r2");

    await capturePackChartPublicationFile(
      {
        ...defs,
        ...firstPaths,
        inputPath: await source("BTCUSD_2026-07-22_18-58-01.png"),
        assetId: "btc",
        packId: "crypto",
      },
      dependencies,
    );
    const second = await capturePackChartPublicationFile(
      {
        ...defs,
        ...secondPaths,
        inputPath: await source("BTCUSD_2026-07-23_18-58-01.png"),
        assetId: "btc",
        packId: "crypto",
      },
      dependencies,
    );

    expect(second).toMatchObject({ ok: true, revisions: 2, dataAsOf: "2026-07-23" });
    expect(readFileSync(staging.get("btc")!.path)).toEqual(readFileSync(secondPaths.outputPath));
    expect(existsSync(firstPaths.outputPath)).toBe(true);
    expect(existsSync(firstPaths.receiptPath)).toBe(true);
    expect(workspace.captures()).toHaveLength(1);
  });

  it("keeps rendered evidence but does not stage or capture when output validation fails", async () => {
    const inputPath = await source("BTCUSD_2026-07-22_18-58-01.png");
    const paths = destinations("btc-rejected");
    const workspace = createWorkspace([
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
    ]);
    const staging = createStagingStore(join(root, "staging"));

    const result = await capturePackChartPublicationFile(
      {
        ...definitions(),
        ...paths,
        inputPath,
        assetId: "btc",
        packId: "crypto",
      },
      {
        workspace,
        staging,
        validate: () => ({ ok: false, checks: { readable: false }, reason: "unreadable" }),
        now: () => "2026-07-22T19:00:00.000Z",
      },
    );

    expect(result).toEqual({
      ok: false,
      outcome: "validation_failed",
      assetId: "btc",
      packId: "crypto",
      reason: "unreadable",
      checks: { readable: false },
    });
    expect(existsSync(paths.outputPath)).toBe(true);
    expect(existsSync(paths.receiptPath)).toBe(true);
    expect(staging.has("btc")).toBe(false);
    expect(workspace.captureOf("btc")).toBeNull();
  });

  it("fails before render and state changes when Asset membership is wrong", async () => {
    const inputPath = await source("BTCUSD_2026-07-22_18-58-01.png");
    const paths = destinations("btc-mismatch");
    const workspace = createWorkspace([
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
    ]);
    const staging = createStagingStore(join(root, "staging"));

    const result = await capturePackChartPublicationFile(
      {
        ...definitions(),
        ...paths,
        inputPath,
        assetId: "eth",
        packId: "crypto",
      },
      {
        workspace,
        staging,
        validate: () => ({ ok: true, checks: { readable: true } }),
        now: () => "2026-07-22T19:00:00.000Z",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "render_failed",
      reason: "request_asset_mismatch",
    });
    expect(existsSync(paths.outputPath)).toBe(false);
    expect(existsSync(paths.receiptPath)).toBe(false);
    expect(staging.list()).toEqual([]);
    expect(workspace.captures()).toEqual([]);
  });
});

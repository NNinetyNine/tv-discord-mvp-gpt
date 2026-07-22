import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { previewChartPublicationFile } from "./chart-publication-preview-file.ts";
import type { ChartPublicationPreviewRequest } from "./chart-publication-preview.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-chart-preview-file-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

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

function paths(
  sourceBasename: string,
  request: ChartPublicationPreviewRequest,
) {
  return {
    inputPath: join(root, sourceBasename),
    request,
    outputPath: join(root, "chart.preview.png"),
    receiptPath: join(root, "chart.preview.receipt.json"),
    registryPath: join(root, "registry.json"),
    channelsPath: join(root, "channels.json"),
    packsPath: join(root, "packs.json"),
  };
}

async function createInputs(
  sourceBasename: string,
  request: ChartPublicationPreviewRequest,
): Promise<ReturnType<typeof paths>> {
  const value = paths(sourceBasename, request);
  await makeFramedPng(value.inputPath);
  writeFileSync(value.registryPath, JSON.stringify({
    btc: {
      tradingView: "CRYPTO:BTCUSD",
      display: "Bitcoin / U.S. Dollar",
      currency: "USD",
      channel: "crypto",
    },
    acwi: {
      tradingView: "AMEX:ACWI",
      display: "iShares MSCI ACWI ETF",
      currency: "USD",
      channel: "etfs",
    },
    orphan: {
      tradingView: "NASDAQ:ORPHAN",
      display: "Standalone Only",
      currency: "USD",
      channel: "crypto",
    },
  }));
  writeFileSync(value.channelsPath, JSON.stringify({ crypto: "", etfs: "" }));
  writeFileSync(value.packsPath, JSON.stringify([
    { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] },
    { id: "etfs", display: "ETFs", channel: "etfs", assets: ["acwi"] },
  ]));
  return value;
}

describe("preview chart publication file", () => {
  it("renders standalone output without consulting Pack definitions", async () => {
    const value = await createInputs(
      "ORPHAN_2026-07-22_18-58-01.png",
      { context: "standalone", assetId: "orphan", timeframe: "6H" },
    );
    rmSync(value.packsPath);

    const result = await previewChartPublicationFile(value);

    expect(result).toMatchObject({
      ok: true,
      context: "standalone",
      sourceBasename: "ORPHAN_2026-07-22_18-58-01.png",
      assetId: "orphan",
      timeframe: "6H",
      dataAsOf: "2026-07-22",
      metadata: {
        timeframe: "6H",
        market: "NASDAQ",
        dataSource: "NASDAQ",
        dataAsOf: "2026-07-22",
      },
    });
    expect(existsSync(value.outputPath)).toBe(true);
    expect(existsSync(value.receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(value.receiptPath, "utf8")) as {
      readonly metadata: { readonly dataSource: string; readonly chartAttribution: string };
    };
    expect(receipt.metadata).toEqual(expect.objectContaining({
      dataSource: "NASDAQ",
      chartAttribution: "Chart source: TradingView",
    }));
  });

  it("renders ordinary Pack output with the 1D Pack default", async () => {
    const value = await createInputs(
      "BTCUSD_2026-07-22_18-58-01.png",
      { context: "pack", assetId: "btc", packId: "crypto" },
    );

    expect(await previewChartPublicationFile(value)).toMatchObject({
      ok: true,
      context: "pack",
      assetId: "btc",
      packId: "crypto",
      timeframe: "1D",
      metadata: { timeframe: "1D", market: "CRYPTO", dataSource: "CRYPTO" },
    });
  });

  it("renders ETF Pack output with the 4D Pack default", async () => {
    const value = await createInputs(
      "ACWI_2026-07-22_18-58-01.png",
      { context: "pack", assetId: "acwi", packId: "etfs" },
    );

    expect(await previewChartPublicationFile(value)).toMatchObject({
      ok: true,
      context: "pack",
      assetId: "acwi",
      packId: "etfs",
      timeframe: "4D",
      metadata: { timeframe: "4D", market: "AMEX", dataSource: "AMEX" },
    });
  });

  it("fails before rendering when the selected Asset mismatches or lacks Pack membership", async () => {
    const mismatch = await createInputs(
      "BTCUSD_2026-07-22_18-58-01.png",
      { context: "standalone", assetId: "orphan", timeframe: "1H" },
    );
    expect(await previewChartPublicationFile(mismatch)).toMatchObject({
      ok: false,
      reason: "request_asset_mismatch",
    });
    expect(existsSync(mismatch.outputPath)).toBe(false);
    expect(existsSync(mismatch.receiptPath)).toBe(false);

    const nonMember = await createInputs(
      "ORPHAN_2026-07-22_18-58-01.png",
      { context: "pack", assetId: "orphan", packId: "crypto" },
    );
    expect(await previewChartPublicationFile(nonMember)).toMatchObject({
      ok: false,
      reason: "asset_not_in_pack",
    });
    expect(existsSync(nonMember.outputPath)).toBe(false);
    expect(existsSync(nonMember.receiptPath)).toBe(false);
  });
});

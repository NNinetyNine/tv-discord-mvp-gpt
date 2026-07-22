import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { previewChartPublicationFile } from "./chart-publication-preview-file.ts";

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

function paths() {
  return {
    inputPath: join(root, "BTCUSD_2026-07-22_18-58-01.png"),
    profilePath: join(root, "btc-1h.profile.json"),
    outputPath: join(root, "btc.preview.png"),
    receiptPath: join(root, "btc.preview.receipt.json"),
    registryPath: join(root, "registry.json"),
    channelsPath: join(root, "channels.json"),
  };
}

async function createInputs(): Promise<ReturnType<typeof paths>> {
  const value = paths();
  await makeFramedPng(value.inputPath);
  writeFileSync(value.profilePath, JSON.stringify({ schemaVersion: 1, assetId: "btc", timeframe: "1H" }));
  writeFileSync(value.registryPath, JSON.stringify({
    btc: {
      tradingView: "CRYPTO:BTCUSD",
      display: "Bitcoin / U.S. Dollar",
      currency: "USD",
      channel: "crypto",
    },
  }));
  writeFileSync(value.channelsPath, JSON.stringify({ crypto: "" }));
  return value;
}

describe("preview chart publication file", () => {
  it("renders a local no-overwrite PNG/receipt pair from governed preview facts", async () => {
    const value = await createInputs();
    const result = await previewChartPublicationFile(value);

    expect(result).toMatchObject({
      ok: true,
      sourceBasename: "BTCUSD_2026-07-22_18-58-01.png",
      assetId: "btc",
      dataAsOf: "2026-07-22",
      metadata: {
        timeframe: "1H",
        market: "CRYPTO",
        dataSource: "CRYPTO",
        dataAsOf: "2026-07-22",
      },
    });
    expect(existsSync(value.outputPath)).toBe(true);
    expect(existsSync(value.receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(value.receiptPath, "utf8")) as {
      readonly metadata: { readonly dataSource: string; readonly chartAttribution: string };
    };
    expect(receipt.metadata).toEqual(expect.objectContaining({
      dataSource: "CRYPTO",
      chartAttribution: "Chart source: TradingView",
    }));
  });

  it("fails before rendering on a profile/Asset mismatch", async () => {
    const value = await createInputs();
    writeFileSync(value.profilePath, JSON.stringify({ schemaVersion: 1, assetId: "eth", timeframe: "1H" }));

    expect(await previewChartPublicationFile(value)).toMatchObject({
      ok: false,
      reason: "profile_asset_mismatch",
    });
    expect(existsSync(value.outputPath)).toBe(false);
    expect(existsSync(value.receiptPath)).toBe(false);
  });

  it("fails on invalid or unreadable profile evidence without producing artifacts", async () => {
    const value = await createInputs();
    writeFileSync(value.profilePath, JSON.stringify({ schemaVersion: 1, assetId: "btc", timeframe: "hourly" }));
    expect(await previewChartPublicationFile(value)).toMatchObject({ ok: false, reason: "invalid_profile" });
    rmSync(value.profilePath);
    expect(await previewChartPublicationFile(value)).toMatchObject({ ok: false, reason: "unreadable_profile" });
    expect(existsSync(value.outputPath)).toBe(false);
    expect(existsSync(value.receiptPath)).toBe(false);
  });
});

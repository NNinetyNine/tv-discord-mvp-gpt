import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChartPublicationMetadata } from "./chart-publication-template.ts";
import { renderChartPublication } from "./render-chart-publication.ts";
import { renderChartPublicationFile } from "./render-chart-publication-file.ts";

const METADATA: ChartPublicationMetadata = Object.freeze({
  title: "BTC PERPETUAL FUTURES",
  symbol: "BTCUSD",
  timeframe: "5M",
  market: "BINANCE",
  currency: "USD",
  dataSource: "BINANCE",
  dataAsOf: "2026-07-17",
  chartAttribution: "Chart source: TradingView",
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-chart-publication-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface FrameBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

async function makePng(path: string, frames: readonly FrameBounds[]): Promise<void> {
  const width = 320;
  const height = 220;
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
  for (const frame of frames) {
    for (let y = frame.top; y <= frame.bottom; y += 1) {
      for (let x = frame.left; x <= frame.right; x += 1) setPixel(x, y, 20);
    }
    for (let x = frame.left; x <= frame.right; x += 1) {
      setPixel(x, frame.top, 45);
      setPixel(x, frame.bottom, 45);
    }
    for (let y = frame.top; y <= frame.bottom; y += 1) {
      setPixel(frame.left, y, 45);
      setPixel(frame.right, y, 45);
    }
  }
  await sharp(data, { raw: { width, height, channels } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(path);
}

function writeMetadata(path: string, metadata: unknown = METADATA): void {
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

function fixturePaths(): {
  readonly input: string;
  readonly metadata: string;
  readonly output: string;
  readonly receipt: string;
} {
  return Object.freeze({
    input: join(root, "source.png"),
    metadata: join(root, "metadata.json"),
    output: join(root, "publication.png"),
    receipt: join(root, "publication.receipt.json"),
  });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("renderChartPublicationFile", () => {
  it("writes a deterministic publication and receipt while preserving source and metadata", async () => {
    const paths = fixturePaths();
    await makePng(paths.input, [{ left: 8, top: 12, right: 311, bottom: 190 }]);
    writeMetadata(paths.metadata);
    const sourceBefore = readFileSync(paths.input);
    const metadataBefore = readFileSync(paths.metadata);

    const result = await renderChartPublicationFile({
      inputPath: paths.input,
      metadataPath: paths.metadata,
      outputPath: paths.output,
      receiptPath: paths.receipt,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = readFileSync(paths.output);
    const receiptBytes = readFileSync(paths.receipt);
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as typeof result.receipt;
    expect(readFileSync(paths.input).equals(sourceBefore)).toBe(true);
    expect(readFileSync(paths.metadata).equals(metadataBefore)).toBe(true);
    expect(receipt.output.sha256).toBe(hash(output));
    expect(receipt.detection).toMatchObject({ left: 8, top: 12, right: 311, bottom: 190, width: 304, height: 179 });
    expect(receipt.placement).toEqual(result.receipt.placement);
    expect((await sharp(output).metadata())).toMatchObject({ width: 2048, height: receipt.output.height, format: "png" });
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("creates no artifacts when the detector rejects a no-frame source", async () => {
    const paths = fixturePaths();
    await makePng(paths.input, []);
    writeMetadata(paths.metadata);
    const result = await renderChartPublicationFile({
      inputPath: paths.input,
      metadataPath: paths.metadata,
      outputPath: paths.output,
      receiptPath: paths.receipt,
    });
    expect(result).toMatchObject({ ok: false, reason: "detector_rejected_source" });
    expect(existsSync(paths.output)).toBe(false);
    expect(existsSync(paths.receipt)).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("creates no artifacts for ambiguous or boundary-touching sources", async () => {
    const ambiguous = fixturePaths();
    await makePng(ambiguous.input, [
      { left: 8, top: 12, right: 150, bottom: 190 },
      { left: 169, top: 12, right: 311, bottom: 190 },
    ]);
    writeMetadata(ambiguous.metadata);
    const ambiguousResult = await renderChartPublicationFile({
      inputPath: ambiguous.input,
      metadataPath: ambiguous.metadata,
      outputPath: ambiguous.output,
      receiptPath: ambiguous.receipt,
    });
    expect(ambiguousResult).toMatchObject({
      ok: false,
      reason: "detector_rejected_source",
      detectorReason: "multiple_comparable_candidates",
    });
    expect(existsSync(ambiguous.output)).toBe(false);

    rmSync(ambiguous.input);
    await makePng(ambiguous.input, [{ left: 0, top: 0, right: 319, bottom: 219 }]);
    const boundaryResult = await renderChartPublicationFile({
      inputPath: ambiguous.input,
      metadataPath: ambiguous.metadata,
      outputPath: ambiguous.output,
      receiptPath: ambiguous.receipt,
    });
    expect(boundaryResult).toMatchObject({
      ok: false,
      reason: "detector_rejected_source",
      detectorReason: "touching_image_boundary",
    });
    expect(existsSync(ambiguous.output)).toBe(false);
    expect(existsSync(ambiguous.receipt)).toBe(false);
  });

  it("rejects source/output and source/receipt collisions", async () => {
    const paths = fixturePaths();
    await makePng(paths.input, [{ left: 8, top: 12, right: 311, bottom: 190 }]);
    writeMetadata(paths.metadata);
    expect(await renderChartPublicationFile({
      inputPath: paths.input,
      metadataPath: paths.metadata,
      outputPath: paths.input,
      receiptPath: paths.receipt,
    })).toMatchObject({ ok: false, reason: "source_output_collision" });
    expect(await renderChartPublicationFile({
      inputPath: paths.input,
      metadataPath: paths.metadata,
      outputPath: paths.output,
      receiptPath: paths.input,
    })).toMatchObject({ ok: false, reason: "source_output_collision" });
  });

  it("rejects output/receipt collision", async () => {
    const paths = fixturePaths();
    await makePng(paths.input, [{ left: 8, top: 12, right: 311, bottom: 190 }]);
    writeMetadata(paths.metadata);
    expect(await renderChartPublicationFile({
      inputPath: paths.input,
      metadataPath: paths.metadata,
      outputPath: paths.output,
      receiptPath: paths.output,
    })).toMatchObject({ ok: false, reason: "output_receipt_collision" });
  });

  it("does not overwrite existing output or receipt", async () => {
    const paths = fixturePaths();
    await makePng(paths.input, [{ left: 8, top: 12, right: 311, bottom: 190 }]);
    writeMetadata(paths.metadata);
    writeFileSync(paths.output, "keep output");
    expect(await renderChartPublicationFile({
      inputPath: paths.input,
      metadataPath: paths.metadata,
      outputPath: paths.output,
      receiptPath: paths.receipt,
    })).toMatchObject({ ok: false, reason: "output_already_exists" });
    expect(readFileSync(paths.output, "utf8")).toBe("keep output");

    rmSync(paths.output);
    writeFileSync(paths.receipt, "keep receipt");
    expect(await renderChartPublicationFile({
      inputPath: paths.input,
      metadataPath: paths.metadata,
      outputPath: paths.output,
      receiptPath: paths.receipt,
    })).toMatchObject({ ok: false, reason: "receipt_already_exists" });
    expect(readFileSync(paths.receipt, "utf8")).toBe("keep receipt");
  });

  it("rejects invalid metadata without producing temporary or final artifacts", async () => {
    const paths = fixturePaths();
    await makePng(paths.input, [{ left: 8, top: 12, right: 311, bottom: 190 }]);
    writeMetadata(paths.metadata, { ...METADATA, chartAttribution: "" });
    expect(await renderChartPublicationFile({
      inputPath: paths.input,
      metadataPath: paths.metadata,
      outputPath: paths.output,
      receiptPath: paths.receipt,
    })).toMatchObject({ ok: false, reason: "invalid_metadata" });
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rolls back the PNG when receipt finalization loses a no-overwrite race", async () => {
    const paths = fixturePaths();
    await makePng(paths.input, [{ left: 8, top: 12, right: 311, bottom: 190 }]);
    writeMetadata(paths.metadata);
    const result = await renderChartPublicationFile(
      {
        inputPath: paths.input,
        metadataPath: paths.metadata,
        outputPath: paths.output,
        receiptPath: paths.receipt,
      },
      {
        beforeFinalize: async () => {
          writeFileSync(paths.receipt, "raced receipt");
        },
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "finalize_failed" });
    expect(existsSync(paths.output)).toBe(false);
    expect(readFileSync(paths.receipt, "utf8")).toBe("raced receipt");
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("detects a source change after rendering and publishes no final artifacts", async () => {
    const paths = fixturePaths();
    await makePng(paths.input, [{ left: 8, top: 12, right: 311, bottom: 190 }]);
    writeMetadata(paths.metadata);
    const result = await renderChartPublicationFile(
      {
        inputPath: paths.input,
        metadataPath: paths.metadata,
        outputPath: paths.output,
        receiptPath: paths.receipt,
      },
      {
        render: async (sourceBytes, metadata) => {
          const rendered = await renderChartPublication(sourceBytes, metadata);
          writeFileSync(paths.input, Buffer.concat([readFileSync(paths.input), Buffer.from([0])]));
          return rendered;
        },
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "source_changed_during_render" });
    expect(existsSync(paths.output)).toBe(false);
    expect(existsSync(paths.receipt)).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

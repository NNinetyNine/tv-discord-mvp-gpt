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

import type { ChartPublicationMetadata } from "../rendering/chart-publication-template.ts";
import { renderChartPublication } from "../rendering/render-chart-publication.ts";
import { reviewChartPublicationFile } from "./publication-review-file.ts";

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

const APPROVED_REVIEW = Object.freeze({
  schemaVersion: 1,
  decision: "approved",
  reviewerId: "visionx-curator",
  reviewedAt: "2026-07-17T20:45:00Z",
  referenceId: "visionx.discord-chart.target-v1",
  notes: "Approved fixed-width, dynamic-height branded publication.",
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-publication-review-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeSource(path: string): Promise<Buffer> {
  const width = 180;
  const height = 120;
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
  const bytes = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  writeFileSync(path, bytes);
  return bytes;
}

interface FixturePaths {
  readonly source: string;
  readonly publication: string;
  readonly renderReceipt: string;
  readonly review: string;
  readonly output: string;
}

async function createFixture(decision: "approved" | "rejected" = "approved"): Promise<FixturePaths> {
  const paths: FixturePaths = Object.freeze({
    source: join(root, "source.png"),
    publication: join(root, "publication.png"),
    renderReceipt: join(root, "publication.receipt.json"),
    review: join(root, "review.json"),
    output: join(root, "publication.review.json"),
  });
  const source = await makeSource(paths.source);
  const rendered = await renderChartPublication(source, METADATA);
  if (!rendered.ok) throw new Error(rendered.detail);
  writeFileSync(paths.publication, rendered.outputPng);
  writeFileSync(paths.renderReceipt, rendered.receiptBytes);
  writeFileSync(paths.review, `${JSON.stringify({ ...APPROVED_REVIEW, decision }, null, 2)}\n`);
  return paths;
}

function options(paths: FixturePaths, includeSource = true, outputPath = paths.output) {
  return {
    publicationPath: paths.publication,
    renderReceiptPath: paths.renderReceipt,
    reviewPath: paths.review,
    outputPath,
    ...(includeSource ? { sourcePath: paths.source } : {}),
  };
}

function noTempFiles(): boolean {
  return !readdirSync(root).some((name) => name.includes(".visionx-review-") && name.endsWith(".tmp"));
}

describe("reviewChartPublicationFile", () => {
  it("writes an approved review with technical validation and exact hashes", async () => {
    const paths = await createFixture("approved");
    const inputs = [paths.source, paths.publication, paths.renderReceipt, paths.review].map((path) => readFileSync(path));
    const result = await reviewChartPublicationFile(options(paths));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicationApproved).toBe(true);
    expect(result.sourceReverified).toBe(true);
    expect(result.receipt.technicalValidation).toEqual({
      ok: true,
      publicationSha256: hash(inputs[1] ?? Buffer.alloc(0)),
      renderReceiptSha256: hash(inputs[2] ?? Buffer.alloc(0)),
      sourceReverified: true,
    });
    expect(result.receipt.publicationApproved).toBe(true);
    expect(result.receipt.review.decision).toBe("approved");
    expect(result.receipt.branding.watermarkOpacity).toBe(0.035);
    expect(readFileSync(paths.output, "utf8").endsWith("\n")).toBe(true);
    for (const [index, path] of [paths.source, paths.publication, paths.renderReceipt, paths.review].entries()) {
      expect(readFileSync(path).equals(inputs[index] ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it("writes a valid rejected review without treating rejection as command failure", async () => {
    const paths = await createFixture("rejected");
    const result = await reviewChartPublicationFile(options(paths));
    expect(result).toMatchObject({ ok: true, publicationApproved: false, sourceReverified: true });
    if (!result.ok) return;
    expect(result.receipt.review.decision).toBe("rejected");
    expect(result.receipt.technicalValidation.ok).toBe(true);
  });

  it("supports omitted source verification without discarding receipt source identity", async () => {
    const paths = await createFixture();
    const renderReceipt = JSON.parse(readFileSync(paths.renderReceipt, "utf8")) as { source: { sha256: string } };
    const result = await reviewChartPublicationFile(options(paths, false));
    expect(result).toMatchObject({ ok: true, sourceReverified: false });
    if (!result.ok) return;
    expect(result.receipt.source.sha256).toBe(renderReceipt.source.sha256);
    expect(result.receipt.technicalValidation.sourceReverified).toBe(false);
  });

  it("fails supplied source hash or dimension mismatches rather than downgrading verification", async () => {
    const paths = await createFixture();
    writeFileSync(paths.source, Buffer.concat([readFileSync(paths.source), Buffer.from([0])]));
    expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "source_hash_mismatch" });

    const second = await createFixture();
    const receipt = JSON.parse(readFileSync(second.renderReceipt, "utf8")) as Record<string, unknown> & { source: Record<string, unknown> };
    receipt.source = { ...receipt.source, sha256: hash(readFileSync(second.source)), width: 181 };
    writeFileSync(second.renderReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(await reviewChartPublicationFile(options(second))).toMatchObject({ ok: false, reason: "source_dimensions_mismatch" });
  });

  it("fails publication hash mismatches", async () => {
    const paths = await createFixture();
    writeFileSync(paths.publication, Buffer.concat([readFileSync(paths.publication), Buffer.from([0])]));
    expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "publication_hash_mismatch" });
    expect(existsSync(paths.output)).toBe(false);
  });

  it("fails publication dimension mismatches after matching the altered publication hash", async () => {
    const paths = await createFixture();
    const altered = await sharp(readFileSync(paths.publication)).resize({ width: 1024 }).png().toBuffer();
    writeFileSync(paths.publication, altered);
    const receipt = JSON.parse(readFileSync(paths.renderReceipt, "utf8")) as Record<string, unknown> & { output: Record<string, unknown> };
    receipt.output = { ...receipt.output, sha256: hash(altered) };
    writeFileSync(paths.renderReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "publication_dimensions_mismatch" });
  });

  it("rejects unsupported renderer, template, detector, and non-unique detection receipts", async () => {
    for (const mutate of [
      (receipt: any) => { receipt.renderer.id = "other"; },
      (receipt: any) => { receipt.renderer.version = 3; },
      (receipt: any) => { receipt.template.id = "other"; },
      (receipt: any) => { receipt.template.version = 3; },
      (receipt: any) => { receipt.detection.detectorId = "other"; },
      (receipt: any) => { receipt.detection.candidateCount = 2; },
    ]) {
      const paths = await createFixture();
      const receipt = JSON.parse(readFileSync(paths.renderReceipt, "utf8"));
      mutate(receipt);
      writeFileSync(paths.renderReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
      expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "invalid_render_receipt" });
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "visionx-publication-review-"));
    }
  });

  it("rejects incorrect branding asset identities and watermark opacity", async () => {
    const paths = await createFixture();
    const receipt = JSON.parse(readFileSync(paths.renderReceipt, "utf8"));
    receipt.branding.wordmark.assetSha256 = "0".repeat(64);
    writeFileSync(paths.renderReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "branding_identity_mismatch" });

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "visionx-publication-review-"));
    const second = await createFixture();
    const secondReceipt = JSON.parse(readFileSync(second.renderReceipt, "utf8"));
    secondReceipt.branding.watermark.opacity = 0.04;
    writeFileSync(second.renderReceipt, `${JSON.stringify(secondReceipt, null, 2)}\n`);
    expect(await reviewChartPublicationFile(options(second))).toMatchObject({ ok: false, reason: "invalid_render_receipt" });
  });

  it("rejects malformed review and render-receipt JSON", async () => {
    const paths = await createFixture();
    writeFileSync(paths.review, "{");
    expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "unreadable_review" });

    writeFileSync(paths.review, JSON.stringify(APPROVED_REVIEW));
    writeFileSync(paths.renderReceipt, "{");
    expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "unreadable_render_receipt" });
  });

  it("rejects invalid review metadata and creates no artifact", async () => {
    const paths = await createFixture();
    writeFileSync(paths.review, JSON.stringify({ ...APPROVED_REVIEW, decision: "implicit" }));
    expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "invalid_review" });
    expect(existsSync(paths.output)).toBe(false);
  });

  it("rejects output collisions with every input and never overwrites an existing output", async () => {
    const paths = await createFixture();
    for (const outputPath of [paths.publication, paths.renderReceipt, paths.review, paths.source]) {
      expect(await reviewChartPublicationFile(options(paths, true, outputPath))).toMatchObject({ ok: false, reason: "path_collision" });
    }
    writeFileSync(paths.output, "keep");
    expect(await reviewChartPublicationFile(options(paths))).toMatchObject({ ok: false, reason: "output_already_exists" });
    expect(readFileSync(paths.output, "utf8")).toBe("keep");
  });

  it("cleans temporary files after a pre-finalization failure", async () => {
    const paths = await createFixture();
    const result = await reviewChartPublicationFile(options(paths), {
      beforeFinalize: async () => { throw new Error("stop"); },
    });
    expect(result).toMatchObject({ ok: false, reason: "finalize_failed" });
    expect(existsSync(paths.output)).toBe(false);
    expect(noTempFiles()).toBe(true);
  });

  it("detects an input change before finalization", async () => {
    const paths = await createFixture();
    const result = await reviewChartPublicationFile(options(paths), {
      beforeFinalize: async () => {
        writeFileSync(paths.review, `${readFileSync(paths.review, "utf8")} `);
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "input_changed_during_review" });
    expect(existsSync(paths.output)).toBe(false);
    expect(noTempFiles()).toBe(true);
  });

  it("produces byte-identical path-neutral receipts for identical inputs", async () => {
    const paths = await createFixture();
    const firstOutput = join(root, "first.review.json");
    const secondOutput = join(root, "second.review.json");
    expect((await reviewChartPublicationFile(options(paths, true, firstOutput))).ok).toBe(true);
    expect((await reviewChartPublicationFile(options(paths, true, secondOutput))).ok).toBe(true);
    const first = readFileSync(firstOutput);
    const second = readFileSync(secondOutput);
    expect(first.equals(second)).toBe(true);
    const text = first.toString("utf8");
    expect(text).not.toContain(root);
    expect(text).not.toContain(paths.publication);
  });
});

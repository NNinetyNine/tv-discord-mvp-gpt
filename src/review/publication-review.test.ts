import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import type { ChartPublicationMetadata } from "../rendering/chart-publication-template.ts";
import { renderChartPublication } from "../rendering/render-chart-publication.ts";
import {
  buildPublicationReviewReceipt,
  PUBLICATION_REVIEW_MAX_LENGTHS,
  serializePublicationReviewReceipt,
  validateChartPublicationRenderReceipt,
  validatePublicationReviewMetadata,
} from "./publication-review.ts";

const REVIEW = Object.freeze({
  schemaVersion: 1,
  decision: "approved",
  reviewerId: "visionx-curator",
  reviewedAt: "2026-07-17T20:45:00Z",
  referenceId: "visionx.discord-chart.target-v1",
  notes: "Approved fixed-width, dynamic-height branded publication.",
});

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

async function makeSource(): Promise<Buffer> {
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
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

async function validRender() {
  const rendered = await renderChartPublication(await makeSource(), METADATA);
  if (!rendered.ok) throw new Error(rendered.detail);
  return rendered;
}

describe("publication review metadata", () => {
  it("accepts explicit approved and rejected decisions", () => {
    expect(validatePublicationReviewMetadata(REVIEW)).toMatchObject({ ok: true, review: { decision: "approved" } });
    expect(validatePublicationReviewMetadata({ ...REVIEW, decision: "rejected" })).toMatchObject({ ok: true, review: { decision: "rejected" } });
  });

  it("never infers approval when explicit review fields are missing", () => {
    expect(validatePublicationReviewMetadata({ schemaVersion: 1 })).toMatchObject({ ok: false });
    expect(validatePublicationReviewMetadata({ ...REVIEW, decision: undefined })).toMatchObject({ ok: false });
  });

  it("rejects unknown fields and unsupported schema versions", () => {
    expect(validatePublicationReviewMetadata({ ...REVIEW, extra: true })).toMatchObject({ ok: false });
    expect(validatePublicationReviewMetadata({ ...REVIEW, schemaVersion: 2 })).toMatchObject({ ok: false });
  });

  it("rejects invalid decisions, nulls, empty values, and control characters", () => {
    expect(validatePublicationReviewMetadata({ ...REVIEW, decision: "maybe" })).toMatchObject({ ok: false });
    expect(validatePublicationReviewMetadata({ ...REVIEW, reviewerId: null })).toMatchObject({ ok: false });
    expect(validatePublicationReviewMetadata({ ...REVIEW, referenceId: "  " })).toMatchObject({ ok: false });
    expect(validatePublicationReviewMetadata({ ...REVIEW, reviewerId: "curator\nother" })).toMatchObject({ ok: false });
  });

  it("rejects malformed, impossible, and timezone-free timestamps", () => {
    for (const reviewedAt of [
      "2026-07-17T20:45:00",
      "2026-02-30T20:45:00Z",
      "2026-07-17T25:45:00Z",
      "not-a-timestamp",
    ]) {
      expect(validatePublicationReviewMetadata({ ...REVIEW, reviewedAt })).toMatchObject({ ok: false });
    }
  });

  it("rejects overlong reviewer, reference, timestamp, and notes values", () => {
    expect(validatePublicationReviewMetadata({ ...REVIEW, reviewerId: "r".repeat(PUBLICATION_REVIEW_MAX_LENGTHS.reviewerId + 1) })).toMatchObject({ ok: false });
    expect(validatePublicationReviewMetadata({ ...REVIEW, referenceId: "r".repeat(PUBLICATION_REVIEW_MAX_LENGTHS.referenceId + 1) })).toMatchObject({ ok: false });
    expect(validatePublicationReviewMetadata({ ...REVIEW, reviewedAt: "2".repeat(PUBLICATION_REVIEW_MAX_LENGTHS.reviewedAt + 1) })).toMatchObject({ ok: false });
    expect(validatePublicationReviewMetadata({ ...REVIEW, notes: "n".repeat(PUBLICATION_REVIEW_MAX_LENGTHS.notes + 1) })).toMatchObject({ ok: false });
  });

  it("permits bounded multiline notes while preserving their exact value", () => {
    expect(validatePublicationReviewMetadata({ ...REVIEW, notes: "line one\nline two" })).toMatchObject({
      ok: true,
      review: { notes: "line one\nline two" },
    });
  });
});

describe("renderer receipt validation and review construction", () => {
  it("strictly accepts a genuine renderer version 2 receipt", async () => {
    const rendered = await validRender();
    expect(validateChartPublicationRenderReceipt(rendered.receipt)).toMatchObject({ ok: true });
  });

  it("rejects unknown nested receipt fields and unsupported identities", async () => {
    const rendered = await validRender();
    expect(validateChartPublicationRenderReceipt({ ...rendered.receipt, unknown: true })).toMatchObject({ ok: false });
    expect(validateChartPublicationRenderReceipt({ ...rendered.receipt, renderer: { ...rendered.receipt.renderer, id: "other" } })).toMatchObject({ ok: false });
    expect(validateChartPublicationRenderReceipt({ ...rendered.receipt, template: { ...rendered.receipt.template, version: 3 } })).toMatchObject({ ok: false });
  });

  it("rejects non-unique detection, incoherent bounds, and inconsistent output geometry", async () => {
    const rendered = await validRender();
    expect(validateChartPublicationRenderReceipt({ ...rendered.receipt, detection: { ...rendered.receipt.detection, candidateCount: 2 } })).toMatchObject({ ok: false });
    expect(validateChartPublicationRenderReceipt({ ...rendered.receipt, detection: { ...rendered.receipt.detection, width: rendered.receipt.detection.width + 1 } })).toMatchObject({ ok: false });
    expect(validateChartPublicationRenderReceipt({ ...rendered.receipt, output: { ...rendered.receipt.output, height: rendered.receipt.output.height + 1 } })).toMatchObject({ ok: false });
  });

  it("rejects incorrect watermark opacity and calculated layout placements", async () => {
    const rendered = await validRender();
    expect(validateChartPublicationRenderReceipt({
      ...rendered.receipt,
      branding: {
        ...rendered.receipt.branding,
        watermark: { ...rendered.receipt.branding.watermark, opacity: 0.04 },
      },
    })).toMatchObject({ ok: false });
    expect(validateChartPublicationRenderReceipt({
      ...rendered.receipt,
      placement: { ...rendered.receipt.placement, renderedLeft: rendered.receipt.placement.renderedLeft + 1 },
    })).toMatchObject({ ok: false });
  });

  it("sets the machine approval gate only for an explicit approved decision", async () => {
    const rendered = await validRender();
    const validated = validatePublicationReviewMetadata(REVIEW);
    if (!validated.ok) throw new Error(validated.detail);
    const approved = buildPublicationReviewReceipt({
      publicationSha256: rendered.receipt.output.sha256,
      renderReceiptSha256: createHash("sha256").update(rendered.receiptBytes).digest("hex"),
      sourceReverified: true,
      renderReceipt: rendered.receipt,
      review: validated.review,
    });
    const rejected = buildPublicationReviewReceipt({
      publicationSha256: rendered.receipt.output.sha256,
      renderReceiptSha256: createHash("sha256").update(rendered.receiptBytes).digest("hex"),
      sourceReverified: false,
      renderReceipt: rendered.receipt,
      review: { ...validated.review, decision: "rejected" },
    });
    expect(approved.publicationApproved).toBe(true);
    expect(approved.technicalValidation.ok).toBe(true);
    expect(rejected.publicationApproved).toBe(false);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.isFrozen(approved.review)).toBe(true);
  });

  it("serializes deterministic path-neutral JSON with one final newline", async () => {
    const rendered = await validRender();
    const validated = validatePublicationReviewMetadata(REVIEW);
    if (!validated.ok) throw new Error(validated.detail);
    const receipt = buildPublicationReviewReceipt({
      publicationSha256: rendered.receipt.output.sha256,
      renderReceiptSha256: createHash("sha256").update(rendered.receiptBytes).digest("hex"),
      sourceReverified: false,
      renderReceipt: rendered.receipt,
      review: validated.review,
    });
    const first = serializePublicationReviewReceipt(receipt);
    const second = serializePublicationReviewReceipt(receipt);
    expect(first.equals(second)).toBe(true);
    expect(first.toString("utf8").endsWith("\n")).toBe(true);
    expect(first.toString("utf8")).not.toContain("/tmp/");
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";

import type { CaptureFromFileReceipt } from "../application/capture-from-file.ts";
import { reportImportReceipt } from "./ingest-file.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingest-file delivery", () => {
  it("renders Pack interpretation entirely from the canonical receipt", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const receipt: CaptureFromFileReceipt = {
      ok: true,
      outcome: "staged",
      originalBasename: "BTCUSD_2026-06-25_01-18-55.png",
      assetId: "btc",
      assetDisplay: "Bitcoin",
      revisions: 2,
      placement: {
        kind: "pack",
        packId: "receipt-pack",
        packDisplay: "Receipt-owned Pack",
        packState: "building",
        capturedCount: 3,
        totalCount: 5,
        remainingRequiredAssets: [
          { id: "one", display: "First receipt requirement" },
          { id: "two", display: "Second receipt requirement" },
        ],
      },
    };

    const exitCode = reportImportReceipt(receipt);

    expect(exitCode).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "✓ Staged btc (Bitcoin) (Revision 2 — replaced the previous capture)",
      "  source:  BTCUSD_2026-06-25_01-18-55.png",
      "\nCounts toward receipt-pack (Receipt-owned Pack) — 3/5 captured",
      "Remaining required:",
      "  - one (First receipt requirement)",
      "  - two (Second receipt requirement)",
    ]);
  });

  it("renders a distinct rejection without collapsing its factual evidence", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const receipt: CaptureFromFileReceipt = {
      ok: false,
      outcome: "validation_failed",
      originalBasename: "AAPL_2026-06-25_01-21-06.png",
      assetId: "aapl",
      assetDisplay: "Apple",
      reason: "blank image",
      checks: { readable: true, notBlank: false },
    };

    const exitCode = reportImportReceipt(receipt);

    expect(exitCode).toBe(1);
    expect(error.mock.calls.map(([line]) => line)).toEqual([
      "✗ Validation failed for aapl (Apple): blank image",
      "  failed checks: notBlank",
    ]);
  });
});

import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

import type { Download, Page } from "playwright";

import type { Capturer, CaptureResult, Ticker } from "../types.ts";
import { launchSession } from "./browser.ts";
import { applyBranding } from "./branding.ts";
import { logger } from "../logger.ts";

/**
 * Native TradingView snapshot capture, triggered via keyboard shortcut.
 */

const SETTLE_MS = 2_000;
const NAV_TIMEOUT_MS = 60_000;
const CLICK_TIMEOUT_MS = 5_000;
const MENU_SETTLE_MS = 400;
const DOWNLOAD_TIMEOUT_MS = 15_000;

const SNAPSHOT_SHORTCUT = "Alt+Meta+S";

function safeName(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function clickFirst(
  page: Page,
  candidates: ReadonlyArray<{ name: string; selector: () => ReturnType<Page["locator"]> }>,
): Promise<string | null> {
  for (const c of candidates) {
    try {
      const first = c.selector().first();
      if ((await first.count()) === 0) continue;
      if (!(await first.isVisible().catch(() => false))) continue;
      await first.click({ timeout: CLICK_TIMEOUT_MS });
      return c.name;
    } catch {
      // try next
    }
  }
  return null;
}

async function clickDownloadImage(page: Page): Promise<string | null> {
  return clickFirst(page, [
    { name: 'menuitem "Download image"', selector: () => page.getByRole("menuitem", { name: /download image/i }) },
    { name: 'text "Download image"', selector: () => page.getByText(/download image/i) },
    { name: '[data-name*="download" i]', selector: () => page.locator('[data-name*="download" i]') },
  ]);
}

class SnapshotCapturer implements Capturer {
  async capture(ticker: Ticker): Promise<CaptureResult> {
    const outDir = resolve(process.cwd(), process.env.IMAGE_OUTPUT_DIR ?? "./output");
    mkdirSync(outDir, { recursive: true });

    const capturedAt = new Date().toISOString();
    const fileName = `${safeName(ticker.symbol)}_${capturedAt.replace(/[:.]/g, "-")}.png`;
    const imagePath = resolve(outDir, fileName);

    const session = await launchSession();
    let suggestedFilename = "";

    try {
      const page = await session.page();

      const t0 = Date.now();

      await page.goto(ticker.tvLayoutUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });

      await page.waitForSelector("canvas", { timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      const tReady = Date.now();

      const downloadPromise: Promise<Download | null> = page
        .waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS })
        .catch(() => null);

      await page.keyboard.press(SNAPSHOT_SHORTCUT);

      await page.waitForTimeout(MENU_SETTLE_MS);
      const dlMatched = await clickDownloadImage(page);
      const tClicked = Date.now();

      const download = await downloadPromise;

      if (!download) {
        throw new Error(`no download after snapshot shortcut (downloadAction=${dlMatched ?? "none"})`);
      }

      await download.saveAs(imagePath);
      suggestedFilename = download.suggestedFilename();
      const tSaved = Date.now();

      await applyBranding(imagePath);
      const tBrand = Date.now();

      logger.info(
        {
          symbol: ticker.symbol,
          snapshotTrigger: "keyboard Alt+Meta+S",
          downloadAction: dlMatched,
          suggestedFilename,
          readyMs: tReady - t0,
          clickMs: tClicked - tReady,
          downloadMs: tSaved - tClicked,
          brandingMs: tBrand - tSaved,
          totalMs: tBrand - t0,
        },
        "capture timing",
      );
    } finally {
      await session.close();
    }

    return { imagePath, capturedAt, suggestedFilename };
  }
}

export const capturer: Capturer = new SnapshotCapturer();
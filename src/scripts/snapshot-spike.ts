import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import type { Download, Page } from "playwright";

import { launchSession } from "../capture/browser.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../logger.ts";

/**
 * THROWAWAY SPIKE — not wired into the pipeline. Answers: when we click
 * TradingView's native "Take a snapshot" button, what happens, and can we
 * retrieve the resulting image WITHOUT brittle clipboard-image/OCR hacks?
 *
 * It arms listeners for all plausible retrieval paths BEFORE clicking, clicks
 * the snapshot button, then reports which path fired:
 *   A) download event          -> save file directly       (cleanest)
 *   B) clipboard TEXT = URL     -> fetch the image          (clean-ish)
 *   C) a link/href in a popup   -> fetch the image          (clean-ish)
 *   D) a modal/menu appears     -> we dump its buttons so you can pick an action
 *
 * Nothing here changes capture/validation/Discord. Adjust ONLY the snapshot
 * button selector if your build differs (we expect data-name or aria below).
 */

const SETTLE_MS = 5_000;
const NAV_TIMEOUT_MS = 60_000;
const DOWNLOAD_WAIT_MS = 8_000;

async function openChart(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector("canvas", { timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
}

/** Find the "Take a snapshot" control; try a few robust locators. */
async function clickSnapshot(page: Page): Promise<string | null> {
  const candidates: Array<{ name: string; click: () => Promise<void> }> = [
    { name: '[data-name="header-toolbar-screenshot"]', click: () => page.locator('[data-name="header-toolbar-screenshot"]').first().click({ timeout: 5_000 }) },
    { name: 'aria "Take a snapshot"', click: () => page.getByRole("button", { name: /take a snapshot/i }).first().click({ timeout: 5_000 }) },
    { name: '[aria-label*="snapshot" i]', click: () => page.locator('[aria-label*="snapshot" i]').first().click({ timeout: 5_000 }) },
  ];
  for (const c of candidates) {
    try {
      await c.click();
      return c.name;
    } catch {
      // try next
    }
  }
  return null;
}

/** Dump any menu/modal items that appeared after the click (path D). */
async function dumpMenu(page: Page): Promise<void> {
  const items = page.locator('[role="menuitem"], [role="dialog"] button, [data-name] [role="button"]');
  const n = await items.count();
  logger.info({ menuItems: n }, "post-click menu/modal items (path D candidates)");
  for (let i = 0; i < Math.min(n, 30); i++) {
    const it = items.nth(i);
    const aria = await it.getAttribute("aria-label").catch(() => null);
    let text = "";
    try { text = (await it.innerText({ timeout: 300 })).trim().slice(0, 50); } catch { text = ""; }
    const label = aria ?? text;
    if (label) console.log(JSON.stringify({ i, aria, text }));
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ticker = config.tickers[0];
  if (!ticker) {
    logger.fatal("no tickers configured");
    process.exitCode = 1;
    return;
  }

  const outDir = resolve(process.cwd(), "output");
  mkdirSync(outDir, { recursive: true });

  const session = await launchSession({ headless: false });
  try {
    const page = await session.page();

    // Grant clipboard read for path B (best-effort; may not apply on all OSes).
    await session.context
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://www.tradingview.com" })
      .catch(() => {});

    await openChart(page, ticker.tvLayoutUrl);

    // --- ARM listeners BEFORE clicking ---
    let download: Download | null = null;
    const downloadPromise = page
      .waitForEvent("download", { timeout: DOWNLOAD_WAIT_MS })
      .then((d) => { download = d; })
      .catch(() => {});

    let popupUrl: string | null = null;
    const popupPromise = page
      .waitForEvent("popup", { timeout: DOWNLOAD_WAIT_MS })
      .then((p) => { popupUrl = p.url(); })
      .catch(() => {});

    // --- CLICK ---
    const matched = await clickSnapshot(page);
    logger.info({ matched }, matched ? "clicked snapshot button" : "snapshot button NOT found");
    if (!matched) {
      process.exitCode = 1;
      return;
    }

    // Give the action a moment, then resolve whichever path fired.
    await Promise.race([downloadPromise, popupPromise, page.waitForTimeout(DOWNLOAD_WAIT_MS)]);
    await page.waitForTimeout(1_500);

    // PATH A: download event
    if (download) {
      const dl: Download = download;
      const outPath = resolve(outDir, "spike-snapshot-download.png");
      await dl.saveAs(outPath);
      logger.info({ outPath, suggested: dl.suggestedFilename() }, "PATH A: snapshot DOWNLOADED");
      return;
    }

    // PATH B: clipboard text = URL
    let clip = "";
    try {
      clip = await page.evaluate(
        `(async () => { try { return await navigator.clipboard.readText(); } catch { return ""; } })()`,
      );
    } catch {
      clip = "";
    }
    if (/^https?:\/\/\S+/.test(clip)) {
      logger.info({ url: clip }, "PATH B: snapshot URL on CLIPBOARD; fetching");
      const resp = await page.request.get(clip.trim());
      if (resp.ok()) {
        const outPath = resolve(outDir, "spike-snapshot-url.png");
        writeFileSync(outPath, await resp.body());
        logger.info({ outPath }, "PATH B: snapshot image SAVED from clipboard URL");
        return;
      }
      logger.warn({ status: resp.status() }, "PATH B: URL fetch failed");
    }

    // PATH C: popup URL
    if (popupUrl && /^https?:\/\//.test(popupUrl)) {
      logger.info({ popupUrl }, "PATH C: snapshot opened in a POPUP; (inspect URL — may be an image or share page)");
    }

    // PATH D: a modal/menu opened instead of an immediate action
    await dumpMenu(page);

    logger.warn(
      { clipboardSample: clip.slice(0, 80) },
      "no download/clipboard-URL/popup captured — review the menu dump above and the open browser window",
    );
  } finally {
    // Keep the browser open a few seconds so you can SEE what happened.
    logger.info("inspect the browser window now; closing in 8s");
    await new Promise((r) => setTimeout(r, 8_000));
    await session.close();
  }
}

main().catch((e: unknown) => {
  logger.fatal({ error: e instanceof Error ? e.message : String(e) }, "snapshot-spike failed");
  process.exitCode = 1;
});
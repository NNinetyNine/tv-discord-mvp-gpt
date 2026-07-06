import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

import { launchSession } from "../capture/browser.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../logger.ts";

/**
 * Day 3: prove the saved session loads a real chart.
 *
 * Reuses the persistent login (NO manual auth), opens the first ticker's
 * layout, waits for the chart to render, does a best-effort logged-in check,
 * and saves ONE verification screenshot so you can eyeball the result.
 *
 * NOTE: that screenshot is a throwaway debugging aid, NOT the capture feature.
 * The real Capturer implementation lands on Day 4.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    logger.fatal({ error: e instanceof Error ? e.message : String(e) }, "config load failed");
    process.exitCode = 1;
    return;
  }

  const ticker = config.tickers[0];
  if (!ticker) {
    logger.fatal("no tickers configured");
    process.exitCode = 1;
    return;
  }

  // Headed so you can watch it load on Day 3.
  const session = await launchSession({ headless: false });
  try {
    const page = await session.page();

    logger.info({ url: ticker.tvLayoutUrl }, "loading TradingView layout...");
    await page.goto(ticker.tvLayoutUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // TradingView renders the chart into a <canvas>. Wait for it to exist.
    await page.waitForSelector("canvas", { timeout: 60_000 });

    // TV streams data over websockets, so 'networkidle' never settles. Use a
    // fixed settle delay to let candles/indicators/drawings paint. Crude but
    // adequate for Day 3 verification.
    await page.waitForTimeout(5_000);

    // Best-effort logged-in check. Selector is brittle by nature — the
    // screenshot below is the real confirmation.
    const signInVisible = await page
      .getByText("Sign in", { exact: false })
      .first()
      .isVisible()
      .catch(() => false);

    if (signInVisible) {
      logger.warn("a 'Sign in' control is visible — session may NOT be logged in; re-run login");
    } else {
      logger.info("no 'Sign in' control detected — session appears logged in");
    }

    const outDir = resolve(process.cwd(), process.env.IMAGE_OUTPUT_DIR ?? "./output");
    mkdirSync(outDir, { recursive: true });
    const shotPath = resolve(outDir, "load-chart-verification.png");
    await page.screenshot({ path: shotPath });
    logger.info({ shotPath }, "verification screenshot saved — open it to confirm the chart rendered");
  } finally {
    await session.close();
  }
}

main().catch((e: unknown) => {
  logger.fatal({ error: e instanceof Error ? e.message : String(e) }, "load-chart failed");
  process.exitCode = 1;
});
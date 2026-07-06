import { createInterface } from "node:readline/promises";

import { launchSession } from "../capture/browser.ts";
import { logger } from "../logger.ts";

/**
 * Day 3: one-time manual login.
 *
 * Opens a real (headed) browser at tradingview.com. You log in BY HAND in that
 * window — including any 2FA — then press ENTER in the terminal. We never type
 * your credentials programmatically (safer, and avoids tripping anti-bot). On
 * exit the session is written to the persistent profile dir for reuse.
 */
async function main(): Promise<void> {
  logger.info("opening headed browser for manual TradingView login...");
  const session = await launchSession({ headless: false });

  try {
    const page = await session.page();
    await page.goto("https://www.tradingview.com/", { waitUntil: "domcontentloaded" });

    logger.info("browser is open — log into TradingView in that window now");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("After you are fully logged in, press ENTER here to save the session... ");
    rl.close();
  } finally {
    await session.close();
  }

  logger.info("session saved to the persistent profile — you can now run load-chart");
}

main().catch((e: unknown) => {
  logger.fatal({ error: e instanceof Error ? e.message : String(e) }, "login failed");
  process.exitCode = 1;
});
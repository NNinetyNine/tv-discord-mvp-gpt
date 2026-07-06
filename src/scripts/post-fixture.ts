import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { loadConfig } from "../config.ts";
import { publish } from "../publish/discord.ts";
import { logger } from "../logger.ts";

/**
 * Day 2 test harness. Posts fixtures/sample-chart.png directly to the channel
 * in the FIRST entry of config/tickers.json — bypassing capture/validation —
 * so we can prove Discord publishing works in isolation.
 */
async function main(): Promise<void> {
  const imagePath = resolve(process.cwd(), "fixtures", "sample-chart.png");
  if (!existsSync(imagePath)) {
    logger.fatal({ imagePath }, "fixture image not found");
    process.exitCode = 1;
    return;
  }

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

  logger.info({ imagePath, channelId: ticker.discordChannelId }, "posting fixture to Discord...");
  await publish(imagePath, ticker.discordChannelId);
  logger.info("fixture posted to Discord successfully");
}

main().catch((e: unknown) => {
  logger.fatal({ error: e instanceof Error ? e.message : String(e) }, "post-fixture failed");
  process.exitCode = 1;
});
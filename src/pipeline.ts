import { randomUUID } from "node:crypto";

import type { AppConfig } from "./config.ts";
import type { Capturer, Outcome, Publisher, Ticker, Validator } from "./types.ts";
import { logger } from "./logger.ts";

/**
 * Dependencies are injected so the pipeline depends only on the seam
 * (Capturer / Validator / Publisher), never on concrete implementations.
 * This is what lets capture/validate/publish be swapped independently.
 */
export interface PipelineDeps {
  readonly capturer: Capturer;
  readonly validate: Validator;
  readonly publish: Publisher;
}

interface TickerLog {
  runId: string;
  ticker: string;
  outcome: Outcome;
  durationMs: number;
  imagePath?: string;
  checks?: Readonly<Record<string, boolean>>;
  reason?: string;
  error?: string;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Process one ticker. Never throws — every path resolves to a logged outcome. */
async function processTicker(
  runId: string,
  ticker: Ticker,
  deps: PipelineDeps,
): Promise<Outcome> {
  const start = Date.now();
  const base = { runId, ticker: ticker.symbol };

  // --- capture ---
  let imagePath: string;
  try {
    const result = await deps.capturer.capture(ticker);
    imagePath = result.imagePath;
  } catch (e) {
    const log: TickerLog = {
      ...base,
      outcome: "error_capture",
      durationMs: Date.now() - start,
      error: errMessage(e),
    };
    logger.error(log, "ticker outcome");
    return "error_capture";
  }

  // --- validate (fail-closed) ---
  let validation;
  try {
    validation = await deps.validate(imagePath, ticker);
  } catch (e) {
    // A validator that throws is treated as a failed validation, not a crash.
    const log: TickerLog = {
      ...base,
      outcome: "skipped_validation",
      durationMs: Date.now() - start,
      imagePath,
      reason: `validator threw: ${errMessage(e)}`,
    };
    logger.warn(log, "ticker outcome");
    return "skipped_validation";
  }

  if (!validation.ok) {
    const log: TickerLog = {
      ...base,
      outcome: "skipped_validation",
      durationMs: Date.now() - start,
      imagePath,
      checks: validation.checks,
      ...(validation.reason ? { reason: validation.reason } : {}),
    };
    logger.warn(log, "ticker outcome");
    return "skipped_validation";
  }

  // --- publish ---
  try {
    await deps.publish(imagePath, ticker.discordChannelId);
  } catch (e) {
    const log: TickerLog = {
      ...base,
      outcome: "error_publish",
      durationMs: Date.now() - start,
      imagePath,
      error: errMessage(e),
    };
    logger.error(log, "ticker outcome");
    return "error_publish";
  }

  const log: TickerLog = {
    ...base,
    outcome: "published",
    durationMs: Date.now() - start,
    imagePath,
    checks: validation.checks,
  };
  logger.info(log, "ticker outcome");
  return "published";
}

/**
 * Run one full cycle over all configured tickers, sequentially.
 * One ticker's failure never aborts the run (isolation). Returns a summary.
 */
export async function runCycle(
  config: AppConfig,
  deps: PipelineDeps,
): Promise<Record<Outcome, number>> {
  const runId = randomUUID();
  const summary: Record<Outcome, number> = {
    published: 0,
    skipped_validation: 0,
    error_capture: 0,
    error_publish: 0,
  };

  logger.info({ runId, tickerCount: config.tickers.length }, "cycle start");

  for (const ticker of config.tickers) {
    const outcome = await processTicker(runId, ticker, deps);
    summary[outcome] += 1;
  }

  logger.info({ runId, summary }, "cycle complete");
  return summary;
}
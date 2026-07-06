import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";

import type { Ticker } from "./types.ts";

export interface AppConfig {
  readonly tickers: readonly Ticker[];
  readonly imageOutputDir: string;
}

const TICKERS_PATH = resolve(process.cwd(), "config", "tickers.json");

/** Throws a clear, non-stack-trace error for any config problem. */
class ConfigError extends Error {
  constructor(message: string) {
    super(`Config error: ${message}`);
    this.name = "ConfigError";
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Validate one raw record into a Ticker, or throw with the offending index. */
function parseTicker(raw: unknown, index: number): Ticker {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`tickers[${index}] is not an object`);
  }
  const r = raw as Record<string, unknown>;

  if (!isNonEmptyString(r.symbol)) {
    throw new ConfigError(`tickers[${index}].symbol must be a non-empty string`);
  }
  if (!isNonEmptyString(r.tvLayoutUrl)) {
    throw new ConfigError(`tickers[${index}].tvLayoutUrl must be a non-empty string`);
  }
  if (!isNonEmptyString(r.discordChannelId)) {
    throw new ConfigError(`tickers[${index}].discordChannelId must be a non-empty string`);
  }
  if (!isPositiveInt(r.expectedWidth)) {
    throw new ConfigError(`tickers[${index}].expectedWidth must be a positive integer`);
  }
  if (!isPositiveInt(r.expectedHeight)) {
    throw new ConfigError(`tickers[${index}].expectedHeight must be a positive integer`);
  }

  return {
    symbol: r.symbol,
    tvLayoutUrl: r.tvLayoutUrl,
    discordChannelId: r.discordChannelId,
    expectedWidth: r.expectedWidth,
    expectedHeight: r.expectedHeight,
  };
}

export function loadConfig(): AppConfig {
  let rawText: string;
  try {
    rawText = readFileSync(TICKERS_PATH, "utf8");
  } catch {
    throw new ConfigError(`could not read ${TICKERS_PATH}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new ConfigError(`${TICKERS_PATH} is not valid JSON`);
  }

  if (!Array.isArray(parsed)) {
    throw new ConfigError(`${TICKERS_PATH} must contain a JSON array of tickers`);
  }
  if (parsed.length === 0) {
    throw new ConfigError(`${TICKERS_PATH} must contain at least one ticker`);
  }

  const tickers = parsed.map(parseTicker);

  return {
    tickers,
    imageOutputDir: resolve(process.cwd(), process.env.IMAGE_OUTPUT_DIR ?? "./output"),
  };
}
import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const pretty = (process.env.LOG_PRETTY ?? "true") === "true";

/**
 * Structured logger. One JSON object per event.
 * In dev we pretty-print; in prod (LOG_PRETTY=false) we emit raw JSON lines
 * suitable for ingestion. Never log secrets.
 */
export const logger = pino(
  {
    level,
    base: undefined, // drop pid/hostname noise for a small MVP
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pretty
    ? pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      })
    : pino.destination(1),
);
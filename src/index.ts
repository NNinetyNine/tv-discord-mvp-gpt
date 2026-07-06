import { loadConfig } from "./config.ts";
import { runCycle, type PipelineDeps } from "./pipeline.ts";
import { capturer } from "./capture/index.ts";
import { validate } from "./validate/checks.ts";
import { publish } from "./publish/discord.ts";
import { logger } from "./logger.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    // Config problems are operator errors: log a clean message, exit non-zero.
    logger.fatal({ error: e instanceof Error ? e.message : String(e) }, "startup failed");
    process.exitCode = 1;
    return;
  }

  const deps: PipelineDeps = { capturer, validate, publish };

  const summary = await runCycle(config, deps);

  // A cycle that published nothing is a soft failure worth a non-zero exit
  // so a scheduler/operator notices. (Day 1 happy path should publish >= 1.)
  if (summary.published === 0) {
    logger.warn({ summary }, "cycle produced zero successful publishes");
    process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  logger.fatal({ error: e instanceof Error ? e.message : String(e) }, "unhandled error");
  process.exitCode = 1;
});
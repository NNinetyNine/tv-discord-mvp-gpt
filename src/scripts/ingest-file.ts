import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { buildApp, type App } from "../composition/app.ts";
import type { CaptureAttemptResult } from "../wiring/capture-once.ts";
import type { Asset } from "../types.ts";

/**
 * Operator entrypoint: ingest ONE manually exported TradingView PNG.
 *
 * Workflow: you manually frame a chart in TradingView, trigger its native image
 * export, then run this on the exported file:
 *
 *   tsx src/scripts/ingest-file.ts <path-to-export.png>
 *
 * It builds the app (composition root), ingests the file through the proven
 * file-ingest path (captureFromFile -> captureOnce -> resolve/decide/validate/
 * stage/record), and prints the outcome.
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, invoking buildApp/captureFromFile, and printing. All assembly lives
 * in buildApp; all orchestration in the services. Nothing here is imported by
 * the runtime, so `npm run start` is untouched.
 *
 * Configuration:
 *   - session file, staging dir, and release archive default to ./session.json,
 *     ./staging and ./archive, resolved against process.cwd(). RUN THIS FROM THE
 *     PROJECT ROOT so repeated runs accumulate into the same session/staging
 *     (capture one asset, run again for the next, all within the active pack).
 *   - IMAGE_OUTPUT_DIR (existing env var, read by the file-ingest source) still
 *     controls where branded custody copies land; this script does not touch it.
 *
 * This script only captures; it never publishes.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");
const ARCHIVE_DIR = resolve(process.cwd(), "archive");

/** Human-readable "id (Display)" for an asset id, via the registry catalog. */
function label(app: App, assetId: string): string {
  const asset: Asset | undefined = app.registry.all().find((a) => a.id === assetId);
  return asset ? `${asset.id} (${asset.display})` : assetId;
}

/** Print the active pack's progress: captured count + pending assets. */
function printProgress(app: App): void {
  const pack = app.session.activePack();
  if (pack === null) {
    console.log("Session complete — no active pack remaining.");
    return;
  }
  const progress = app.session.progress();
  const pending = app.session.pendingAssets();
  const capturedCount = progress ? progress.captured : app.session.capturedAssets().length;

  console.log(`\nActive pack: ${pack.id} (${pack.display}) — ${capturedCount}/${pack.assets.length} captured`);
  if (pending.length === 0) {
    console.log("All assets in this pack are captured.");
  } else {
    console.log("Pending:");
    for (const assetId of pending) {
      console.log(`  - ${label(app, assetId)}`);
    }
  }
}

/** Print the capture outcome. Returns the process exit code (0 only on staged). */
function report(app: App, filePath: string, result: CaptureAttemptResult): number {
  if (result.ok) {
    // outcome === "staged"
    const replaced = result.replaced ? " (replaced an existing capture)" : "";
    console.log(`✓ Staged ${label(app, result.asset.id)} into pack "${result.packId}"${replaced}`);
    console.log(`  source:  ${filePath}`);
    console.log(`  staged:  ${result.stagedPath}`);
    printProgress(app);
    return 0;
  }

  switch (result.outcome) {
    case "unparseable_filename":
      console.error(`✗ Could not parse a symbol from the filename: "${result.filename}"`);
      console.error("  Expected a TradingView-style name like SYMBOL_YYYY-MM-DD_HH-MM-SS.png");
      return 1;

    case "unknown_symbol":
      // The reconciliation surface: show exactly the normalized symbol that
      // failed to resolve, so a registry/normalizer mismatch is legible.
      console.error(`✗ Symbol "${result.symbol}" is not in the registry.`);
      console.error("  The exported filename's symbol did not match any registry `tradingView` token.");
      console.error("  If this is a real, expected chart, the registry or normalizer may need reconciling.");
      return 1;

    case "no_active_pack":
      console.error("✗ No active pack — the session is complete. Nothing to capture into.");
      return 1;

    case "not_in_active_pack":
      console.error(
        `✗ ${label(app, result.asset.id)} is not in the active pack "${result.activePackId}".`,
      );
      console.error("  Capture assets belonging to the active pack, or advance/publish to reach its pack.");
      printProgress(app);
      return 1;

    case "validation_failed": {
      console.error(`✗ Validation failed for ${label(app, result.asset.id)}: ${result.reason}`);
      const failed = Object.entries(result.checks)
        .filter(([, passed]) => passed === false)
        .map(([name]) => name);
      if (failed.length > 0) console.error(`  failed checks: ${failed.join(", ")}`);
      return 1;
    }

    case "staging_failed":
      console.error(`✗ Failed to stage ${label(app, result.asset.id)}: ${result.detail}`);
      return 1;

    case "capture_failed":
      console.error(`✗ Could not ingest the file: ${result.detail}`);
      return 1;

    default: {
      // Exhaustiveness guard: if a new outcome is added, this surfaces it.
      const _exhaustive: never = result;
      console.error(`✗ Unrecognized outcome: ${JSON.stringify(_exhaustive)}`);
      return 1;
    }
  }
}

async function main(): Promise<void> {
  const filePathArg = process.argv[2];
  if (!filePathArg || filePathArg.trim().length === 0) {
    console.error("Usage: tsx src/scripts/ingest-file.ts <path-to-export.png>");
    process.exitCode = 2;
    return;
  }

  const filePath = resolve(process.cwd(), filePathArg);
  if (!existsSync(filePath)) {
    console.error(`✗ File not found: ${filePath}`);
    process.exitCode = 2;
    return;
  }

  const app = buildApp({
    sessionPath: SESSION_PATH,
    stagingDir: STAGING_DIR,
    archiveDir: ARCHIVE_DIR,
  });

  const result = await app.captureFromFile(filePath);
  process.exitCode = report(app, filePath, result);
}

main().catch((e: unknown) => {
  // A genuine programming/configuration fault (e.g. config failed to load).
  console.error(`✗ Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
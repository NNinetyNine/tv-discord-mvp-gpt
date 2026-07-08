import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { buildApp, type App } from "../composition/app.ts";
import type { CaptureAttemptResult } from "../wiring/capture-once.ts";
import type { Asset } from "../types.ts";

/**
 * Operator entrypoint: ingest ONE manually exported TradingView PNG.
 *
 * Workflow: you manually frame a chart in TradingView, trigger its native image
 * export, then run this on the exported file. Pass the REAL path to your
 * downloaded PNG (no angle brackets):
 *
 *   tsx src/scripts/ingest-file.ts ~/Downloads/BTCUSD_2026-06-25_01-18-55.png
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

const USAGE = [
  "Ingest one manually exported TradingView PNG into the active pack.",
  "",
  "Usage:",
  "  tsx src/scripts/ingest-file.ts <path>       (replace <path> with your real file)",
  "",
  "Example (use your actual downloaded file — do not type angle brackets):",
  "  tsx src/scripts/ingest-file.ts ~/Downloads/BTCUSD_2026-06-25_01-18-55.png",
  "",
  "Run from the project root so ./session.json and ./staging stay consistent.",
].join("\n");

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
    console.log(`✓ Captured ${label(app, result.asset.id)} into pack "${result.packId}".`);
    console.log(`  staged: ${result.stagedPath}`);
    printProgress(app);
    return 0;
  }

  switch (result.reason) {
    case "unknown_symbol":
      console.error(`✗ Unknown symbol "${result.symbol}" (from ${filePath}).`);
      console.error(`  If this is a real asset, add it (or a tradingViewAlias) to config/registry.json.`);
      return 1;
    case "unparseable_filename":
      console.error(`✗ Could not parse a symbol out of the filename: ${filePath}`);
      console.error(`  Expected a TradingView export name like SYMBOL_YYYY-MM-DD_HH-mm-ss.png`);
      return 1;
    case "not_in_active_pack": {
      const active = app.session.activePack();
      const packName = active ? `${active.id} (${active.display})` : "—";
      console.error(`✗ ${label(app, result.asset.id)} is not part of the ACTIVE pack ${packName}.`);
      console.error(`  Capture the pending assets of the active pack first (see below), or advance packs.`);
      printProgress(app);
      return 1;
    }
    case "duplicate":
      console.error(`✗ ${label(app, result.asset.id)} is already captured in the active pack.`);
      console.error(`  (Re-ingesting the same asset replaces its staged image only if you re-run after a new export;`);
      console.error(`   the session keeps one capture per asset.)`);
      printProgress(app);
      return 1;
    case "validation_failed":
      console.error(`✗ Image failed validation: ${result.detail}`);
      console.error(`  The file may be blank, truncated, or not a real chart export. Re-export and retry.`);
      return 1;
    case "capture_failed":
      console.error(`✗ Could not read/copy the file: ${result.detail}`);
      return 1;
    default: {
      const _exhaustive: never = result;
      console.error(`✗ Unrecognized result: ${JSON.stringify(_exhaustive)}`);
      return 1;
    }
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];

  if (arg === "-h" || arg === "--help" || arg === undefined) {
    console.log(USAGE);
    process.exitCode = arg === undefined ? 2 : 0;
    return;
  }

  // Common operator mistake: pasting the usage line's literal "<path>".
  if (arg.startsWith("<")) {
    console.error(`✗ "${arg}" looks like a placeholder. Pass your real file path (no angle brackets).\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const filePath = resolve(process.cwd(), arg);
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
  console.error(`✗ Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
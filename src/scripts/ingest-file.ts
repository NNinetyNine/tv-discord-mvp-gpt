import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { buildApp, type App } from "../composition/app.ts";
import type { CaptureAttemptResult } from "../wiring/capture-once.ts";
import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";

/**
 * Operator entrypoint: ingest ONE manually exported TradingView PNG.
 *
 * Workflow: you manually frame a chart in TradingView, trigger its native image
 * export, then run this on the exported file:
 *
 *   tsx src/scripts/ingest-file.ts <path-to-export.png>
 *
 * ROUTING IS BY IDENTITY (Constitution §4.1): the chart lands on its Asset —
 * there is no active pack and no targeting. The receipt then reports the
 * FACTS: which pack (if any) the capture counts toward, that pack's remaining
 * required assets, or — for an asset in no pack — that the work is held
 * (§4.6: it exists, counts toward nothing, and starts counting the moment a
 * pack includes the asset).
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, invoking buildApp/captureFromFile, and printing (including the
 * local three-line membership derivation over workspace.packs() — the
 * delivery layer composes sentences from facts). Nothing here is imported by
 * the runtime, so `npm run start` is untouched.
 *
 * Configuration:
 *   - working-state file, staging dir, and release archive default to
 *     ./session.json, ./staging and ./archive, resolved against process.cwd().
 *     RUN THIS FROM THE PROJECT ROOT so repeated runs accumulate into the same
 *     workspace/staging.
 *   - IMAGE_OUTPUT_DIR (existing env var, read by the file-ingest source) still
 *     controls where branded custody copies land; this script does not touch it.
 *
 * This script only captures; it never publishes.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");
const ARCHIVE_DIR = resolve(process.cwd(), "archive");
const REGISTRY_PATH = resolve(process.cwd(), "config", "registry.json");
const PACKS_PATH = resolve(process.cwd(), "config", "packs.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

/** Human-readable "id (Display)" for an asset id, via the registry catalog. */
function label(app: App, assetId: string): string {
  const asset: Asset | undefined = app.registry.all().find((a) => a.id === assetId);
  return asset ? `${asset.id} (${asset.display})` : assetId;
}

/** The pack containing this asset, derived locally from the definitions (§9.1: at most one). */
function packContaining(app: App, assetId: string): Pack | null {
  return app.workspace.packs().find((p) => p.assets.includes(assetId)) ?? null;
}

/** Print the receipt facts for the pack this capture counts toward. */
function printPackFacts(app: App, pack: Pack): void {
  const pending = app.workspace.pendingAssets(pack.id);
  const captured = pack.assets.length - pending.length;
  console.log(`\nCounts toward ${pack.id} (${pack.display}) — ${captured}/${pack.assets.length} captured`);
  if (pending.length === 0) {
    console.log(`${pack.display} is COMPLETE — ready to publish.`);
  } else {
    console.log("Remaining required:");
    for (const assetId of pending) {
      console.log(`  - ${label(app, assetId)}`);
    }
  }
}

/** Print the capture outcome. Returns the process exit code (0 only on staged). */
function report(app: App, filePath: string, result: CaptureAttemptResult): number {
  if (result.ok) {
    // outcome === "staged"; replacement is derived: revisions > 1.
    const revision = result.revisions > 1 ? ` (Revision ${result.revisions} — replaced the previous capture)` : "";
    console.log(`✓ Staged ${label(app, result.asset.id)}${revision}`);
    console.log(`  source:  ${filePath}`);
    console.log(`  staged:  ${result.stagedPath}`);

    const pack = packContaining(app, result.asset.id);
    if (pack === null) {
      // Held work (§4.6): it exists, counts toward nothing, and starts
      // counting the moment a pack includes this asset.
      console.log(`\nNo pack contains ${result.asset.id} — the work is held.`);
      console.log("It counts toward nothing until a pack's definition includes this asset.");
    } else {
      printPackFacts(app, pack);
    }
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
    registryPath: REGISTRY_PATH,
    packsPath: PACKS_PATH,
    channelsPath: CHANNELS_PATH,
  });

  const result = await app.captureFromFile(filePath);
  process.exitCode = report(app, filePath, result);
}

main().catch((e: unknown) => {
  // A genuine programming/configuration fault (e.g. config failed to load).
  console.error(`✗ Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
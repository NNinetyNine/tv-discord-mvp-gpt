import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../composition/app.ts";
import type { CaptureFromFileReceipt } from "../application/capture-from-file.ts";

/**
 * Operator entrypoint: ingest ONE manually exported TradingView PNG.
 *
 * This remains a thin proving surface. It parses one supplied path, invokes the
 * application use case, renders the canonical application-owned receipt, and
 * sets the process exit status. Asset resolution, Pack interpretation, counts,
 * and pending requirements are not derived here.
 *
 * This script only captures; it never publishes.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");
const ARCHIVE_DIR = resolve(process.cwd(), "archive");
const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const PACKS_PATH = resolve(process.cwd(), "definitions", "packs.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

/** Render the canonical receipt. Returns the process exit code. */
export function reportImportReceipt(receipt: CaptureFromFileReceipt): number {
  if (receipt.ok) {
    const revision =
      receipt.revisions > 1
        ? ` (Revision ${receipt.revisions} — replaced the previous capture)`
        : "";
    console.log(`✓ Staged ${receipt.assetId} (${receipt.assetDisplay})${revision}`);
    console.log(`  source:  ${receipt.originalBasename}`);

    if (receipt.placement.kind === "held") {
      console.log(`\nNo pack contains ${receipt.assetId} — the work is held.`);
      console.log("It counts toward nothing until a pack's definition includes this asset.");
      return 0;
    }

    const pack = receipt.placement;
    console.log(
      `\nCounts toward ${pack.packId} (${pack.packDisplay}) — ` +
        `${pack.capturedCount}/${pack.totalCount} captured`,
    );
    if (pack.packState === "complete") {
      console.log(`${pack.packDisplay} is COMPLETE.`);
    } else {
      console.log("Remaining required:");
      for (const asset of pack.remainingRequiredAssets) {
        console.log(`  - ${asset.id} (${asset.display})`);
      }
    }
    return 0;
  }

  switch (receipt.outcome) {
    case "unparseable_filename":
      console.error(`✗ Could not parse a symbol from the filename: "${receipt.filename}"`);
      console.error("  Expected a TradingView-style name like SYMBOL_YYYY-MM-DD_HH-MM-SS.png");
      return 1;

    case "unknown_symbol":
      console.error(`✗ Symbol "${receipt.symbol}" is not in the registry.`);
      console.error("  The exported filename's symbol did not match any registry `tradingView` token.");
      console.error("  If this is a real, expected chart, the registry or normalizer may need reconciling.");
      return 1;

    case "validation_failed": {
      console.error(
        `✗ Validation failed for ${receipt.assetId} (${receipt.assetDisplay}): ${receipt.reason}`,
      );
      const failed = Object.entries(receipt.checks)
        .filter(([, passed]) => passed === false)
        .map(([name]) => name);
      if (failed.length > 0) console.error(`  failed checks: ${failed.join(", ")}`);
      return 1;
    }

    case "staging_failed":
      console.error(
        `✗ Failed to stage ${receipt.assetId} (${receipt.assetDisplay}): ${receipt.detail}`,
      );
      return 1;

    case "capture_failed":
      console.error(`✗ Could not ingest ${receipt.originalBasename}: ${receipt.detail}`);
      return 1;

    default: {
      const exhaustive: never = receipt;
      console.error(`✗ Unrecognized outcome: ${JSON.stringify(exhaustive)}`);
      return 1;
    }
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const filePathArg = argv[2];
  if (!filePathArg || filePathArg.trim().length === 0) {
    console.error("Usage: tsx src/scripts/ingest-file.ts <path-to-export.png>");
    process.exitCode = 2;
    return;
  }

  const filePath = resolve(process.cwd(), filePathArg);
  const app = buildApp({
    sessionPath: SESSION_PATH,
    stagingDir: STAGING_DIR,
    archiveDir: ARCHIVE_DIR,
    registryPath: REGISTRY_PATH,
    packsPath: PACKS_PATH,
    channelsPath: CHANNELS_PATH,
  });

  const receipt = await app.captureFromFile(filePath);
  process.exitCode = reportImportReceipt(receipt);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // A genuine programming/configuration fault (e.g. definitions failed to load).
    console.error(`✗ Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

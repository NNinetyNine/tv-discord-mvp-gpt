import "dotenv/config"; // load .env for this operator script (delivery-layer concern)

import { resolve } from "node:path";

import { buildApp, type App } from "../composition/app.ts";
import type { PublishPackResult, ResumePackResult } from "../wiring/publish-pack.ts";
import type { Asset } from "../types.ts";

/**
 * Operator entrypoint: publish a pack to Discord as a RELEASE, or resume an
 * interrupted one.
 *
 *   npx tsx src/scripts/publish-pack.ts <packId> [--resume | --supersede]
 *
 * The pack is EXPLICIT: publishing is an operator choice of pack (§4.5), so
 * the command names its object. Run without a pack id and the script states
 * the packs and their states as facts, then waits for an explicit command.
 *
 * COMPLETE-ONLY: an incomplete pack is refused — partial publishing does not
 * exist. On success the release (record + image custody + per-chart Discord
 * message identities) is archived under ./archive and that pack's workspace
 * resets (other packs are untouched).
 *
 * --resume: complete the named pack's interrupted release from its own
 * archived record — posts only the charts that never reached Discord, then
 * marks the release published. Never creates a second release; never
 * duplicates a post.
 *
 * --supersede: explicitly publish FRESH past an interrupted release instead
 * of resuming it. Its already-posted messages remain live on Discord (manual
 * cleanup if unwanted); its record is kept, untouched, as honest history.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");
const ARCHIVE_DIR = resolve(process.cwd(), "archive");
const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const PACKS_PATH = resolve(process.cwd(), "definitions", "packs.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");
const ASSET_THREADS_PATH = resolve(
  process.cwd(),
  "config",
  "asset-threads.json",
);

const USAGE = [
  "Publish a pack's charts to Discord as an archived Release.",
  "",
  "Usage:",
  "  npx tsx src/scripts/publish-pack.ts <packId> [--resume | --supersede]",
  "",
  "The pack must be COMPLETE (every asset captured) — partial publishing does",
  "not exist.",
  "",
  "  --resume     complete the named pack's interrupted release (posts only",
  "               what never reached Discord; never duplicates).",
  "  --supersede  publish fresh past an interrupted release instead of",
  "               resuming it (its record is kept as honest history).",
  "",
  "Run from the project root so ./session.json, ./staging and ./archive are",
  "consistent, and so .env (DISCORD_BOT_TOKEN) loads.",
].join("\n");

function label(app: App, assetId: string): string {
  const asset: Asset | undefined = app.registry.all().find((a) => a.id === assetId);
  return asset ? `${asset.id} (${asset.display})` : assetId;
}

/** State the packs and their derived states as facts (the operator chooses). */
function printPackFacts(app: App): void {
  console.error("  Packs:");
  for (const pack of app.workspace.packs()) {
    const state = app.workspace.packState(pack.id);
    const captured = pack.assets.length - app.workspace.pendingAssets(pack.id).length;
    const detail = state === "complete" ? "COMPLETE — ready to publish" : `${captured}/${pack.assets.length} captured`;
    console.error(`    ${pack.id} (${pack.display}) — ${detail}`);
  }
}

/** Shared truth-telling for an interrupted publish/resume run. */
function reportInterrupted(
  app: App,
  r: Extract<PublishPackResult | ResumePackResult, { outcome: "publish_interrupted" }>,
  verb: "Publishing" | "Resuming",
): number {
  console.error(`✗ ${verb} "${r.packId}" was INTERRUPTED.`);
  if (r.failedAssetId !== null) {
    console.error(`  Failed at: ${label(app, r.failedAssetId)}`);
  }
  console.error(`  Reason: ${r.detail}`);
  console.error(`\n  Release ${r.releaseId} is archived, unfinished, and records the exact truth:`);
  if (r.publishedAssetIds.length > 0) {
    console.error(`  ${r.publishedAssetIds.length} chart(s) posted this run are LIVE on Discord, identities recorded:`);
    for (const assetId of r.publishedAssetIds) {
      console.error(`    • ${label(app, assetId)}`);
    }
  } else {
    console.error("  No charts were posted during this run before the failure.");
  }
  console.error("\n  The workspace was NOT reset and staging was kept — your work is intact.");
  console.error("  Run --resume again to complete the release, or --supersede to publish fresh past it.");
  return 1;
}

/** Print the publish outcome. Returns the process exit code (0 only on published). */
function report(app: App, result: PublishPackResult): number {
  if (result.ok) {
    console.log(`✓ Published pack "${result.packId}" — ${result.publishedAssetIds.length} chart(s) posted to Discord.`);
    for (const assetId of result.publishedAssetIds) {
      console.log(`  • ${label(app, assetId)}`);
    }
    console.log(`Release archived: ${result.packId}/${result.releaseId}`);
    console.log(`Workspace reset for "${result.packId}" — other packs untouched.`);
    if (!result.cleared) {
      console.log("Note: staged files could not be cleared (non-fatal); the archive holds custody.");
    }
    return 0;
  }

  switch (result.outcome) {
    case "pack_incomplete": {
      console.error(`✗ Pack "${result.packId}" is incomplete: ${result.captured}/${result.total} captured.`);
      console.error("  A pack must be COMPLETE before it can be published. Still missing:");
      for (const assetId of result.missingAssetIds) {
        console.error(`    – ${label(app, assetId)}`);
      }
      console.error("  Ingest the remaining charts, then publish. (Nothing was posted.)");
      return 1;
    }

    case "interrupted_release_exists":
      console.error(`✗ A previous publish of "${result.packId}" was interrupted and is unresolved.`);
      console.error(`  Release ${result.releaseId} (started ${result.startedAt}): ${result.postedCount}/${result.totalCount} charts were posted to Discord.`);
      console.error("  Run with --resume to complete it (posts only the remaining charts; never");
      console.error("  duplicates). Or run with --supersede to publish fresh past it instead (its");
      console.error("  record is kept as honest history; clean up its live messages manually).");
      return 1;

    case "published_release_cleanup_required":
      console.error(`✗ Pack "${result.packId}" already has a published Release matching the active workspace.`);
      console.error(`  Release ${result.releaseId} was published at ${result.publishedAt}.`);
      console.error("  Discord delivery will not be repeated. Repair or reset the local Pack workspace before publishing again.");
      return 1;

    case "missing_staged_images": {
      console.error(`✗ Cannot publish "${result.packId}": some assets have no staged image on disk.`);
      for (const assetId of result.missing) {
        console.error(`    – ${label(app, assetId)}`);
      }
      console.error("  Re-ingest these assets, then publish again. (Nothing was posted.)");
      return 1;
    }

    case "channel_unresolved":
      console.error(`✗ No Discord channel is configured for pack "${result.packId}".`);
      console.error("  Set a real channel ID in config/channels.json, then publish again. (Nothing was posted.)");
      return 1;

    case "asset_threads_unresolved":
      console.error(
        `✗ Cannot publish "${result.packId}": persistent Discord threads are not configured for:`,
      );
      for (const assetId of result.missingAssetIds) {
        console.error(`    – ${label(app, assetId)}`);
      }
      console.error(
        "  Add or adopt these Asset-thread bindings in config/asset-threads.json.",
      );
      console.error("  Nothing was posted and no release was created.");
      return 1;

    case "publisher_connect_failed":
      console.error(`✗ Could not connect to Discord: ${result.detail}`);
      console.error("  Nothing was posted and no release was created. Fix the connection/token and re-run.");
      return 1;

    case "publish_interrupted":
      return reportInterrupted(app, result, "Publishing");

    default: {
      const _exhaustive: never = result;
      console.error(`✗ Unrecognized publish outcome: ${JSON.stringify(_exhaustive)}`);
      return 1;
    }
  }
}

/** Print the resume outcome. Returns the process exit code (0 only on resumed). */
function reportResume(app: App, result: ResumePackResult): number {
  if (result.ok) {
    if (result.postedNowAssetIds.length > 0) {
      console.log(`✓ Resumed pack "${result.packId}" — ${result.postedNowAssetIds.length} remaining chart(s) posted to Discord:`);
      for (const assetId of result.postedNowAssetIds) {
        console.log(`  • ${label(app, assetId)}`);
      }
    } else {
      console.log(`✓ Resumed pack "${result.packId}" — every chart was already posted; the release is now marked published.`);
    }
    console.log(`Release completed: ${result.packId}/${result.releaseId}`);
    console.log(`Workspace reset for "${result.packId}" — other packs untouched.`);
    if (!result.cleared) {
      console.log("Note: staged files could not be cleared (non-fatal); the archive holds custody.");
    }
    return 0;
  }

  switch (result.outcome) {
    case "nothing_to_resume":
      console.error(`✗ Pack "${result.packId}" has no interrupted release to resume.`);
      console.error("  Either no publish was interrupted, or a later publish already superseded it.");
      return 1;

    case "publisher_connect_failed":
      console.error(`✗ Could not connect to Discord: ${result.detail}`);
      console.error("  Nothing was posted; the release is unchanged. Fix the connection/token and re-run --resume.");
      return 1;

    case "publish_interrupted":
      return reportInterrupted(app, result, "Resuming");

    default: {
      const _exhaustive: never = result;
      console.error(`✗ Unrecognized resume outcome: ${JSON.stringify(_exhaustive)}`);
      return 1;
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }
  const supersede = args.includes("--supersede");
  const resume = args.includes("--resume");
  const positional = args.filter((a) => a !== "--supersede" && a !== "--resume");
  if (positional.length > 1) {
    console.error(`✗ Unexpected argument: "${positional[1]}"\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (supersede && resume) {
    console.error("✗ --resume and --supersede are mutually exclusive: resume completes the");
    console.error("  interrupted release; supersede publishes fresh past it. Choose one.\n");
    console.error(USAGE);
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
    assetThreadsPath: ASSET_THREADS_PATH,
  });

  // The pack is the operator's explicit choice. Missing or unknown: state the
  // facts and wait for an explicit command.
  const packId = positional[0];
  if (packId === undefined) {
    console.error("✗ No pack named. Publishing names its object: supply a pack id.");
    printPackFacts(app);
    console.error("");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (app.workspace.pack(packId) === null) {
    console.error(`✗ Unknown pack "${packId}".`);
    printPackFacts(app);
    process.exitCode = 2;
    return;
  }

  if (resume) {
    const result = await app.resumePack(packId);
    process.exitCode = reportResume(app, result);
    return;
  }

  const result = await app.publishPack(packId, { supersedeInterrupted: supersede });
  process.exitCode = report(app, result);
}

main().catch((e: unknown) => {
  console.error(`✗ Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
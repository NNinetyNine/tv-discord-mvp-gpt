import "dotenv/config"; // load .env for this operator script (delivery-layer concern)

import { resolve } from "node:path";

import { buildApp, type App } from "../composition/app.ts";
import type { PublishPackResult } from "../wiring/publish-pack.ts";
import type { Asset } from "../types.ts";

/**
 * Operator entrypoint: publish the active pack to Discord as a RELEASE.
 *
 *   npx tsx src/scripts/publish-pack.ts [--supersede]
 *
 * COMPLETE-ONLY: an incomplete pack is refused — partial publishing does not
 * exist. On success the release (record + image custody + per-chart Discord
 * message identities) is archived under ./archive and the workspace resets.
 *
 * --supersede: if a previous publish of this pack was interrupted, a fresh
 * publish is refused by default. Pass --supersede to explicitly publish fresh
 * past it. The interrupted release's already-posted messages remain live on
 * Discord (manual cleanup if unwanted); its record is kept, untouched, as
 * honest history.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");
const ARCHIVE_DIR = resolve(process.cwd(), "archive");

const USAGE = [
  "Publish the active pack's charts to Discord as an archived Release.",
  "",
  "Usage:",
  "  npx tsx src/scripts/publish-pack.ts [--supersede]",
  "",
  "The pack must be COMPLETE (every asset captured) — partial publishing does",
  "not exist. --supersede explicitly publishes fresh past an interrupted",
  "earlier release of this pack.",
  "",
  "Run from the project root so ./session.json, ./staging and ./archive are",
  "consistent, and so .env (DISCORD_BOT_TOKEN) loads.",
].join("\n");

function label(app: App, assetId: string): string {
  const asset: Asset | undefined = app.registry.all().find((a) => a.id === assetId);
  return asset ? `${asset.id} (${asset.display})` : assetId;
}

/** Print the publish outcome. Returns the process exit code (0 only on published). */
function report(app: App, result: PublishPackResult): number {
  if (result.ok) {
    console.log(`✓ Published pack "${result.packId}" — ${result.publishedAssetIds.length} chart(s) posted to Discord.`);
    for (const assetId of result.publishedAssetIds) {
      console.log(`  • ${label(app, assetId)}`);
    }
    console.log(`Release archived: ${result.packId}/${result.releaseId}`);
    console.log("Workspace reset — session advanced.");
    if (!result.cleared) {
      console.log("Note: staged files could not be cleared (non-fatal); the archive holds custody.");
    }
    const next = app.session.activePack();
    console.log(next === null ? "All packs complete — session finished." : `Next active pack: ${next.id} (${next.display}).`);
    return 0;
  }

  switch (result.outcome) {
    case "no_active_pack":
      console.error("✗ No active pack — the session is complete. There is nothing to publish.");
      return 1;

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
      console.error("  Publishing fresh now would leave those live messages as duplicates.");
      console.error("  Re-run with --supersede to explicitly publish fresh past it (its record is");
      console.error("  kept as honest history; clean up its live messages manually if unwanted).");
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

    case "publisher_connect_failed":
      console.error(`✗ Could not connect to Discord: ${result.detail}`);
      console.error("  Nothing was posted and no release was created. Fix the connection/token and re-run.");
      return 1;

    case "publish_interrupted": {
      console.error(`✗ Publishing "${result.packId}" was INTERRUPTED.`);
      if (result.failedAssetId !== null) {
        console.error(`  Failed at: ${label(app, result.failedAssetId)}`);
      }
      console.error(`  Reason: ${result.detail}`);
      console.error(`\n  Release ${result.releaseId} is archived in state "publishing" and records the exact truth:`);
      if (result.publishedAssetIds.length > 0) {
        console.error(`  ${result.publishedAssetIds.length} chart(s) are LIVE on Discord, identities recorded:`);
        for (const assetId of result.publishedAssetIds) {
          console.error(`    • ${label(app, assetId)}`);
        }
      } else {
        console.error("  No charts were posted before the failure.");
      }
      console.error("\n  The workspace was NOT reset and staging was kept — your work is intact.");
      console.error("  A fresh publish will be refused until you pass --supersede (resume arrives next phase).");
      return 1;
    }

    default: {
      const _exhaustive: never = result;
      console.error(`✗ Unrecognized publish outcome: ${JSON.stringify(_exhaustive)}`);
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
  const unexpected = args.filter((a) => a !== "--supersede");
  if (unexpected.length > 0) {
    console.error(`✗ Unexpected argument: "${unexpected[0]}"\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const app = buildApp({
    sessionPath: SESSION_PATH,
    stagingDir: STAGING_DIR,
    archiveDir: ARCHIVE_DIR,
  });

  const result = await app.publishActivePack({ supersedeInterrupted: supersede });
  process.exitCode = report(app, result);
}

main().catch((e: unknown) => {
  console.error(`✗ Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
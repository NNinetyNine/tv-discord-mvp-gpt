import "dotenv/config"; // load .env for this operator script (delivery-layer concern)

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { buildApp, type App } from "../composition/app.ts";
import type { PublishPackResult } from "../wiring/publish-pack.ts";
import type { PublishPlan } from "../packs/session.ts";
import type { Asset } from "../types.ts";

/**
 * Operator entrypoint: publish the active pack to Discord.
 *
 *   npx tsx src/scripts/publish-pack.ts
 *
 * It builds the app (composition root), publishes the active pack's captured
 * charts via publishActivePack, prompting interactively if the pack is only
 * partially captured, and prints the outcome.
 *
 * This is a THIN delivery-layer trigger, mirroring ingest-file.ts. It owns only:
 * loading .env, resolving path defaults, an interactive partial-publish prompt,
 * invoking buildApp/publishActivePack, and printing. All orchestration lives in
 * publishActivePack; all assembly in buildApp. Nothing here is imported by the
 * runtime, so `npm run start` is untouched.
 *
 * Configuration:
 *   - session file and staging dir default to ./session.json and ./staging,
 *     resolved against process.cwd(). RUN THIS FROM THE PROJECT ROOT (same as
 *     ingest-file.ts) so it reads the same session/staging the ingest tool wrote,
 *     and so .env loads from the project root.
 *   - DISCORD_BOT_TOKEN (from .env) is required by the real Discord publisher.
 *
 * The partial-publish confirmation is delivery-layer only: it asks the operator
 * yes/no and returns their answer. No policy (e.g. "auto-confirm if >80%") lives
 * here — publishActivePack owns all publish rules. It is a standalone function
 * depending only on the PublishPlan it is handed, so it closes over nothing from
 * `app` (no construction-order dependency). The prompt lists asset IDs; the
 * final report (which runs after `app` is built) uses display-name labels.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");

const USAGE = [
  "Publish the active pack's captured charts to Discord.",
  "",
  "Usage:",
  "  npx tsx src/scripts/publish-pack.ts",
  "",
  "Takes no arguments — it publishes whatever pack the session says is active.",
  "If the pack is only partially captured, you'll be asked to confirm.",
  "",
  "Run from the project root so it reads the same ./session.json and ./staging",
  "the ingest tool wrote, and so .env (DISCORD_BOT_TOKEN) loads.",
].join("\n");

/**
 * Real interactive partial-publish confirmation. Standalone and pure w.r.t. the
 * app: it depends ONLY on the PublishPlan it receives, so it can be passed
 * directly to buildApp with no closure over `app` and no ordering reliance.
 *
 * Delivery-layer only — it shows what a partial publish would send (by asset id)
 * and relays the operator's yes/no. No policy lives here. publishActivePack
 * resolves the channel BEFORE calling this, so a prompt only appears when the
 * channel is already known-good and the sole question is whether to publish an
 * incomplete pack.
 */
async function confirmPartialInteractively(plan: PublishPlan): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n⚠ Pack "${plan.packId}" is only partially captured: ${plan.capturedCount}/${plan.total}.`);
    console.log("Publishing now would send only these captured charts:");
    for (const rec of plan.toPublish) {
      console.log(`  • ${rec.assetId}`);
    }
    if (plan.pendingAssets.length > 0) {
      console.log("Still missing (will NOT be published):");
      for (const assetId of plan.pendingAssets) {
        console.log(`  – ${assetId}`);
      }
    }
    console.log("This posts to Discord immediately and cannot be undone.");
    const answer = (await rl.question("Publish the partial pack anyway? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Human-readable "id (Display)" for an asset id, via the registry catalog. */
function label(app: App, assetId: string): string {
  const asset: Asset | undefined = app.registry.all().find((a) => a.id === assetId);
  return asset ? `${asset.id} (${asset.display})` : assetId;
}

/** Print the publish outcome. Returns the process exit code (0 only on published). */
function report(app: App, result: PublishPackResult): number {
  if (result.ok) {
    // outcome === "published"
    const kind = result.wasPartial ? "partial pack" : "pack";
    console.log(`✓ Published ${kind} "${result.packId}" — ${result.publishedAssetIds.length} chart(s) posted to Discord.`);
    for (const assetId of result.publishedAssetIds) {
      console.log(`  • ${label(app, assetId)}`);
    }
    console.log("Session advanced to the next pack.");
    if (!result.cleared) {
      console.log("Note: staged files for this pack could not be cleared (non-fatal); they belong to a completed pack and won't be re-published.");
    }
    const next = app.session.activePack();
    if (next === null) {
      console.log("All packs are now complete — the session is finished.");
    } else {
      console.log(`Next active pack: ${next.id} (${next.display}).`);
    }
    return 0;
  }

  switch (result.outcome) {
    case "no_active_pack":
      console.error("✗ No active pack — the session is complete. There is nothing to publish.");
      return 1;

    case "nothing_captured":
      console.error(`✗ Nothing captured in the active pack "${result.packId}". Ingest some charts first, then publish.`);
      return 1;

    case "missing_staged_images": {
      console.error(`✗ Cannot publish "${result.packId}": some captured assets have no staged image on disk.`);
      console.error("  Missing staged files for:");
      for (const assetId of result.missing) {
        console.error(`    – ${label(app, assetId)}`);
      }
      console.error("  Re-ingest these assets, then publish again. (Nothing was published; the session was not advanced.)");
      return 1;
    }

    case "channel_unresolved":
      console.error(`✗ No Discord channel is configured for pack "${result.packId}".`);
      console.error("  Set a real channel ID for this pack in config/channels.json, then publish again.");
      console.error("  (Nothing was published; the session was not advanced.)");
      return 1;

    case "partial_declined":
      console.log(`Publish cancelled — pack "${result.packId}" left partial and unpublished.`);
      console.log("Nothing was posted to Discord; the session was not advanced. Capture the remaining charts, or re-run to confirm a partial publish.");
      return 1;

    case "publish_failed": {
      // The important one: some charts may ALREADY be on Discord even though the
      // session did NOT advance. Make that divergence unmistakable.
      console.error(`✗ Publishing pack "${result.packId}" FAILED partway through.`);
      console.error(`  Failed while posting: ${label(app, result.failedAssetId)}`);
      console.error(`  Reason: ${result.detail}`);
      if (result.publishedAssetIds.length > 0) {
        console.error(`\n  ⚠ ${result.publishedAssetIds.length} chart(s) WERE ALREADY POSTED to Discord before the failure:`);
        for (const assetId of result.publishedAssetIds) {
          console.error(`    • ${label(app, assetId)}`);
        }
        console.error("  These messages are already live in the channel and cannot be un-sent.");
      } else {
        console.error("  No charts were posted before the failure.");
      }
      console.error("\n  The session was NOT advanced and staging was NOT cleared, so the pack is still active.");
      console.error("  If you re-run publish, the already-posted charts above will be posted AGAIN (duplicates).");
      console.error("  Resolve the failure (e.g. Discord/network), then decide whether to re-publish or handle the duplicates manually.");
      return 1;
    }

    default: {
      // Exhaustiveness guard: a new outcome added to publishActivePack surfaces here.
      const _exhaustive: never = result;
      console.error(`✗ Unrecognized publish outcome: ${JSON.stringify(_exhaustive)}`);
      return 1;
    }
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "-h" || arg === "--help") {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }
  if (arg !== undefined) {
    console.error(`✗ Unexpected argument: "${arg}"\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const app = buildApp({
    sessionPath: SESSION_PATH,
    stagingDir: STAGING_DIR,
    confirmPartial: confirmPartialInteractively,
  });

  const result = await app.publishActivePack();
  process.exitCode = report(app, result);
}

main().catch((e: unknown) => {
  // A genuine programming/configuration fault (e.g. config or .env load failure,
  // missing DISCORD_BOT_TOKEN surfacing from the publisher).
  console.error(`✗ Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
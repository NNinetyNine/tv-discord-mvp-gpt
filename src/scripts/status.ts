import { resolve } from "node:path";

import { buildApp, type App } from "../composition/app.ts";
import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";

/**
 * Operator entrypoint: show where the workflow currently stands.
 *
 *   npx tsx src/scripts/status.ts
 *
 * Prints, read-only:
 *   - an ordered board of ALL packs with their derived state (empty /
 *     building x/y / complete);
 *   - for each pack still missing work, its pending assets (first 10 named,
 *     then "...and N more" for large packs).
 *
 * This is a THIN delivery-layer trigger, mirroring ingest-file.ts. It builds
 * the app, reads workspace + registry facts, and prints. It MUTATES NOTHING:
 * no capture, no publish, no reset, no staging, no working-state write beyond
 * what buildApp's restore already does. It reports operational FACTS only —
 * not config validity, not environment health, not staged-file detail, not
 * history.
 *
 * Every pack's state is DERIVED from the workspace (definitions ∩ captures):
 * packs are independent instances (Constitution §3-Workspace), so each shows
 * its own real captured/total — there is no ordering, no position, and no
 * terminal state.
 *
 * Configuration: working-state file, staging dir, and release archive default
 * to ./session.json, ./staging and ./archive, resolved against process.cwd() —
 * the same locations ingest-file.ts and publish-pack.ts use. RUN FROM THE
 * PROJECT ROOT so it reads the same state the other tools wrote. It never
 * publishes.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");
const ARCHIVE_DIR = resolve(process.cwd(), "archive");
const REGISTRY_PATH = resolve(process.cwd(), "config", "registry.json");
const PACKS_PATH = resolve(process.cwd(), "config", "packs.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

/** How many pending assets to name before summarizing the remainder. */
const PENDING_PREVIEW = 10;

const USAGE = [
  "Show where the VisionX workflow currently stands (read-only).",
  "",
  "Usage:",
  "  npx tsx src/scripts/status.ts",
  "",
  "Takes no arguments. Prints every pack's derived state (empty / building /",
  "complete) with its captured counts and pending assets. It changes nothing.",
  "",
  "Run from the project root so it reads the same ./session.json the ingest and",
  "publish tools use.",
].join("\n");

/** Human-readable "id (Display)" for an asset id, via the registry catalog. */
function label(app: App, assetId: string): string {
  const asset: Asset | undefined = app.registry.all().find((a) => a.id === assetId);
  return asset ? `${asset.id} (${asset.display})` : assetId;
}

/** Right-pad to a fixed width for the aligned pack board. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Print the ordered board of ALL packs with their derived state. */
function printBoard(app: App, packs: readonly Pack[]): void {
  // Column widths for a tidy, aligned board.
  const idW = Math.min(Math.max(0, ...packs.map((p) => p.id.length)) + 2, 16);
  const dispW = Math.min(Math.max(0, ...packs.map((p) => p.display.length)) + 2, 20);

  console.log("All packs:");
  for (const pack of packs) {
    const state = app.workspace.packState(pack.id);
    const captured = pack.assets.length - app.workspace.pendingAssets(pack.id).length;
    let marker: string;
    let detail: string;
    if (state === "complete") {
      marker = "✓";
      detail = `complete — ${captured}/${pack.assets.length} captured, ready to publish`;
    } else if (state === "building") {
      marker = "▸";
      detail = `building — ${captured}/${pack.assets.length} captured`;
    } else {
      marker = "○";
      detail = "empty";
    }
    console.log(`  ${marker} ${pad(pack.id, idW)}${pad(pack.display, dispW)}${detail}`);
  }
}

/** Print pending assets for each pack still missing work (previewed for large packs). */
function printPending(app: App, packs: readonly Pack[]): void {
  for (const pack of packs) {
    const pending = app.workspace.pendingAssets(pack.id);
    if (pending.length === 0) continue;
    console.log("");
    console.log(`${pack.id} (${pack.display}) — pending (${pending.length}):`);
    const preview = pending.slice(0, PENDING_PREVIEW);
    for (const assetId of preview) {
      console.log(`  ${label(app, assetId)}`);
    }
    const remaining = pending.length - preview.length;
    if (remaining > 0) {
      console.log(`  ...and ${remaining} more`);
    }
  }
}

function main(): void {
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
    archiveDir: ARCHIVE_DIR,
    registryPath: REGISTRY_PATH,
    packsPath: PACKS_PATH,
    channelsPath: CHANNELS_PATH,
  });

  // The ordered pack list for the board — the workspace's own definitions.
  const packs = app.workspace.packs();

  console.log("VisionX status");
  console.log("");
  printBoard(app, packs);
  printPending(app, packs);

  // Read-only report: it succeeded in reporting regardless of the state found.
  process.exitCode = 0;
}

main();
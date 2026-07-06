import { resolve } from "node:path";

import { buildApp, type App } from "../composition/app.ts";
import { loadPacks } from "../packs/packs.ts";
import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";

/**
 * Operator entrypoint: show where the workflow currently stands.
 *
 *   npx tsx src/scripts/status.ts
 *
 * Prints, read-only:
 *   - the ACTIVE pack in detail: captured/total, position in the sequence, and
 *     the pending assets (first 10 named, then "...and N more" for large packs);
 *   - an ordered board of ALL packs with their state (complete / active / not
 *     started).
 *
 * This is a THIN delivery-layer trigger, mirroring ingest-file.ts. It builds the
 * app, reads session + registry state (and the ordered pack list via loadPacks),
 * and prints. It MUTATES NOTHING: no capture, no publish, no advance, no staging,
 * no session write beyond what buildApp's restore already does. It reports
 * operational POSITION only — not config validity, not environment health, not
 * staged-file detail, not history.
 *
 * State per pack is what the forward-only session can honestly report:
 *   - completed packs -> "complete" (their per-asset captures were cleared on
 *     advance, so no captured/total is shown — none is retained);
 *   - the active pack -> its real captured/total (from progress());
 *   - packs not yet reached -> "not started" (captures only accumulate for the
 *     active pack, so a future pack has no progress to show — by design).
 *
 * Configuration: session file and staging dir default to ./session.json and
 * ./staging, resolved against process.cwd() — the same locations ingest-file.ts
 * and publish-pack.ts use. RUN FROM THE PROJECT ROOT so it reads the same
 * session the other tools wrote. It never publishes; the required confirmPartial
 * is inert and never invoked.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");

/** How many pending assets to name before summarizing the remainder. */
const PENDING_PREVIEW = 10;

const USAGE = [
  "Show where the VisionX workflow currently stands (read-only).",
  "",
  "Usage:",
  "  npx tsx src/scripts/status.ts",
  "",
  "Takes no arguments. Prints the active pack's progress and pending assets,",
  "plus an ordered board of every pack's state. It changes nothing.",
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

/** Print the ACTIVE pack in detail: progress + pending (previewed for large packs). */
function printActivePack(app: App): void {
  const progress = app.session.progress();
  const pack = app.session.activePack();

  if (progress === null || pack === null) {
    console.log("All packs complete — session finished.");
    console.log("");
    return;
  }

  console.log(
    `Active pack: ${progress.packId} (${progress.packDisplay}) — pack ${progress.position} of ${progress.packCount}`,
  );

  const pending = app.session.pendingAssets();
  if (pending.length === 0) {
    console.log(`  captured: ${progress.captured}/${progress.total} — complete`);
    console.log("  All assets captured. Next: publish.");
    console.log("");
    return;
  }

  console.log(`  captured: ${progress.captured}/${progress.total}`);
  console.log(`  pending (${pending.length}):`);
  const preview = pending.slice(0, PENDING_PREVIEW);
  for (const assetId of preview) {
    console.log(`    ${label(app, assetId)}`);
  }
  const remaining = pending.length - preview.length;
  if (remaining > 0) {
    console.log(`    ...and ${remaining} more`);
  }
  console.log("");
}

/** Print the ordered board of ALL packs with their state. */
function printBoard(app: App, packs: readonly Pack[]): void {
  const completed = new Set(app.session.completedPackIds());
  const active = app.session.activePack();
  const activeId = active ? active.id : null;
  const progress = app.session.progress();

  // Column widths for a tidy, aligned board.
  const idW = Math.min(Math.max(0, ...packs.map((p) => p.id.length)) + 2, 16);
  const dispW = Math.min(Math.max(0, ...packs.map((p) => p.display.length)) + 2, 20);

  console.log("All packs:");
  for (const pack of packs) {
    let marker: string;
    let state: string;
    if (completed.has(pack.id)) {
      marker = "✓";
      state = "complete";
    } else if (pack.id === activeId) {
      marker = "▸";
      // The active pack is the only one with real captured/total to show.
      state = progress
        ? `active — ${progress.captured}/${progress.total} captured`
        : "active";
    } else {
      marker = "○";
      state = "not started";
    }
    console.log(`  ${marker} ${pad(pack.id, idW)}${pad(pack.display, dispW)}${state}`);
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
    // status never publishes; confirmPartial is required by buildApp but is
    // never invoked here.
    confirmPartial: async () => false,
  });

  // The ordered pack list for the board. loadPacks() is the same list the
  // session was built from (workflow order); calling it here is a public,
  // delivery-layer read (its internal registry re-load is accepted).
  const packs = loadPacks();

  console.log("VisionX status");
  console.log("");
  printActivePack(app);
  printBoard(app, packs);

  // Read-only report: it succeeded in reporting regardless of the state found.
  process.exitCode = 0;
}

main();
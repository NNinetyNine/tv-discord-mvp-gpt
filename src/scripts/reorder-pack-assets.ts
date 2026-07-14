import { resolve } from "node:path";

import { buildApp } from "../composition/app.ts";
import { reorderPackAssets, PackError } from "../packs/packs.ts";
import { loadRegistry } from "../registry/registry.ts";
import { loadChannels } from "../wiring/channels.ts";

/**
 * Operator entrypoint: reorder the Assets within a Pack (Constitution §5.2:
 * "Pack membership and order (within a Pack). Add, remove, and reorder Assets:
 * Empty-only. ... Unconfirmed direct manipulation").
 *
 *   npx tsx src/scripts/reorder-pack-assets.ts <packId> <assetId1> <assetId2> ... <assetIdN>
 *
 * The asset arguments are the FULL desired order — every current member of the
 * pack, each once, in the order you want. The assets array IS the workflow
 * order; reordering changes only that sequence (no pack id/display/channel
 * changes, and MEMBERSHIP is unchanged — same assets, new order).
 *
 * THE EMPTY-ONLY GATE LIVES HERE (shared with removePackAsset). §5.2 edits are
 * permitted only while the Pack is Empty (no captured work), so the meaning of a
 * surviving in-flight instance cannot shift underneath it. "Empty" is a WORKSPACE
 * fact owned solely by the workspace; this delivery script consults
 * app.workspace.packState BEFORE invoking Pack persistence. The Pack store
 * performs pure definition persistence and never sees workspace state. If the
 * Pack is not Empty, the reorder is refused and nothing is written.
 *
 * This is a THIN delivery-layer trigger. It owns: argument parsing, path
 * defaults, operator-input validation (arity), the Empty-only gate read, the
 * registry/channels reads that supply buildPacks' inputs, invoking the
 * pack-store-owned reorderPackAssets, and printing the receipt. All pack validity
 * and the byte-preserving edit are the pack store's concern.
 *
 * SCOPE: reorder within a pack only. Add and remove membership (§5.2) are
 * separate; Pack-level edits (§5.3) and deletion (§5.4) are unrelated.
 *
 * It writes ONLY the packs definition file; it does not modify the archive,
 * staging, or Discord. It reads session.json only to derive the Empty-state fact.
 *
 * Configuration: session/staging/archive + packs/registry/channels default to
 * ./session.json, ./staging, ./archive, definitions/packs.json,
 * definitions/registry.json, config/channels.json, resolved against
 * process.cwd(). RUN FROM THE PROJECT ROOT.
 */

const SESSION_PATH = resolve(process.cwd(), "session.json");
const STAGING_DIR = resolve(process.cwd(), "staging");
const ARCHIVE_DIR = resolve(process.cwd(), "archive");
const PACKS_PATH = resolve(process.cwd(), "definitions", "packs.json");
const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

const USAGE = [
  "Reorder the Assets within a Pack (Constitution §5.2, Empty-only).",
  "",
  "Usage:",
  "  npx tsx src/scripts/reorder-pack-assets.ts <packId> <assetId1> ... <assetIdN>",
  "",
  "Arguments:",
  "  packId    the pack whose assets to reorder (e.g. crypto)",
  "  assetIds  the FULL desired order — every current member, each exactly once,",
  "            in the order you want (assets array = workflow order)",
  "",
  "Example:",
  "  npx tsx src/scripts/reorder-pack-assets.ts crypto eth btc sol",
  "",
  "The pack must be Empty (no captured work) — reordering is refused otherwise,",
  "so a surviving in-flight instance's meaning cannot shift. Every member must be",
  "listed exactly once (membership is unchanged); an unknown id, a duplicate, a",
  "wrong count, or a no-op order is refused. On any failure the packs file is",
  "left unchanged.",
  "",
  "Run from the project root so it reads the same ./session.json the other tools",
  "use and reads/writes definitions/packs.json.",
].join("\n");

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }

  const [packId, ...orderedAssetIds] = argv;
  if (packId === undefined || orderedAssetIds.length === 0) {
    console.error("✗ Missing arguments: provide a pack id and the full desired asset order.\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  try {
    // Build the app to reach the workspace — the sole owner of the Empty-state
    // fact. buildApp restores working state from session.json (read-only here).
    const app = buildApp({
      sessionPath: SESSION_PATH,
      stagingDir: STAGING_DIR,
      archiveDir: ARCHIVE_DIR,
      registryPath: REGISTRY_PATH,
      packsPath: PACKS_PATH,
      channelsPath: CHANNELS_PATH,
    });

    // Operator-input validation: the pack must exist (so the gate read is
    // meaningful). packState throws for an unknown pack; surface it cleanly.
    const known = app.workspace.packs().some((p) => p.id === packId);
    if (!known) {
      console.error(`✗ pack "${packId}" does not exist`);
      console.error("  Nothing was written; the packs file is unchanged.");
      process.exitCode = 1;
      return;
    }

    // THE EMPTY-ONLY GATE (§5.2). "Empty" = no captured work in this pack.
    const state = app.workspace.packState(packId);
    if (state !== "empty") {
      console.error(`✗ pack "${packId}" is ${state}, not Empty — membership editing is Empty-only (§5.2).`);
      console.error("  Publish or reset the pack's in-flight work first. Nothing was written.");
      process.exitCode = 1;
      return;
    }

    // Gate passed. Invoke pure pack-store persistence with its injected inputs.
    const validIds = new Set(loadRegistry(REGISTRY_PATH, CHANNELS_PATH).all().map((a) => a.id));
    const channelNames = new Set(Object.keys(loadChannels(CHANNELS_PATH)));
    const pack = reorderPackAssets(PACKS_PATH, validIds, channelNames, packId, orderedAssetIds);

    console.log(`✓ Reordered assets in pack ${pack.id} (${pack.display})`);
    console.log(`  assets: ${pack.assets.join(", ")} (${pack.assets.length})`);
    process.exitCode = 0;
  } catch (e) {
    if (e instanceof PackError) {
      console.error(`✗ ${e.message}`);
      console.error("  Nothing was written; the packs file is unchanged.");
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

main();
import { resolve } from "node:path";

import { buildApp } from "../composition/app.ts";
import { removePackAsset, PackError } from "../packs/packs.ts";
import { loadRegistry } from "../registry/registry.ts";
import { loadChannels } from "../wiring/channels.ts";

/**
 * Operator entrypoint: remove ONE Asset from a Pack's membership (Constitution
 * §5.2 Pack membership editing — "Empty-only, unconfirmed direct manipulation").
 *
 *   npx tsx src/scripts/remove-pack-asset.ts <packId> <assetId>
 *
 * THE EMPTY-ONLY GATE LIVES HERE. §5.2 membership edits are permitted only while
 * the Pack is Empty (no captured work), so the meaning of a surviving in-flight
 * instance cannot shift underneath it. "Empty" is a WORKSPACE fact owned solely
 * by the workspace; this delivery script consults app.workspace.packState BEFORE
 * invoking Pack persistence. The Pack store performs pure definition persistence
 * and never sees workspace state. If the Pack is not Empty, the edit is refused
 * and nothing is written.
 *
 * This is a THIN delivery-layer trigger. It owns: argument parsing, path
 * defaults, operator-input validation (arity), the Empty-only gate read, the
 * registry/channels reads that supply buildPacks' inputs, invoking the
 * pack-store-owned removePackAsset, and printing the receipt. All pack validity
 * and the byte-preserving edit are the pack store's concern.
 *
 * SCOPE: remove only. Add (§5.2), reorder (§5.2), and every other Pack edit are
 * NOT implemented here. Removing a Pack's last asset is refused by the validator
 * (an asset-less Pack is not a valid definition).
 *
 * It writes ONLY the packs definition file; it does not modify the archive,
 * staging, or Discord. It reads session.json only to derive the Empty-state
 * fact (no working-state write).
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
  "Remove one Asset from a Pack's membership (Constitution §5.2, Empty-only).",
  "",
  "Usage:",
  "  npx tsx src/scripts/remove-pack-asset.ts <packId> <assetId>",
  "",
  "Arguments:",
  "  packId   the pack to edit (e.g. crypto)",
  "  assetId  the internal asset id to remove from that pack (e.g. btc)",
  "",
  "The pack must be Empty (no captured work) — membership editing is refused",
  "otherwise, so a surviving in-flight instance's meaning cannot shift. Removing",
  "a pack's last asset is refused (an asset-less pack is not valid). On any",
  "failure the packs file is left unchanged.",
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

  const [packId, assetId, ...extra] = argv;
  if (packId === undefined || assetId === undefined) {
    console.error("✗ Missing arguments.\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (extra.length > 0) {
    console.error(`✗ Too many arguments (unexpected: ${extra.join(" ")}).\n`);
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
    const pack = removePackAsset(PACKS_PATH, validIds, channelNames, packId, assetId);

    console.log(`✓ Removed ${assetId} from pack ${pack.id} (${pack.display})`);
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
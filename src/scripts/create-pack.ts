import { resolve } from "node:path";

import { createPack, PackError, type CreatePackInput } from "../packs/packs.ts";
import { loadRegistry } from "../registry/registry.ts";
import { loadChannels } from "../wiring/channels.ts";

/**
 * Operator entrypoint: create ONE new Pack definition with its initial
 * membership (Constitution §5.3 Create Pack: "ungated, in any state,
 * unconfirmed"; per the ratified operator ruling a Pack is created WITH its
 * members).
 *
 *   npx tsx src/scripts/create-pack.ts <id> <display> <channel> <asset1,asset2,...>
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, operator-input validation (arity), reading the sibling definitions
 * needed to validate the new pack (the registry, for the valid asset-id set;
 * the channels config, for the channel-name universe — the same inputs the app
 * assembles for loadPacks), invoking the pack-store-owned createPack, and
 * printing the receipt. All pack validity and the byte-preserving append are
 * the pack store's concern; this script never inspects or mutates the file.
 *
 * SCOPE: create only. Membership editing (§5.2), deletion (§5.4), display
 * rename / reorder / channel reassignment (§5.3) are NOT implemented here —
 * each is its own future boundary. An asset-less pack is not valid (ratified):
 * at least one member is required.
 *
 * It writes ONLY the packs definition file; it does not build the app, touch
 * working state, staging, the archive, or Discord.
 *
 * Configuration: packs + registry + channels default to definitions/packs.json,
 * definitions/registry.json, and config/channels.json, resolved against
 * process.cwd(). RUN FROM THE PROJECT ROOT.
 */

const PACKS_PATH = resolve(process.cwd(), "definitions", "packs.json");
const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

const USAGE = [
  "Create one new Pack definition (with its initial membership) in the registry.",
  "",
  "Usage:",
  "  npx tsx src/scripts/create-pack.ts <id> <display> <channel> <assets>",
  "",
  "Arguments:",
  "  id       stable internal pack id (e.g. defi)",
  '  display  human-readable name (quote if it contains spaces, e.g. "DeFi Majors")',
  "  channel  channel NAME from config/channels.json (e.g. crypto)",
  "  assets   comma-separated internal asset ids, in workflow order (e.g. eth,sol,link)",
  "",
  "A pack is created with its members; at least one asset id is required.",
  "Validity (duplicate pack id, unknown channel, empty/duplicate/unknown assets)",
  "is checked against the whole packs file before anything is written; on any",
  "failure the packs file is left unchanged.",
  "",
  "Run from the project root so it reads and writes definitions/packs.json.",
].join("\n");

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }

  const [id, display, channel, assetArg, ...extra] = argv;
  if (id === undefined || display === undefined || channel === undefined || assetArg === undefined) {
    console.error("✗ Missing arguments.\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (extra.length > 0) {
    console.error(`✗ Too many arguments (unexpected: ${extra.join(" ")}).`);
    console.error("  Pass assets as ONE comma-separated argument (no spaces).\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const assets = assetArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  const input: CreatePackInput = { id, display, channel, assets };

  try {
    const validIds = new Set(loadRegistry(REGISTRY_PATH, CHANNELS_PATH).all().map((a) => a.id));
    const channelNames = new Set(Object.keys(loadChannels(CHANNELS_PATH)));
    const pack = createPack(PACKS_PATH, validIds, channelNames, input);
    console.log(`✓ Created pack ${pack.id} (${pack.display})`);
    console.log(`  channel: ${pack.channel}`);
    console.log(`  assets:  ${pack.assets.join(", ")} (${pack.assets.length})`);
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
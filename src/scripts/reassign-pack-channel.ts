import { resolve } from "node:path";

import { reassignPackChannel, PackError } from "../packs/packs.ts";
import { loadRegistry } from "../registry/registry.ts";
import { loadChannels } from "../wiring/channels.ts";

/**
 * Operator entrypoint: reassign ONE Pack's channel (Constitution §5.3: "Pack
 * ... channel assignment. Ungated, in any state, unconfirmed").
 *
 *   npx tsx src/scripts/reassign-pack-channel.ts <packId> <newChannel>
 *
 * THIS EDIT IS UNGATED. §5.3 edits touch no instance membership or completeness,
 * so — unlike §5.2 membership editing — this reads NO workspace state and needs
 * no gate and no confirmation. Per §5.3, a Building Pack whose channel changes
 * simply publishes to the new channel next time; the edit is deliberately
 * ungated even with in-flight work. This script builds no app and does not open
 * the session.
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, operator-input validation (arity), reading the sibling definitions
 * needed to validate the packs file (the registry, for the valid asset-id set;
 * the channels config, for the channel-name universe — the same inputs the app
 * assembles for loadPacks), invoking the pack-store-owned reassignPackChannel,
 * and printing the receipt. All pack validity (including that the new channel
 * name exists in the channels config) and the byte-preserving field edit are the
 * pack store's concern; this script never inspects or mutates the file.
 *
 * SCOPE: channel reassignment only. Display rename and Pack reordering (also
 * §5.3) are separate boundaries. Membership editing (§5.2) and deletion (§5.4)
 * are unrelated.
 *
 * It writes ONLY the packs definition file; it does not touch working state,
 * staging, the archive, or Discord.
 *
 * Configuration: packs + registry + channels default to definitions/packs.json,
 * definitions/registry.json, and config/channels.json, resolved against
 * process.cwd(). RUN FROM THE PROJECT ROOT.
 */

const PACKS_PATH = resolve(process.cwd(), "definitions", "packs.json");
const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

const USAGE = [
  "Reassign one Pack's channel (Constitution §5.3, ungated).",
  "",
  "Usage:",
  "  npx tsx src/scripts/reassign-pack-channel.ts <packId> <newChannel>",
  "",
  "Arguments:",
  "  packId      the pack to reassign (e.g. crypto)",
  "  newChannel  the new channel NAME from config/channels.json (e.g. stocks)",
  "",
  "The new channel name must exist in the channels config. Validity is checked",
  "against the whole packs file before anything is written; on any failure the",
  "packs file is left unchanged.",
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

  const [packId, newChannel, ...extra] = argv;
  if (packId === undefined || newChannel === undefined) {
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
    const validIds = new Set(loadRegistry(REGISTRY_PATH, CHANNELS_PATH).all().map((a) => a.id));
    const channelNames = new Set(Object.keys(loadChannels(CHANNELS_PATH)));
    const pack = reassignPackChannel(PACKS_PATH, validIds, channelNames, packId, newChannel);
    console.log(`✓ Reassigned pack ${pack.id} to channel "${pack.channel}"`);
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
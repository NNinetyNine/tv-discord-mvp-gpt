import { resolve } from "node:path";

import { reorderPacks, PackError } from "../packs/packs.ts";
import { loadRegistry } from "../registry/registry.ts";
import { loadChannels } from "../wiring/channels.ts";

/**
 * Operator entrypoint: reorder the Packs array (Constitution §5.3: "Pack ...
 * Pack reordering ... Ungated, in any state, unconfirmed").
 *
 *   npx tsx src/scripts/reorder-packs.ts <id1> <id2> ... <idN>
 *
 * The arguments are the FULL desired order — every existing pack id, each once,
 * in the order you want. The array order IS the publishing/workflow order;
 * reordering changes only that sequence (no pack's id, display, channel, or
 * membership changes).
 *
 * THIS EDIT IS UNGATED. §5.3 edits touch no instance membership or completeness,
 * so — unlike §5.2 membership editing — this reads NO workspace state and needs
 * no gate and no confirmation. This script builds no app and does not open the
 * session.
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, reading the sibling definitions needed to validate the packs file
 * (the registry, for the valid asset-id set; the channels config, for the
 * channel-name universe — the same inputs the app assembles for loadPacks),
 * invoking the pack-store-owned reorderPacks, and printing the receipt. All pack
 * validity and the byte-preserving block permutation are the pack store's
 * concern; this script never inspects or mutates the file.
 *
 * SCOPE: reorder only. Display rename and channel reassignment (also §5.3) are
 * separate boundaries. Membership editing (§5.2) and deletion (§5.4) are
 * unrelated. Reordering must list every pack exactly once; an unknown id, a
 * duplicate, a wrong count, or a no-op order is refused with nothing written.
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
  "Reorder the Packs array (Constitution §5.3, ungated).",
  "",
  "Usage:",
  "  npx tsx src/scripts/reorder-packs.ts <id1> <id2> ... <idN>",
  "",
  "Arguments:",
  "  the FULL desired order — every existing pack id, each exactly once, in the",
  "  order you want them to appear (array order = publishing/workflow order).",
  "",
  "Example:",
  "  npx tsx src/scripts/reorder-packs.ts stocks crypto indices commodities etfs",
  "",
  "Every pack must be listed exactly once. An unknown id, a duplicate, a wrong",
  "count, or an order identical to the current one is refused; on any failure the",
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

  if (argv.length === 0) {
    console.error("✗ Missing arguments: provide the full desired pack order.\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  try {
    const validIds = new Set(loadRegistry(REGISTRY_PATH, CHANNELS_PATH).all().map((a) => a.id));
    const channelNames = new Set(Object.keys(loadChannels(CHANNELS_PATH)));
    const packs = reorderPacks(PACKS_PATH, validIds, channelNames, argv);
    console.log(`✓ Reordered packs: ${packs.map((p) => p.id).join(", ")}`);
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
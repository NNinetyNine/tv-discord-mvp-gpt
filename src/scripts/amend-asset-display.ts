import { resolve } from "node:path";

import { amendAssetDisplay, RegistryError } from "../registry/registry.ts";

/**
 * Operator entrypoint: amend ONE Asset's display name (Constitution §2.4:
 * "Display names… are metadata"; §5 preamble: definitions are fully editable).
 *
 *   npx tsx src/scripts/amend-asset-display.ts <id> <newDisplay>
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, operator-input validation (arity), invoking the registry-owned
 * amendAssetDisplay, and printing the receipt. All registry validity and the
 * byte-preserving field edit are the registry store's concern; this script
 * never inspects or mutates the file itself.
 *
 * SCOPE: display only. Identity (id), tradingView/aliases, and channel are NOT
 * amendable here — each is its own future boundary (id is opaque and never
 * renamed; tradingView/aliases are entangled with deferred filename
 * reconciliation; Asset.channel is ratified-unresolved).
 *
 * It writes ONLY the registry definition file; it does not build the app,
 * touch working state, staging, the archive, or Discord. Archived Releases
 * snapshotted their own display at publish time and are unaffected.
 *
 * Configuration: registry + channels default to definitions/registry.json and
 * config/channels.json, resolved against process.cwd(). RUN FROM THE PROJECT ROOT.
 */

const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

const USAGE = [
  "Amend one Asset's display name in the registry.",
  "",
  "Usage:",
  '  npx tsx src/scripts/amend-asset-display.ts <id> <newDisplay>',
  "",
  "Arguments:",
  "  id          the stable internal id whose display to change (e.g. btc)",
  '  newDisplay  the new human-readable name (quote if it contains spaces)',
  "",
  "Only the display name changes; id, tradingView, aliases, and channel are",
  "untouched. Validity is checked against the whole registry before anything is",
  "written; on any failure the registry file is left unchanged.",
  "",
  "Run from the project root so it reads and writes definitions/registry.json.",
].join("\n");

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }

  const [id, newDisplay, ...extra] = argv;
  if (id === undefined || newDisplay === undefined) {
    console.error("✗ Missing arguments.\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (extra.length > 0) {
    console.error(`✗ Too many arguments (unexpected: ${extra.join(" ")}).`);
    console.error("  If the display name contains spaces, quote it as one argument.\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  try {
    const asset = amendAssetDisplay(REGISTRY_PATH, CHANNELS_PATH, id, newDisplay);
    console.log(`✓ Amended asset ${asset.id} display -> ${asset.display}`);
    process.exitCode = 0;
  } catch (e) {
    if (e instanceof RegistryError) {
      console.error(`✗ ${e.message}`);
      console.error("  Nothing was written; the registry is unchanged.");
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

main();
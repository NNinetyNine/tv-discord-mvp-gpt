import { resolve } from "node:path";

import { createAsset, loadRegistry, RegistryError, type CreateAssetInput } from "../registry/registry.ts";

/**
 * Operator entrypoint: create ONE new Asset definition (Constitution §5.1:
 * "Create Asset — any time, ungated").
 *
 *   npx tsx src/scripts/create-asset.ts <id> <tradingView> <display> <channel> [alias1,alias2,...]
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, operator-input validation (arity), invoking the registry-owned
 * createAsset, and printing the receipt. All definition validity — duplicate
 * ids, duplicate/aliased TradingView symbols, unknown channels, malformed
 * entries — is the registry store's concern (validate-before-write); this
 * script never inspects or mutates the file itself. It writes ONLY the
 * registry definition file; it does not build the app, touch working state,
 * staging, the archive, or Discord.
 *
 * Configuration: registry + channels default to definitions/registry.json and
 * config/channels.json, resolved against process.cwd() — the same locations
 * the other tools use. RUN FROM THE PROJECT ROOT.
 *
 * On success the new asset is HELD work until a pack includes it (§4.6):
 * creating an asset adds it to the catalog and changes no pack.
 */

const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

const USAGE = [
  "Create one new Asset definition in the registry.",
  "",
  "Usage:",
  "  npx tsx src/scripts/create-asset.ts <id> <tradingView> <display> <channel> [aliases]",
  "",
  "Arguments:",
  "  id           stable internal id (e.g. dax)",
  "  tradingView  canonical TradingView symbol (e.g. DAX)",
  '  display      human-readable name (quote if it contains spaces, e.g. "DAX Index")',
  "  channel      channel NAME from config/channels.json (e.g. indices)",
  "  aliases      OPTIONAL comma-separated TradingView aliases (e.g. GER40,DE40)",
  "",
  "Validity (duplicate ids/symbols, unknown channel, malformed fields) is",
  "checked against the whole registry before anything is written; on any",
  "failure the registry file is left unchanged.",
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

  const [id, tradingView, display, channel, aliasArg, ...extra] = argv;
  if (
    id === undefined ||
    tradingView === undefined ||
    display === undefined ||
    channel === undefined
  ) {
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

  const aliases =
    aliasArg !== undefined && aliasArg.trim().length > 0
      ? aliasArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

  const input: CreateAssetInput = {
    id,
    tradingView,
    display,
    channel,
    ...(aliases ? { tradingViewAliases: aliases } : {}),
  };

  try {
    const asset = createAsset(REGISTRY_PATH, CHANNELS_PATH, input);
    console.log(`✓ Created asset ${asset.id} (${asset.display})`);
    console.log(`  tradingView: ${asset.tradingView}`);
    if (asset.tradingViewAliases) {
      console.log(`  aliases:     ${asset.tradingViewAliases.join(", ")}`);
    }
    console.log(`  channel:     ${asset.channel}`);
    // Report the new catalog size as a fact (the write validated the whole file).
    const count = loadRegistry(REGISTRY_PATH, CHANNELS_PATH).all().length;
    console.log(`\nRegistry now holds ${count} assets.`);
    console.log(`${asset.id} is held work until a pack includes it (§4.6).`);
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
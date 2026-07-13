import { resolve } from "node:path";

import { addAssetAlias, RegistryError } from "../registry/registry.ts";

/**
 * Operator entrypoint: add ONE alternate TradingView symbol (alias) to an
 * existing Asset (Constitution §5 preamble: definitions are fully editable;
 * aliases are declared resolution DATA — see types.ts).
 *
 *   npx tsx src/scripts/add-asset-alias.ts <id> <alias>
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, operator-input validation (arity), invoking the registry-owned
 * addAssetAlias, and printing the receipt. All registry validity (namespace
 * collisions across the combined {tradingView} ∪ aliases universe) and the
 * byte-preserving field edit are the registry store's concern; this script
 * never inspects or mutates the file itself.
 *
 * SCOPE: add one alias only, purely additive — it makes one more filename
 * resolve to an already-correct asset. This is the capability the deferred
 * filename-reconciliation phase uses (a Discord "BTC" that downloads as
 * "BTCUSD" gains "BTCUSD" as an alias). NOT amendable here (each its own future
 * boundary): rewriting the canonical tradingView token (reconciliation-
 * entangled), removing an alias, the channel (ratified-unresolved field), or
 * the id (opaque identity, never renamed).
 *
 * Note: the amended asset's registry line is rewritten (its column alignment
 * may collapse to single spaces); every OTHER line is left byte-for-byte
 * unchanged, and the JSON is semantically preserved.
 *
 * It writes ONLY the registry definition file; it does not build the app, touch
 * working state, staging, the archive, or Discord.
 *
 * Configuration: registry + channels default to definitions/registry.json and
 * config/channels.json, resolved against process.cwd(). RUN FROM THE PROJECT ROOT.
 */

const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");

const USAGE = [
  "Add one alternate TradingView symbol (alias) to an existing Asset.",
  "",
  "Usage:",
  "  npx tsx src/scripts/add-asset-alias.ts <id> <alias>",
  "",
  "Arguments:",
  "  id     the stable internal id to add an alias to (e.g. btc)",
  "  alias  the alternate TradingView symbol (e.g. BTCUSDT)",
  "",
  "The alias must not collide with any existing canonical token or alias",
  "(checked across the whole registry). On any failure the registry file is",
  "left unchanged. Only this asset's resolution is affected; no pack, release,",
  "or channel is touched.",
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

  const [id, alias, ...extra] = argv;
  if (id === undefined || alias === undefined) {
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
    const asset = addAssetAlias(REGISTRY_PATH, CHANNELS_PATH, id, alias);
    console.log(`✓ Added alias to ${asset.id} (${asset.display})`);
    console.log(`  aliases: ${(asset.tradingViewAliases ?? []).join(", ")}`);
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
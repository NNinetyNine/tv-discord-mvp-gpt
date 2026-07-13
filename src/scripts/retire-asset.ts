import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import { retireAsset, loadRegistry, RegistryError } from "../registry/registry.ts";

/**
 * Operator entrypoint: retire (delete) ONE Asset definition (Constitution §5.1:
 * "Retire Asset — an ordinary definition edit; archived Releases referencing it
 * are untouched").
 *
 *   npx tsx src/scripts/retire-asset.ts <id>
 *
 * This is a THIN delivery-layer trigger. It owns only: argument parsing, path
 * defaults, operator-input validation (arity), reading the PACKS definition to
 * build the cross-definition reference set (an asset still in any pack may not
 * be retired — the registry store must not import the pack store, so delivery
 * supplies this fact), invoking the registry-owned retireAsset, and printing
 * the receipt. All registry validity and byte-preserving removal are the
 * registry store's concern; this script never mutates the registry file.
 *
 * It writes ONLY by delegating to the registry store; it does not build the
 * app, touch working state, staging, the archive, or Discord. Archived
 * Releases are untouched by constitutional guarantee (§5.1, §8.3).
 *
 * Configuration: registry + channels + packs default to definitions/registry.json,
 * config/channels.json, and definitions/packs.json, resolved against
 * process.cwd(). RUN FROM THE PROJECT ROOT.
 */

const REGISTRY_PATH = resolve(process.cwd(), "definitions", "registry.json");
const CHANNELS_PATH = resolve(process.cwd(), "config", "channels.json");
const PACKS_PATH = resolve(process.cwd(), "definitions", "packs.json");

const USAGE = [
  "Retire (delete) one Asset definition from the registry.",
  "",
  "Usage:",
  "  npx tsx src/scripts/retire-asset.ts <id>",
  "",
  "Arguments:",
  "  id   the stable internal id to retire (e.g. dax)",
  "",
  "An asset still referenced by any pack cannot be retired; remove it from all",
  "packs first. Registry validity is checked against the whole surviving",
  "registry before anything is written; on any failure the file is unchanged.",
  "Archived Releases that reference the asset are left untouched.",
  "",
  "Run from the project root so it reads and writes definitions/registry.json.",
].join("\n");

/**
 * The set of asset ids any pack currently references. Read directly from the
 * packs definition file (delivery owns this cross-definition read). Kept
 * deliberately lenient: only the `assets` arrays are consulted, so this works
 * regardless of other pack fields.
 */
function readReferencedAssetIds(packsPath: string): Set<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packsPath, "utf8"));
  } catch (e) {
    throw new Error(`could not read/parse ${packsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${packsPath} must be a JSON array of packs`);
  }
  const ids = new Set<string>();
  for (const pack of raw) {
    const assets = (pack as { assets?: unknown }).assets;
    if (Array.isArray(assets)) {
      for (const a of assets) {
        if (typeof a === "string") ids.add(a);
      }
    }
  }
  return ids;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }

  const [id, ...extra] = argv;
  if (id === undefined) {
    console.error("✗ Missing argument: <id>.\n");
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
    const referencingAssetIds = readReferencedAssetIds(PACKS_PATH);
    retireAsset(REGISTRY_PATH, CHANNELS_PATH, id, referencingAssetIds);
    console.log(`✓ Retired asset ${id}`);
    const count = loadRegistry(REGISTRY_PATH, CHANNELS_PATH).all().length;
    console.log(`\nRegistry now holds ${count} assets.`);
    console.log("Archived Releases referencing it are untouched (§5.1).");
    process.exitCode = 0;
  } catch (e) {
    if (e instanceof RegistryError) {
      console.error(`✗ ${e.message}`);
      console.error("  Nothing was written; the registry is unchanged.");
      process.exitCode = 1;
      return;
    }
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

main();
import { resolve } from "node:path";

import { buildApp } from "../composition/app.ts";
import { deletePack, PackError } from "../packs/packs.ts";
import { loadRegistry } from "../registry/registry.ts";
import { loadChannels } from "../wiring/channels.ts";

/**
 * Operator entrypoint: delete a Pack (Constitution §5.4: "One operation on one
 * object: the removal of a definition from the operator's coverage").
 *
 *   npx tsx src/scripts/delete-pack.ts <packId> [--discard-work]
 *
 * CONSENT-GATED, NEVER STATE-GATED (§5.4). Deletion is permitted in ANY state,
 * but destroying in-flight work requires consent that NAMES the cost:
 *
 *   - Deleting an EMPTY Pack (no captured work) is direct manipulation — no
 *     confirmation, no flag needed.
 *   - Deleting a Pack WITH in-flight work is refused UNLESS --discard-work is
 *     given; the refusal names the cost ("N in-progress analyses will be
 *     discarded"), matching §5.4's confirmation-by-naming-the-cost. Passing
 *     --discard-work IS the operator's consent (the established flag pattern,
 *     as publish uses --supersede; no interactive prompt infrastructure exists).
 *
 * delete-Pack-with-work is one of the six confirmed acts (§5.6); delete-empty
 * Pack is not. The in-flight instance ceasing to exist is an ENTAILMENT of the
 * deletion, not a second act (§5.4).
 *
 * THE COST FACT IS A WORKSPACE FACT, owned solely by the workspace. This delivery
 * script consults app.workspace (packState / capturedFor) to decide whether
 * consent is required and to name the cost, BEFORE invoking Pack persistence. The
 * Pack store performs pure definition persistence and never sees workspace state
 * or prompts. Archived Releases for the deleted Pack are untouched (§5.4).
 *
 * This is a THIN delivery-layer trigger. It owns: argument parsing, path
 * defaults, operator-input validation (arity, flags), the consent decision (the
 * workspace cost-read + the --discard-work gate), the registry/channels reads
 * that supply buildPacks' inputs, invoking the pack-store-owned deletePack, and
 * printing the receipt. All pack validity and the byte-preserving removal are the
 * pack store's concern.
 *
 * SCOPE: delete one Pack only. Deleting the last remaining Pack is refused by the
 * validator (the model requires at least one pack). It writes ONLY the packs
 * definition file; it does not modify the archive, staging, Discord, or the
 * registry (a deleted Pack's assets simply become held).
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
  "Delete a Pack (Constitution §5.4, consent-gated).",
  "",
  "Usage:",
  "  npx tsx src/scripts/delete-pack.ts <packId> [--discard-work]",
  "",
  "Arguments:",
  "  packId          the pack to delete (e.g. crypto)",
  "  --discard-work  consent to discard in-flight work when the pack is not Empty",
  "",
  "Deleting an Empty pack is direct — no flag needed. Deleting a pack with",
  "in-flight (captured) work is refused unless --discard-work is given; the",
  "refusal names how many analyses would be discarded. Deleting the last",
  "remaining pack is refused (the model requires at least one pack). On any",
  "failure the packs file is left unchanged. Archived Releases are untouched.",
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

  const discardWork = argv.includes("--discard-work");
  const positional = argv.filter((a) => a !== "--discard-work");
  const [packId, ...extra] = positional;

  if (packId === undefined) {
    console.error("✗ Missing argument: <packId>.\n");
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
    // Build the app to reach the workspace — the sole owner of the cost fact.
    const app = buildApp({
      sessionPath: SESSION_PATH,
      stagingDir: STAGING_DIR,
      archiveDir: ARCHIVE_DIR,
      registryPath: REGISTRY_PATH,
      packsPath: PACKS_PATH,
      channelsPath: CHANNELS_PATH,
    });

    // Operator-input validation: the pack must exist.
    const known = app.workspace.packs().some((p) => p.id === packId);
    if (!known) {
      console.error(`✗ pack "${packId}" does not exist`);
      console.error("  Nothing was written; the packs file is unchanged.");
      process.exitCode = 1;
      return;
    }

    // THE CONSENT GATE (§5.4): consent-gated, never state-gated. Deletion is
    // allowed in any state, but in-flight work must be consented-to by naming its
    // cost. Read the cost from the workspace (capturedFor = in-flight captures).
    const inFlight = app.workspace.capturedFor(packId).length;
    if (inFlight > 0 && !discardWork) {
      const noun = inFlight === 1 ? "analysis" : "analyses";
      console.error(
        `✗ pack "${packId}" has ${inFlight} in-progress ${noun} that deletion would discard.`,
      );
      console.error("  Re-run with --discard-work to confirm, or publish/reset the pack first.");
      console.error("  Nothing was written; the packs file is unchanged.");
      process.exitCode = 1;
      return;
    }

    // Consent satisfied (Empty pack, or --discard-work given). Invoke pure
    // pack-store persistence with its injected inputs.
    const validIds = new Set(loadRegistry(REGISTRY_PATH, CHANNELS_PATH).all().map((a) => a.id));
    const channelNames = new Set(Object.keys(loadChannels(CHANNELS_PATH)));
    const survivors = deletePack(PACKS_PATH, validIds, channelNames, packId);

    console.log(`✓ Deleted pack ${packId}`);
    if (inFlight > 0) {
      const noun = inFlight === 1 ? "analysis" : "analyses";
      console.log(`  ${inFlight} in-progress ${noun} discarded (per --discard-work).`);
    }
    console.log(`  remaining packs: ${survivors.map((p) => p.id).join(", ")} (${survivors.length})`);
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
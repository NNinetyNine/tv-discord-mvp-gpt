import { resolve, join } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";

import { loadRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import {
  findDuplicates,
  type ResolvedEntry,
  type UnknownEntry,
} from "../audit/find-duplicates.ts";

/**
 * Registry audit over a directory of TradingView exports.
 *
 *   npx tsx src/scripts/audit-exports.ts <directory> [--verbose]
 *
 * Answers ONE question: "what does the registry currently know about these
 * files?" It runs each export filename through the resolver and reports:
 *   - resolved   (aggregate count by default; full list with targets in --verbose)
 *   - unresolved (unknown symbol, or unparseable filename) — always shown in full
 *   - duplicate symbols — files that map to the same identity, shown in full
 *   - summary counts
 *
 * This script is a THIN delivery-layer entrypoint: it parses arguments,
 * constructs the resolver, runs each filename through it, delegates duplicate
 * grouping to the pure audit module, and prints. No business logic lives here.
 * No staging, no session, no registry edits, no Discord, no heuristics, no
 * identity guessing, no pack awareness. It consumes only the resolver's PUBLIC
 * resolve() output and never touches resolver internals. One directory in, one
 * report out, no side effects.
 */

const USAGE = [
  "Audit a directory of TradingView exports against the registry.",
  "",
  "Usage:",
  "  npx tsx src/scripts/audit-exports.ts <directory> [--verbose]",
  "",
  "  <directory>   folder of exported .png files to audit",
  "  --verbose     also list every resolved file with its target asset",
  "",
  "Read-only: resolves each filename against the registry and reports what",
  "resolved, what didn't, and which files map to the same identity. It stages",
  "nothing, edits nothing, and changes no session state.",
].join("\n");

/** Image files TradingView exports produce. */
function isExportFile(name: string): boolean {
  return name.toLowerCase().endsWith(".png");
}

/** An export file whose filename could not be parsed into a symbol. */
interface UnparseableEntry {
  readonly file: string;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function auditDirectory(dir: string, resolver: ReturnType<typeof createResolver>) {
  const files = readdirSync(dir)
    .filter(isExportFile)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const resolved: ResolvedEntry[] = [];
  const unknown: UnknownEntry[] = [];
  const unparseable: UnparseableEntry[] = [];

  for (const file of files) {
    const r = resolver.resolve(file);
    if (r.ok) {
      // Map the resolver's Asset into the audit module's minimal identity shape.
      resolved.push({ file, identity: { id: r.asset.id, display: r.asset.display } });
    } else if (r.reason === "unknown_symbol") {
      unknown.push({ file, symbol: r.symbol });
    } else {
      unparseable.push({ file });
    }
  }

  return { files, resolved, unknown, unparseable };
}

function printReport(dir: string, audit: ReturnType<typeof auditDirectory>, verbose: boolean): void {
  const { files, resolved, unknown, unparseable } = audit;
  const duplicates = findDuplicates(resolved, unknown);
  const dupFileCount = duplicates.reduce((n, g) => n + g.files.length, 0);

  const named = [...unknown.map((e) => e.file), ...unparseable.map((e) => e.file)];
  const fileW = Math.min(Math.max(0, ...named.map((f) => f.length)) + 2, 60);
  const symW = 8;

  console.log(`Registry audit — ${files.length} file${files.length === 1 ? "" : "s"} in ${dir}`);
  console.log("");

  if (verbose) {
    console.log(`RESOLVED (${resolved.length})`);
    for (const e of resolved) {
      console.log(`  ${e.file}`);
      console.log(`    → ${e.identity.id} (${e.identity.display})`);
    }
    console.log("");
  } else {
    console.log(`✓ ${resolved.length} resolved`);
    console.log("");
  }

  const unresolvedCount = unknown.length + unparseable.length;
  console.log(`UNRESOLVED (${unresolvedCount})`);
  for (const e of unknown) {
    console.log(`  ${pad(e.file, fileW)}${pad(e.symbol, symW)}(unknown symbol)`);
  }
  for (const e of unparseable) {
    console.log(`  ${pad(e.file, fileW)}${pad("—", symW)}(could not parse a symbol)`);
  }
  console.log("");

  console.log(`DUPLICATE SYMBOLS (${duplicates.length})`);
  for (const g of duplicates) {
    console.log(`  ${g.label}   → ${g.files.length} files:`);
    for (const f of g.files) {
      console.log(`    ${f}`);
    }
  }
  console.log("");

  console.log("SUMMARY");
  console.log(`  files scanned:      ${files.length}`);
  console.log(`  resolved:           ${resolved.length}`);
  console.log(
    `  unresolved:         ${unresolvedCount}   (${unknown.length} unknown symbol, ${unparseable.length} unparseable)`,
  );
  console.log(`  duplicate symbols:  ${duplicates.length}   (affecting ${dupFileCount} files)`);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }

  const verbose = args.includes("--verbose");
  const positional = args.filter((a) => !a.startsWith("-"));

  if (positional.length === 0) {
    console.error("✗ No directory given.\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (positional.length > 1) {
    console.error(`✗ Expected one directory, got ${positional.length}.\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  // Exactly one positional confirmed above; bind it as a checked string so strict
  // indexed access (noUncheckedIndexedAccess) narrows away `undefined`.
  const dirArg = positional[0];
  if (dirArg === undefined) {
    console.error("✗ No directory given.\n");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const dir = resolve(process.cwd(), dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`✗ Not a directory: ${dir}`);
    process.exitCode = 2;
    return;
  }

  const resolver = createResolver(
    loadRegistry(
      resolve(process.cwd(), "definitions", "registry.json"),
      resolve(process.cwd(), "config", "channels.json"),
    ),
  );
  const audit = auditDirectory(dir, resolver);
  printReport(dir, audit, verbose);
  process.exitCode = 0;
}

main();
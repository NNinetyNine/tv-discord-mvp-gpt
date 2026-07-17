import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "../registry/registry.ts";
import {
  auditAssetMarketIdentity,
  type AuditableAsset,
  type AuditablePack,
} from "../registry/asset-market-identity-audit.ts";

export const INSPECT_ASSET_MARKET_IDENTITY_USAGE =
  "Usage: npx tsx src/scripts/inspect-asset-market-identity.ts";

async function loadCanonicalAuditInputs(): Promise<{
  readonly assets: readonly AuditableAsset[];
  readonly packs: readonly AuditablePack[];
}> {
  const registryRaw = JSON.parse(await readFile(resolve("definitions/registry.json"), "utf8")) as Record<string, Record<string, unknown>>;
  const channelsRaw = JSON.parse(await readFile(resolve("config/channels.json"), "utf8")) as Record<string, unknown>;
  const packsRaw = JSON.parse(await readFile(resolve("definitions/packs.json"), "utf8")) as unknown;
  const registry = buildRegistry(registryRaw, channelsRaw);
  if (!Array.isArray(packsRaw)) throw new Error("packs.json must be an array");
  const assets = registry.all().map((asset) => {
    const raw = registryRaw[asset.id] ?? {};
    return Object.freeze({
      ...asset,
      ...(raw.market === undefined ? {} : { market: raw.market }),
      ...(raw.tradingViewSymbol === undefined ? {} : { tradingViewSymbol: raw.tradingViewSymbol }),
      ...(raw.currency === undefined ? {} : { currency: raw.currency }),
    });
  });
  const packs = packsRaw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`pack[${index}] is not an object`);
    const record = entry as Record<string, unknown>;
    return Object.freeze({
      id: typeof record.id === "string" ? record.id : `pack[${index}]`,
      assets: Array.isArray(record.assets) ? Object.freeze([...record.assets]) : Object.freeze([]),
    });
  });
  return Object.freeze({ assets: Object.freeze(assets), packs: Object.freeze(packs) });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  const supplied = argv.slice(2);
  if (supplied.length > 0) {
    const result = Object.freeze({ ok: false, reason: "invalid_arguments", detail: `unexpected argument: ${supplied[0] ?? ""}` });
    stderr(JSON.stringify(result, null, 2));
    stderr(INSPECT_ASSET_MARKET_IDENTITY_USAGE);
    return 2;
  }
  try {
    const inputs = await loadCanonicalAuditInputs();
    const audit = auditAssetMarketIdentity(inputs.assets, inputs.packs);
    stdout(JSON.stringify(audit, null, 2));
    return audit.ok ? 0 : 1;
  } catch (error) {
    stderr(JSON.stringify({ ok: false, reason: "incomplete_currency_coverage", detail: error instanceof Error ? error.message : String(error) }, null, 2));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Asset } from "../types.ts";
/**
 * Asset registry. Keyed by stable internal id (e.g. "btc"); the `tradingView`
 * field is what filenames resolve against, and `tradingViewAliases` lists
 * additional TradingView symbols that also denote the asset. Validated loudly on
 * load, with an O(1) reverse index built once over the combined
 * {tradingView} ∪ tradingViewAliases namespace.
 *
 * This module knows NOTHING about filenames or parsing — it does exact lookups
 * on a normalized TradingView symbol the resolver hands it. It performs no
 * business translation: alternate symbols are declared DATA (aliases), not
 * algorithmic rules.
 */
export class RegistryError extends Error {
  constructor(message: string) {
    super(`Registry error: ${message}`);
    this.name = "RegistryError";
  }
}
export interface Registry {
  /**
   * Exact lookup by TradingView symbol (already normalized by the resolver).
   * Matches the canonical `tradingView` token OR any `tradingViewAlias`.
   */
  lookupByTradingView(symbol: string): Asset | null;
  /** All assets (e.g. for future listing). */
  all(): readonly Asset[];
}
interface RawEntry {
  tradingView?: unknown;
  tradingViewAliases?: unknown;
  display?: unknown;
  channel?: unknown;
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
/**
 * Build a validated Registry from already-parsed data. Pure (no I/O) so tests
 * can exercise validation without touching disk.
 *
 * Collision rule: across ALL assets, the combined namespace of every canonical
 * `tradingView` token plus every `tradingViewAlias` must be unique (compared
 * case-insensitively). Any symbol claimed twice — by two assets, by an alias
 * and another asset's token, by a duplicate alias within one asset, or by an
 * alias equal to its own canonical token (self-alias) — is a RegistryError.
 *
 * @param raw       registry object: id -> entry
 * @param channels  channel-name -> discord id map (to validate channel refs)
 */
export function buildRegistry(
  raw: Record<string, RawEntry>,
  channels: Record<string, unknown>,
): Registry {
  const assets: Asset[] = [];
  const seenIds = new Set<string>();
  const seenTradingView = new Map<string, string>(); // UPPER(symbol) -> owning id (combined namespace)
  const byTradingView = new Map<string, Asset>();
  for (const [id, entry] of Object.entries(raw)) {
    if (!isNonEmptyString(id)) {
      throw new RegistryError("asset id must be a non-empty string");
    }
    if (seenIds.has(id)) {
      throw new RegistryError(`duplicate asset id: "${id}"`);
    }
    if (typeof entry !== "object" || entry === null) {
      throw new RegistryError(`asset "${id}" is not an object`);
    }
    if (!isNonEmptyString(entry.tradingView)) {
      throw new RegistryError(`asset "${id}".tradingView must be a non-empty string`);
    }
    if (!isNonEmptyString(entry.display)) {
      throw new RegistryError(`asset "${id}".display must be a non-empty string`);
    }
    if (!isNonEmptyString(entry.channel)) {
      throw new RegistryError(`asset "${id}".channel must be a non-empty string`);
    }
    if (!(entry.channel in channels)) {
      throw new RegistryError(
        `asset "${id}".channel "${entry.channel}" not found in channels config`,
      );
    }
    // Validate tradingViewAliases shape (optional; array of non-empty strings).
    let aliases: readonly string[] | undefined;
    if (entry.tradingViewAliases !== undefined) {
      if (!Array.isArray(entry.tradingViewAliases)) {
        throw new RegistryError(`asset "${id}".tradingViewAliases must be an array of strings`);
      }
      for (const a of entry.tradingViewAliases) {
        if (!isNonEmptyString(a)) {
          throw new RegistryError(`asset "${id}".tradingViewAliases must contain only non-empty strings`);
        }
      }
      aliases = [...entry.tradingViewAliases];
    }
    const tv = entry.tradingView;
    const tvKey = tv.toUpperCase();
    if (seenTradingView.has(tvKey)) {
      throw new RegistryError(
        `duplicate TradingView symbol "${tv}" on ids "${seenTradingView.get(tvKey)}" and "${id}"`,
      );
    }
    const asset: Asset = {
      id,
      tradingView: tv,
      display: entry.display,
      channel: entry.channel,
      ...(aliases ? { tradingViewAliases: aliases } : {}),
    };
    seenIds.add(id);
    seenTradingView.set(tvKey, id);
    byTradingView.set(tvKey, asset);
    // Claim each alias in the SAME namespace as canonical tokens. A collision
    // with any prior symbol — another asset's token/alias, this asset's own
    // canonical token (self-alias, already claimed just above), or an earlier
    // duplicate of this alias within the same asset — is rejected loudly.
    if (aliases) {
      for (const a of aliases) {
        const aKey = a.toUpperCase();
        if (seenTradingView.has(aKey)) {
          throw new RegistryError(
            `duplicate TradingView symbol "${a}" (alias of "${id}") already used by "${seenTradingView.get(aKey)}"`,
          );
        }
        seenTradingView.set(aKey, id);
        byTradingView.set(aKey, asset);
      }
    }
    assets.push(asset);
  }
  if (assets.length === 0) {
    throw new RegistryError("registry is empty");
  }
  return {
    lookupByTradingView(symbol: string): Asset | null {
      return byTradingView.get(symbol.toUpperCase()) ?? null;
    },
    all(): readonly Asset[] {
      return assets;
    },
  };
}
/** Load + validate the registry from config files on disk. Throws on any problem. */
export function loadRegistry(): Registry {
  const registryPath = resolve(process.cwd(), "config", "registry.json");
  const channelsPath = resolve(process.cwd(), "config", "channels.json");
  let rawRegistry: unknown;
  let rawChannels: unknown;
  try {
    rawRegistry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (e) {
    throw new RegistryError(`could not read/parse ${registryPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    rawChannels = JSON.parse(readFileSync(channelsPath, "utf8"));
  } catch (e) {
    throw new RegistryError(`could not read/parse ${channelsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof rawRegistry !== "object" || rawRegistry === null || Array.isArray(rawRegistry)) {
    throw new RegistryError("registry.json must be a JSON object keyed by asset id");
  }
  if (typeof rawChannels !== "object" || rawChannels === null || Array.isArray(rawChannels)) {
    throw new RegistryError("channels.json must be a JSON object keyed by channel name");
  }
  return buildRegistry(
    rawRegistry as Record<string, RawEntry>,
    rawChannels as Record<string, unknown>,
  );
}
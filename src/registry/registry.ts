import { readFileSync, writeFileSync } from "node:fs";
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
/**
 * Load + validate the registry from the supplied files on disk. Throws on any
 * problem. Locations are injected — this store decides no filesystem paths
 * (delivery owns location choice; the composition root routes it here).
 *
 * @param registryPath  location of the registry file (asset id -> entry)
 * @param channelsPath  location of the channels file (channel name -> discord id)
 */
export function loadRegistry(registryPath: string, channelsPath: string): Registry {
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
/**
 * Input for createAsset: the new definition's id plus its entry fields.
 * Mirrors the Asset shape the operator owns; tradingViewAliases is optional.
 */
export interface CreateAssetInput {
  readonly id: string;
  readonly tradingView: string;
  readonly display: string;
  readonly channel: string;
  readonly tradingViewAliases?: readonly string[];
}

/**
 * Create a new Asset definition through registry-owned persistence
 * (Constitution §5.1: "Create Asset — any time, ungated"). This store owns the
 * registry file; creation is validate-before-write over the WHOLE candidate.
 *
 * VALIDATE-BEFORE-WRITE: the complete candidate registry (every existing entry
 * plus the new one) is validated with buildRegistry — the SAME validator the
 * load path trusts — before a single byte is written. Any failure throws
 * RegistryError and leaves the registry file byte-for-byte unchanged. Duplicate
 * ids, duplicate/aliased TradingView symbols, unknown channels, and malformed
 * entries therefore all fail loudly here exactly as they would on load.
 *
 * BYTE-PRESERVING APPEND: the registry is operator-owned data whose recovery
 * mechanism is version control (Constitution §2.2.1), and Asset.channel is a
 * ratified-unresolved field. So the writer never re-serializes the file: it
 * appends exactly one entry and leaves every existing byte — each entry's
 * field order, channel, and any field this code does not model — verbatim,
 * preserving the file's own trailing-newline convention. As a final guard the
 * new text is re-parsed and compared to the validated candidate; on ANY
 * divergence it throws with nothing written.
 *
 * Locations are injected — this store decides no filesystem paths (delivery
 * owns location choice).
 *
 * @param registryPath  location of the registry file (asset id -> entry)
 * @param channelsPath  location of the channels file (for channel validation)
 * @param input         the new asset definition
 * @returns the created Asset as validated within the candidate registry
 */
export function createAsset(
  registryPath: string,
  channelsPath: string,
  input: CreateAssetInput,
): Asset {
  // Read the current definition of record: raw TEXT (for the byte-preserving
  // append) and parsed object (for validation), plus the channels config.
  let registryText: string;
  let rawRegistry: unknown;
  let rawChannels: unknown;
  try {
    registryText = readFileSync(registryPath, "utf8");
    rawRegistry = JSON.parse(registryText);
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
  const current = rawRegistry as Record<string, RawEntry>;
  const channels = rawChannels as Record<string, unknown>;

  // Creation-specific identity guard: a JSON object key would silently
  // overwrite, so an existing id is refused loudly BEFORE building the
  // candidate (buildRegistry sees one key and could not detect the clash).
  if (Object.prototype.hasOwnProperty.call(current, input.id)) {
    throw new RegistryError(`asset id "${input.id}" already exists`);
  }
  if (!isNonEmptyString(input.id)) {
    throw new RegistryError("asset id must be a non-empty string");
  }

  // The new entry, fields in the file's canonical order. The COMPLETE candidate
  // registry is current ∪ { new } — validated as a whole below.
  const entry: RawEntry = {
    tradingView: input.tradingView,
    ...(input.tradingViewAliases !== undefined
      ? { tradingViewAliases: [...input.tradingViewAliases] }
      : {}),
    display: input.display,
    channel: input.channel,
  };
  const candidate: Record<string, RawEntry> = { ...current, [input.id]: entry };

  // Validate-before-write: the whole candidate through the load-path validator.
  const validated = buildRegistry(candidate, channels);

  // Byte-preserving append. Keep everything up to the final closing brace
  // verbatim; insert one entry; restore the file's own trailing convention.
  const hadTrailingNewline = /\n$/.test(registryText);
  const trimmedEnd = registryText.replace(/\s+$/u, "");
  if (!trimmedEnd.endsWith("}")) {
    throw new RegistryError(`registry file at ${registryPath} does not end with "}" — refusing to write`);
  }
  const body = trimmedEnd.slice(0, -1).replace(/\s+$/u, "");
  const isEmptyObject = body.replace(/\s+$/u, "").endsWith("{");
  const separator = isEmptyObject ? "\n" : ",\n";
  const aliasPart =
    input.tradingViewAliases !== undefined
      ? ` "tradingViewAliases": ${JSON.stringify([...input.tradingViewAliases])},`
      : "";
  const entryLine =
    `  ${JSON.stringify(input.id)}: { "tradingView": ${JSON.stringify(input.tradingView)},` +
    `${aliasPart} "display": ${JSON.stringify(input.display)},` +
    ` "channel": ${JSON.stringify(input.channel)} }`;
  const newText = `${body}${separator}${entryLine}\n}${hadTrailingNewline ? "\n" : ""}`;

  // Final guard: the appended text must re-parse to EXACTLY the validated
  // candidate. Any divergence (key order aside — compared as parsed values)
  // means the textual splice was unsafe; throw with nothing written.
  if (JSON.stringify(JSON.parse(newText)) !== JSON.stringify(candidate)) {
    throw new RegistryError(
      "internal: appended registry text does not match the validated candidate — nothing written",
    );
  }

  writeFileSync(registryPath, newText);

  const created = validated.all().find((a) => a.id === input.id);
  if (created === undefined) {
    throw new RegistryError(`internal: created asset "${input.id}" missing from validated registry`);
  }
  return created;
}
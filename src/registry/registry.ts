import { readFileSync, writeFileSync } from "node:fs";
import type { Asset } from "../types.ts";
import { validatePublicationCurrency } from "./asset-market-identity.ts";
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
  currency?: unknown;
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
    let currency: string | undefined;
    if (entry.currency !== undefined) {
      const validatedCurrency = validatePublicationCurrency(entry.currency);
      if (!validatedCurrency.ok) {
        throw new RegistryError(`asset "${id}".currency is invalid: ${validatedCurrency.detail}`);
      }
      currency = validatedCurrency.currency;
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
      ...(currency === undefined ? {} : { currency }),
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
  readonly currency?: string;
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
    ...(input.currency === undefined ? {} : { currency: input.currency }),
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
    `${input.currency === undefined ? "" : ` "currency": ${JSON.stringify(input.currency)},`}` +
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

/**
 * Retire (delete) an Asset definition through registry-owned persistence
 * (Constitution §5.1: "Retire Asset — an ordinary definition edit; archived
 * Releases referencing it are untouched"). This store owns the registry file;
 * retirement is validate-before-write over the WHOLE surviving registry.
 *
 * CROSS-DEFINITION COHERENCE IS INJECTED: an asset still referenced by a Pack
 * must not be retired (it would orphan that pack's membership). Pack membership
 * lives in the pack store, which this module must not import; so the caller
 * supplies `referencingAssetIds` — the set of asset ids any Pack currently
 * references — exactly as createAsset receives channel names and buildPacks
 * receives valid ids (consumer-owned dependency contract). If the target id is
 * in that set, retirement is refused with nothing written. Delivery reads the
 * packs definition to build this set.
 *
 * VALIDATE-BEFORE-WRITE: the surviving registry (every entry except the
 * retired one) is validated with buildRegistry — the SAME validator the load
 * path trusts — before a byte is written. The retired id must exist; the
 * surviving registry must still be non-empty and valid.
 *
 * BYTE-PRESERVING REMOVAL: the registry is operator-owned data recovered via
 * version control (Constitution §2.2.1), so the writer never re-serializes the
 * file. It removes exactly the one line defining the retired asset and leaves
 * every surviving byte — field order, channel, unmodeled fields, and the
 * file's trailing-newline convention — verbatim, repairing only the JSON
 * comma structure the removal requires. As a final guard the new text is
 * re-parsed and compared to the validated surviving registry; on ANY
 * divergence it throws with nothing written.
 *
 * Locations are injected — this store decides no filesystem paths (delivery
 * owns location choice).
 *
 * @param registryPath        location of the registry file (asset id -> entry)
 * @param channelsPath        location of the channels file (for revalidation)
 * @param id                  the asset id to retire
 * @param referencingAssetIds asset ids any Pack currently references
 */
export function retireAsset(
  registryPath: string,
  channelsPath: string,
  id: string,
  referencingAssetIds: ReadonlySet<string>,
): void {
  // Read the current definition of record (raw TEXT for the byte-preserving
  // removal, parsed object for validation) and the channels config.
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

  // The retired asset must exist.
  if (!Object.prototype.hasOwnProperty.call(current, id)) {
    throw new RegistryError(`asset id "${id}" does not exist`);
  }
  // Cross-definition coherence: refuse to orphan a Pack's membership.
  if (referencingAssetIds.has(id)) {
    throw new RegistryError(
      `asset "${id}" is still referenced by a pack — remove it from all packs before retiring`,
    );
  }

  // The COMPLETE surviving registry (everything except the retired id).
  const survivors: Record<string, RawEntry> = { ...current };
  delete survivors[id];

  // Validate-before-write: the surviving registry through the load-path
  // validator (also enforces "registry is not empty").
  buildRegistry(survivors, channels);

  // Byte-preserving removal. The registry is one entry per line; find the
  // unique line whose parsed key is the retired id, drop it, and repair the
  // trailing-comma structure so the result is valid JSON. Any structural
  // surprise (id not found on exactly one line, or mismatch after removal)
  // throws with nothing written.
  const hadTrailingNewline = /\n$/.test(registryText);
  const eol = registryText.includes("\r\n") ? "\r\n" : "\n";
  const lines = registryText.split(eol);

  const idToken = `${JSON.stringify(id)}:`;
  const matches: number[] = [];
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith(idToken)) matches.push(i);
  });
  if (matches.length !== 1) {
    throw new RegistryError(
      `could not locate a unique line for asset "${id}" (found ${matches.length}) — refusing to write`,
    );
  }
  const removeIdx = matches[0]!;
  const wasLastEntry = /,\s*$/.test(lines[removeIdx]!) === false;

  const kept = lines.filter((_, i) => i !== removeIdx);

  // Repair comma structure: after removing the last entry, the new last entry
  // line must not end with a comma; after removing a non-last entry, nothing
  // changes (each remaining entry keeps its own terminator).
  if (wasLastEntry) {
    // Find the new final entry line (the line before the closing "}").
    for (let i = kept.length - 1; i >= 0; i--) {
      const t = kept[i]!.trim();
      if (t === "" || t === "}" || t === "},") continue;
      kept[i] = kept[i]!.replace(/,(\s*)$/u, "$1");
      break;
    }
  }

  let newText = kept.join(eol);
  if (hadTrailingNewline && !newText.endsWith(eol)) newText += eol;
  if (!hadTrailingNewline && newText.endsWith(eol)) newText = newText.replace(/\r?\n$/u, "");

  // Final guard: the removed-line text must re-parse to EXACTLY the validated
  // survivors. Any divergence means the line surgery was unsafe; throw with
  // nothing written.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(newText);
  } catch (e) {
    throw new RegistryError(
      `internal: registry text after removal is not valid JSON — nothing written (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(survivors)) {
    throw new RegistryError(
      "internal: registry text after removal does not match the validated survivors — nothing written",
    );
  }

  writeFileSync(registryPath, newText);
}

/**
 * Amend the display metadata of an existing Asset (Constitution §2.4: "Display
 * names… are metadata"; §5 preamble: definitions are "fully editable"). This
 * store owns the registry file; amendment is validate-before-write over the
 * WHOLE candidate.
 *
 * SCOPE: display ONLY. This is deliberately the smallest metadata amendment.
 * Identity (id) is opaque and never renamed (§2.4); tradingView/aliases are
 * resolution identifiers entangled with the deferred filename-reconciliation
 * phase; Asset.channel is the ratified-unresolved field. None of those is
 * amended here — each is its own future boundary.
 *
 * VALIDATE-BEFORE-WRITE: the complete candidate registry (every entry, with
 * the target's display replaced) is validated with buildRegistry — the SAME
 * validator the load path trusts — before a byte is written. A blank display
 * fails there, exactly as on load; an unknown id is refused first.
 *
 * BYTE-PRESERVING FIELD EDIT: the registry is operator-owned data recovered
 * via version control (Constitution §2.2.1). The writer never re-serializes
 * the file: it locates the single line defining the target asset (the registry
 * is one entry per line) and replaces only that line's "display" value,
 * leaving every other byte — other entries, this entry's id/tradingView/
 * channel/aliases, and the file's trailing-newline convention — verbatim. As a
 * final guard the new text is re-parsed and compared to the validated
 * candidate; on ANY divergence it throws with nothing written.
 *
 * Locations are injected — this store decides no filesystem paths (delivery
 * owns location choice).
 *
 * @param registryPath  location of the registry file (asset id -> entry)
 * @param channelsPath  location of the channels file (for revalidation)
 * @param id            the asset id whose display to amend
 * @param newDisplay    the new display name
 * @returns the amended Asset as validated within the candidate registry
 */
export function amendAssetDisplay(
  registryPath: string,
  channelsPath: string,
  id: string,
  newDisplay: string,
): Asset {
  // Read the current definition of record (raw TEXT for the byte-preserving
  // edit, parsed object for validation) and the channels config.
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

  // The amended asset must exist.
  if (!Object.prototype.hasOwnProperty.call(current, id)) {
    throw new RegistryError(`asset id "${id}" does not exist`);
  }

  // The COMPLETE candidate registry, with only this entry's display replaced.
  // The existing entry's other fields (and field order) are preserved by
  // spreading the parsed entry.
  const existing = current[id] as RawEntry;
  const candidate: Record<string, RawEntry> = {
    ...current,
    [id]: { ...existing, display: newDisplay },
  };

  // Validate-before-write: the whole candidate through the load-path validator
  // (also enforces the non-empty-display rule).
  const validated = buildRegistry(candidate, channels);

  // Byte-preserving field edit. The registry is one entry per line; find the
  // unique line whose parsed key is the target id and replace only its
  // "display" value. Any structural surprise throws with nothing written.
  const eol = registryText.includes("\r\n") ? "\r\n" : "\n";
  const lines = registryText.split(eol);
  const idToken = `${JSON.stringify(id)}:`;
  const matches: number[] = [];
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith(idToken)) matches.push(i);
  });
  if (matches.length !== 1) {
    throw new RegistryError(
      `could not locate a unique line for asset "${id}" (found ${matches.length}) — refusing to write`,
    );
  }
  const lineIdx = matches[0]!;
  const original = lines[lineIdx]!;

  // Replace only the "display": "<value>" token on this line. The value is
  // emitted with JSON.stringify so quotes/backslashes escape correctly. The
  // pattern matches a JSON string value (no unescaped quotes/backslashes),
  // which is exactly what buildRegistry has already accepted for this file.
  const displayRe = /("display"\s*:\s*)"(?:[^"\\]|\\.)*"/u;
  if (!displayRe.test(original)) {
    throw new RegistryError(
      `could not locate a "display" value on the line for asset "${id}" — refusing to write`,
    );
  }
  lines[lineIdx] = original.replace(displayRe, `$1${JSON.stringify(newDisplay)}`);

  const newText = lines.join(eol);

  // Final guard: the edited text must re-parse to EXACTLY the validated
  // candidate. Any divergence means the field edit was unsafe; throw with
  // nothing written.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(newText);
  } catch (e) {
    throw new RegistryError(
      `internal: registry text after amend is not valid JSON — nothing written (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(candidate)) {
    throw new RegistryError(
      "internal: registry text after amend does not match the validated candidate — nothing written",
    );
  }

  writeFileSync(registryPath, newText);

  const amended = validated.all().find((a) => a.id === id);
  if (amended === undefined) {
    throw new RegistryError(`internal: amended asset "${id}" missing from validated registry`);
  }
  return amended;
}

/**
 * Add one alternate TradingView symbol (alias) to an existing Asset
 * (Constitution §5 preamble: definitions are "fully editable"; the aliases are
 * declared resolution DATA — see types.ts). This store owns the registry file;
 * the operation is validate-before-write over the WHOLE candidate.
 *
 * SCOPE: add a single alias, ONLY. This is deliberately the smallest resolution
 * amendment and is purely ADDITIVE — it makes one more filename resolve to an
 * already-correct asset. It is the capability the deferred filename-
 * reconciliation phase needs (e.g. a Discord "BTC" that downloads as "BTCUSD"
 * gains "BTCUSD" as an alias). Not done here, each its own future boundary:
 * rewriting the canonical `tradingView` token (reconciliation-entangled —
 * changes what the canonical symbol IS), removing an alias, amending `channel`
 * (ratified-unresolved field), or `id` (opaque identity, never renamed).
 *
 * VALIDATE-BEFORE-WRITE: the complete candidate registry (the target entry with
 * the alias appended) is validated with buildRegistry — the SAME validator the
 * load path trusts — before a byte is written. The combined
 * {tradingView} ∪ tradingViewAliases namespace collision check therefore
 * rejects an alias already claimed by any asset (or equal to a canonical
 * token, or already an alias of this asset) exactly as it would on load.
 *
 * BYTE-PRESERVING FIELD EDIT: the registry is operator-owned data recovered via
 * version control (Constitution §2.2.1). The writer never re-serializes the
 * file: it locates the single line defining the target asset (the registry is
 * one entry per line) and rewrites ONLY that line from the parsed-and-amended
 * entry (preserving field order and any unmodeled fields via object spread),
 * leaving every other byte — other entries and the file's trailing-newline
 * convention — verbatim. As a final guard the new text is re-parsed and
 * compared to the validated candidate; on ANY divergence it throws with
 * nothing written.
 *
 * Locations are injected — this store decides no filesystem paths (delivery
 * owns location choice).
 *
 * @param registryPath  location of the registry file (asset id -> entry)
 * @param channelsPath  location of the channels file (for revalidation)
 * @param id            the asset id to add an alias to
 * @param newAlias      the alternate TradingView symbol to add
 * @returns the amended Asset as validated within the candidate registry
 */
export function addAssetAlias(
  registryPath: string,
  channelsPath: string,
  id: string,
  newAlias: string,
): Asset {
  // Read the current definition of record (raw TEXT for the byte-preserving
  // edit, parsed object for validation) and the channels config.
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

  // The amended asset must exist.
  if (!Object.prototype.hasOwnProperty.call(current, id)) {
    throw new RegistryError(`asset id "${id}" does not exist`);
  }
  if (typeof newAlias !== "string" || newAlias.trim().length === 0) {
    throw new RegistryError("alias must be a non-empty string");
  }

  // Build the amended entry in CANONICAL field order (tradingView,
  // tradingViewAliases, display, channel, then any unmodeled fields). The
  // emitted line below uses this same order, so the re-parse-and-compare guard
  // — which compares JSON.stringify (key-order-sensitive) — agrees. Unknown
  // fields are preserved (appended after the modeled ones).
  const existing = current[id] as RawEntry;
  const priorAliases = Array.isArray(existing.tradingViewAliases)
    ? [...(existing.tradingViewAliases as unknown[])]
    : [];
  const amendedEntry: Record<string, unknown> = {
    tradingView: existing.tradingView,
    tradingViewAliases: [...priorAliases, newAlias],
    display: existing.display,
    channel: existing.channel,
  };
  for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
    if (k === "tradingView" || k === "tradingViewAliases" || k === "display" || k === "channel") continue;
    amendedEntry[k] = v;
  }
  const candidate: Record<string, RawEntry> = {
    ...current,
    [id]: amendedEntry as RawEntry,
  };

  // Validate-before-write: the whole candidate through the load-path validator.
  // The combined-namespace collision check rejects a duplicate/claimed alias.
  const validated = buildRegistry(candidate, channels);

  // Byte-preserving field edit. The registry is one entry per line; find the
  // unique line whose parsed key is the target id and rewrite ONLY that line
  // from the amended entry. Any structural surprise throws with nothing written.
  const eol = registryText.includes("\r\n") ? "\r\n" : "\n";
  const lines = registryText.split(eol);
  const idToken = `${JSON.stringify(id)}:`;
  const matches: number[] = [];
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith(idToken)) matches.push(i);
  });
  if (matches.length !== 1) {
    throw new RegistryError(
      `could not locate a unique line for asset "${id}" (found ${matches.length}) — refusing to write`,
    );
  }
  const lineIdx = matches[0]!;
  const original = lines[lineIdx]!;

  // Preserve leading indentation and any trailing comma from the original line.
  const indentMatch = /^(\s*)/u.exec(original);
  const indent = indentMatch ? indentMatch[1]! : "";
  const hasTrailingComma = /,\s*$/u.test(original);

  // Serialize the amended entry's fields in the object's own order (canonical,
  // set above) with the file's " key: value " spacing. Values use
  // JSON.stringify (safe escaping); braces carry single inner spaces.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(amendedEntry)) {
    parts.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  lines[lineIdx] = `${indent}${JSON.stringify(id)}: { ${parts.join(", ")} }${hasTrailingComma ? "," : ""}`;

  const newText = lines.join(eol);

  // Final guard: the edited text must re-parse to EXACTLY the validated
  // candidate. Any divergence means the field edit was unsafe; throw with
  // nothing written.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(newText);
  } catch (e) {
    throw new RegistryError(
      `internal: registry text after alias add is not valid JSON — nothing written (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(candidate)) {
    throw new RegistryError(
      "internal: registry text after alias add does not match the validated candidate — nothing written",
    );
  }

  writeFileSync(registryPath, newText);

  const amended = validated.all().find((a) => a.id === id);
  if (amended === undefined) {
    throw new RegistryError(`internal: amended asset "${id}" missing from validated registry`);
  }
  return amended;
}

/**
 * Remove one alternate TradingView symbol (alias) from an existing Asset
 * (Constitution §5 preamble: definitions are "fully editable"; aliases are
 * declared resolution DATA). This store owns the registry file; the operation
 * is validate-before-write over the WHOLE candidate.
 *
 * SCOPE: remove a single alias, ONLY. This is the subtractive inverse of
 * addAssetAlias and is the natural correction when a wrong alias was declared.
 * When the removed alias is the entry's LAST, the tradingViewAliases field is
 * DROPPED entirely — matching the canonical alias-less shape that buildRegistry
 * and createAsset produce (an empty array is never written). Not done here,
 * each its own boundary: rewriting the canonical `tradingView` token
 * (reconciliation-entangled), amending `channel` (ratified-unresolved field),
 * or `id` (opaque identity, never renamed).
 *
 * VALIDATE-BEFORE-WRITE: the complete candidate registry (the target entry with
 * the alias removed) is validated with buildRegistry — the SAME validator the
 * load path trusts — before a byte is written. The alias must currently be
 * present on the named asset; an unknown id or absent alias is refused with
 * nothing written.
 *
 * BYTE-PRESERVING FIELD EDIT: the registry is operator-owned data recovered via
 * version control (Constitution §2.2.1). The writer never re-serializes the
 * file: it locates the single line defining the target asset (the registry is
 * one entry per line) and rewrites ONLY that line from the parsed-and-amended
 * entry (canonical field order; the alias field dropped when it empties;
 * unmodeled fields preserved), leaving every other byte — other entries and
 * the file's trailing-newline convention — verbatim. As a final guard the new
 * text is re-parsed and compared to the validated candidate; on ANY divergence
 * it throws with nothing written.
 *
 * Locations are injected — this store decides no filesystem paths (delivery
 * owns location choice).
 *
 * @param registryPath  location of the registry file (asset id -> entry)
 * @param channelsPath  location of the channels file (for revalidation)
 * @param id            the asset id to remove an alias from
 * @param alias         the alternate TradingView symbol to remove (exact, case-sensitive)
 * @returns the amended Asset as validated within the candidate registry
 */
export function removeAssetAlias(
  registryPath: string,
  channelsPath: string,
  id: string,
  alias: string,
): Asset {
  // Read the current definition of record (raw TEXT for the byte-preserving
  // edit, parsed object for validation) and the channels config.
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

  // The amended asset must exist.
  if (!Object.prototype.hasOwnProperty.call(current, id)) {
    throw new RegistryError(`asset id "${id}" does not exist`);
  }

  const existing = current[id] as RawEntry;
  const priorAliases = Array.isArray(existing.tradingViewAliases)
    ? [...(existing.tradingViewAliases as unknown[])]
    : [];
  // The alias must currently be present on this asset (exact match).
  if (!priorAliases.includes(alias)) {
    throw new RegistryError(`asset "${id}" has no alias "${alias}"`);
  }
  const remaining = priorAliases.filter((a) => a !== alias);

  // Build the amended entry in CANONICAL field order. When no aliases remain,
  // the field is DROPPED (canonical alias-less shape — never an empty array).
  // The emitted line below uses this same order, so the re-parse-and-compare
  // guard (JSON.stringify, key-order-sensitive) agrees. Unmodeled fields are
  // preserved (appended after the modeled ones).
  const amendedEntry: Record<string, unknown> = {
    tradingView: existing.tradingView,
    ...(remaining.length > 0 ? { tradingViewAliases: remaining } : {}),
    display: existing.display,
    channel: existing.channel,
  };
  for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
    if (k === "tradingView" || k === "tradingViewAliases" || k === "display" || k === "channel") continue;
    amendedEntry[k] = v;
  }
  const candidate: Record<string, RawEntry> = {
    ...current,
    [id]: amendedEntry as RawEntry,
  };

  // Validate-before-write: the whole candidate through the load-path validator.
  const validated = buildRegistry(candidate, channels);

  // Byte-preserving field edit. The registry is one entry per line; find the
  // unique line whose parsed key is the target id and rewrite ONLY that line
  // from the amended entry. Any structural surprise throws with nothing written.
  const eol = registryText.includes("\r\n") ? "\r\n" : "\n";
  const lines = registryText.split(eol);
  const idToken = `${JSON.stringify(id)}:`;
  const matches: number[] = [];
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith(idToken)) matches.push(i);
  });
  if (matches.length !== 1) {
    throw new RegistryError(
      `could not locate a unique line for asset "${id}" (found ${matches.length}) — refusing to write`,
    );
  }
  const lineIdx = matches[0]!;
  const original = lines[lineIdx]!;

  // Preserve leading indentation and any trailing comma from the original line.
  const indentMatch = /^(\s*)/u.exec(original);
  const indent = indentMatch ? indentMatch[1]! : "";
  const hasTrailingComma = /,\s*$/u.test(original);

  // Serialize the amended entry's fields in the object's own order (canonical,
  // set above) with the file's " key: value " spacing. Values use
  // JSON.stringify (safe escaping); braces carry single inner spaces.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(amendedEntry)) {
    parts.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  lines[lineIdx] = `${indent}${JSON.stringify(id)}: { ${parts.join(", ")} }${hasTrailingComma ? "," : ""}`;

  const newText = lines.join(eol);

  // Final guard: the edited text must re-parse to EXACTLY the validated
  // candidate. Any divergence means the field edit was unsafe; throw with
  // nothing written.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(newText);
  } catch (e) {
    throw new RegistryError(
      `internal: registry text after alias remove is not valid JSON — nothing written (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(candidate)) {
    throw new RegistryError(
      "internal: registry text after alias remove does not match the validated candidate — nothing written",
    );
  }

  writeFileSync(registryPath, newText);

  const amended = validated.all().find((a) => a.id === id);
  if (amended === undefined) {
    throw new RegistryError(`internal: amended asset "${id}" missing from validated registry`);
  }
  return amended;
}
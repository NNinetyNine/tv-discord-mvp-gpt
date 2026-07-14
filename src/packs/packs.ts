import { readFileSync, writeFileSync } from "node:fs";

/**
 * Pack loader + validator.
 *
 * Packs are defined as an ORDERED array in definitions/packs.json; the array order
 * IS the publishing/workflow order. Each pack lists internal asset IDs (e.g.
 * "btc"), NOT TradingView symbols — so packs are insulated from filename
 * reconciliation. Every asset ID is validated against the registry on load.
 *
 * CHANNEL ASSIGNMENT IS PACK-OWNED (Constitution §2.1, §5.3): each pack names
 * its Discord channel by channel NAME. The name must exist in the
 * installation's channels config (definition COHERENCE, checked here);
 * whether that name has a provisioned Discord ID is publish's concern
 * (fail-closed there), never load's.
 *
 * Validated loudly (throws PackError) on:
 *   - non-array or empty packs file
 *   - missing / duplicate pack id
 *   - missing display
 *   - missing channel / channel name not present in the channels config
 *   - empty assets array
 *   - duplicate asset id WITHIN a pack
 *   - asset id not found in the registry
 *
 * CROSS-PACK REUSE: an asset MAY appear in more than one pack. This is allowed
 * deliberately — packs are published one at a time, so the same asset belonging
 * to (say) both a "Morning Crypto" and an "Evening Crypto" pack is a valid
 * future use. We therefore do NOT check for the same asset id across different
 * packs; only duplicates *within a single pack* are rejected.
 *
 * WRITE SIDE: createPack (Constitution §5.3) persists a new Pack with its
 * initial membership; removePackAsset (§5.2) removes one asset from a Pack's
 * membership; renamePackDisplay (§5.3) renames a Pack's display. All validate-
 * before-write through buildPacks (reused unchanged), byte-preservingly, and are
 * PURE definition persistence — the §5.2 "Empty-only" gate is a WORKSPACE fact
 * enforced by the delivery layer, never by this store; §5.3 edits are ungated.
 * The other §5.2/§5.3/§5.4 Pack edits are separate concerns, not implemented here.
 */

export interface Pack {
  readonly id: string;
  readonly display: string;
  /** Assigned channel NAME (Pack-owned; channels config maps name -> Discord ID). */
  readonly channel: string;
  readonly assets: readonly string[]; // internal asset IDs, in workflow order
}

export class PackError extends Error {
  constructor(message: string) {
    super(`Pack error: ${message}`);
    this.name = "PackError";
  }
}

interface RawPack {
  id?: unknown;
  display?: unknown;
  channel?: unknown;
  assets?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Build a validated, ordered list of Packs from already-parsed data. Pure (no
 * I/O) so tests inject their own packs + valid-id set + channel-name set.
 *
 * @param raw           parsed packs.json (must be an array)
 * @param validIds      set of asset IDs known to the registry
 * @param channelNames  set of channel NAMES known to the channels config.
 *                      Membership is definition coherence; whether a name has
 *                      a provisioned Discord ID is publish's concern.
 */
export function buildPacks(
  raw: unknown,
  validIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
): readonly Pack[] {
  if (!Array.isArray(raw)) {
    throw new PackError("packs.json must be a JSON array (array order = publishing order)");
  }
  if (raw.length === 0) {
    throw new PackError("packs.json is empty — at least one pack is required");
  }

  const packs: Pack[] = [];
  const seenPackIds = new Set<string>();

  raw.forEach((entry: RawPack, index) => {
    const where = `pack[${index}]`;

    if (typeof entry !== "object" || entry === null) {
      throw new PackError(`${where} is not an object`);
    }
    if (!isNonEmptyString(entry.id)) {
      throw new PackError(`${where}.id must be a non-empty string`);
    }
    if (seenPackIds.has(entry.id)) {
      throw new PackError(`duplicate pack id: "${entry.id}"`);
    }
    if (!isNonEmptyString(entry.display)) {
      throw new PackError(`pack "${entry.id}".display must be a non-empty string`);
    }
    if (!isNonEmptyString(entry.channel)) {
      throw new PackError(`pack "${entry.id}".channel must be a non-empty string`);
    }
    if (!channelNames.has(entry.channel)) {
      throw new PackError(
        `pack "${entry.id}".channel "${entry.channel}" not found in channels config`,
      );
    }
    if (!Array.isArray(entry.assets) || entry.assets.length === 0) {
      throw new PackError(`pack "${entry.id}".assets must be a non-empty array`);
    }

    const seenAssets = new Set<string>();
    for (const assetId of entry.assets) {
      if (!isNonEmptyString(assetId)) {
        throw new PackError(`pack "${entry.id}" has a non-string asset id`);
      }
      if (seenAssets.has(assetId)) {
        throw new PackError(`pack "${entry.id}" lists duplicate asset id "${assetId}"`);
      }
      if (!validIds.has(assetId)) {
        throw new PackError(`pack "${entry.id}" references unknown asset id "${assetId}" (not in registry)`);
      }
      seenAssets.add(assetId);
    }

    seenPackIds.add(entry.id);
    packs.push({ id: entry.id, display: entry.display, channel: entry.channel, assets: [...entry.assets] });
  });

  return packs;
}

/**
 * Load + validate packs from the supplied file on disk, checking asset IDs
 * against the supplied registry-derived valid-id set and channel assignments
 * against the supplied channel-name universe. Location and both dependencies
 * are injected — this store reads only its own file, decides no filesystem
 * paths, and performs no hidden loads (the composition root supplies all
 * three; the dependency shapes are the ones buildPacks declares).
 */
export function loadPacks(
  packsPath: string,
  validIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
): readonly Pack[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packsPath, "utf8"));
  } catch (e) {
    throw new PackError(`could not read/parse ${packsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return buildPacks(raw, validIds, channelNames);
}
/**
 * Input for createPack: the new Pack's id, display, channel assignment, and its
 * INITIAL membership (Constitution §5.3 Create Pack; per the ratified operator
 * ruling a Pack is created WITH its members — an asset-less Pack is not a valid
 * definition, so `assets` must be non-empty, exactly as buildPacks already
 * requires). Members are internal asset ids, in workflow order.
 */
export interface CreatePackInput {
  readonly id: string;
  readonly display: string;
  readonly channel: string;
  readonly assets: readonly string[];
}

/**
 * Create a new Pack definition through Pack-owned persistence (Constitution
 * §5.3 Create Pack: "ungated, in any state, unconfirmed"). This store owns the
 * packs file; creation is validate-before-write over the WHOLE candidate.
 *
 * INITIAL MEMBERSHIP (ratified operator ruling): a Pack is created WITH its
 * members. `buildPacks` is reused UNCHANGED — its existing non-empty-membership
 * rule stands; no validator relaxation is part of this boundary. Subsequent
 * membership changes are §5.2's concern (not implemented here).
 *
 * VALIDATE-BEFORE-WRITE: the complete candidate pack array (every existing pack
 * plus the new one) is validated with buildPacks — the SAME validator the load
 * path trusts — before a byte is written. Duplicate pack id, unknown/blank
 * channel, empty/duplicate/unknown assets all fail loudly here exactly as they
 * would on load. The registry-derived valid-id set and channel-name universe
 * are injected (delivery supplies them, as for loadPacks); this store reads
 * only its own file and decides no filesystem paths.
 *
 * BYTE-PRESERVING APPEND: packs.json is operator-owned data recovered via
 * version control (Constitution §2.2.1). The writer never re-serializes the
 * file: it inserts one pack object before the closing "]" and leaves every
 * existing byte — each pack's fields, order, and formatting — verbatim,
 * preserving the file's own trailing convention. As a final guard the new text
 * is re-parsed and compared to the validated candidate; on ANY divergence it
 * throws with nothing written.
 *
 * @param packsPath     location of the packs file (array of pack objects)
 * @param validIds      set of asset ids known to the registry
 * @param channelNames  set of channel names known to the channels config
 * @param input         the new pack definition, with initial membership
 * @returns the created Pack as validated within the candidate array
 */
export function createPack(
  packsPath: string,
  validIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
  input: CreatePackInput,
): Pack {
  // Read the current definition of record: raw TEXT (for the byte-preserving
  // append) and parsed array (for validation).
  let packsText: string;
  let rawPacks: unknown;
  try {
    packsText = readFileSync(packsPath, "utf8");
    rawPacks = JSON.parse(packsText);
  } catch (e) {
    throw new PackError(`could not read/parse ${packsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(rawPacks)) {
    throw new PackError("packs.json must be a JSON array (array order = publishing order)");
  }
  const current = rawPacks as RawPack[];

  // Creation-specific identity guard: refuse a duplicate pack id loudly BEFORE
  // building the candidate (buildPacks would also catch it, but this names the
  // creation intent precisely).
  if (!isNonEmptyString(input.id)) {
    throw new PackError("pack id must be a non-empty string");
  }
  for (const p of current) {
    if (p !== null && typeof p === "object" && (p as RawPack).id === input.id) {
      throw new PackError(`pack id "${input.id}" already exists`);
    }
  }

  // The new pack entry, fields in the file's canonical order. The COMPLETE
  // candidate pack array is current ∪ { new } — validated as a whole below.
  const entry: RawPack = {
    id: input.id,
    display: input.display,
    channel: input.channel,
    assets: [...input.assets],
  };
  const candidate: unknown[] = [...current, entry];

  // Validate-before-write: the whole candidate through the load-path validator
  // (reused unchanged — non-empty membership required).
  const validated = buildPacks(candidate, validIds, channelNames);

  // Byte-preserving append. Keep everything up to the final closing "]" verbatim;
  // insert one pack object; restore the file's own trailing convention.
  const hadTrailingNewline = /\n$/.test(packsText);
  const trimmedEnd = packsText.replace(/\s+$/u, "");
  if (!trimmedEnd.endsWith("]")) {
    throw new PackError(`packs file at ${packsPath} does not end with "]" — refusing to write`);
  }
  const body = trimmedEnd.slice(0, -1).replace(/\s+$/u, "");
  const isEmptyArray = body.replace(/\s+$/u, "").endsWith("[");
  const separator = isEmptyArray ? "\n" : ",\n";
  const assetsList = input.assets.map((a) => JSON.stringify(a)).join(", ");
  const entryBlock =
    `  {\n` +
    `    "id": ${JSON.stringify(input.id)},\n` +
    `    "display": ${JSON.stringify(input.display)},\n` +
    `    "channel": ${JSON.stringify(input.channel)},\n` +
    `    "assets": [${assetsList}]\n` +
    `  }`;
  const newText = `${body}${separator}${entryBlock}\n]${hadTrailingNewline ? "\n" : ""}`;

  // Final guard: the appended text must re-parse to EXACTLY the validated
  // candidate. Any divergence means the textual splice was unsafe; throw with
  // nothing written.
  if (JSON.stringify(JSON.parse(newText)) !== JSON.stringify(candidate)) {
    throw new PackError(
      "internal: appended packs text does not match the validated candidate — nothing written",
    );
  }

  writeFileSync(packsPath, newText);

  const created = validated.find((p) => p.id === input.id);
  if (created === undefined) {
    throw new PackError(`internal: created pack "${input.id}" missing from validated packs`);
  }
  return created;
}

/**
 * Remove one Asset from a Pack's membership through Pack-owned persistence
 * (Constitution §5.2 Pack membership editing). This store owns the packs file;
 * the operation is validate-before-write over the WHOLE candidate.
 *
 * PURE DEFINITION PERSISTENCE — NO WORKSPACE AWARENESS. §5.2 membership editing
 * is "Empty-only", but "Empty" is a WORKSPACE fact (zero captures), owned solely
 * by the workspace. This store must not know about workspace state: the
 * Empty-only GATE is the delivery layer's responsibility (it consults the
 * workspace before invoking this function). This function performs only the
 * definition edit and its definition-level validation.
 *
 * VALIDATE-BEFORE-WRITE: the complete candidate pack array (the target pack with
 * the asset removed) is validated with buildPacks — the SAME validator the load
 * path trusts, reused UNCHANGED — before a byte is written. Removing a pack's
 * LAST asset is therefore refused by buildPacks' existing non-empty-membership
 * rule (an asset-less pack is not a valid definition); no validator relaxation
 * is part of this boundary. The registry-derived valid-id set and channel-name
 * universe are injected (delivery supplies them, as for loadPacks).
 *
 * BYTE-PRESERVING EDIT: packs.json is operator-owned data recovered via version
 * control (Constitution §2.2.1). The writer never re-serializes the file: it
 * rewrites ONLY the target pack's `assets` array in place (the pack is a
 * multi-line object; its `assets` line is replaced), leaving every other byte —
 * other packs, this pack's id/display/channel, and the file's trailing
 * convention — verbatim. As a final guard the new text is re-parsed and
 * compared to the validated candidate; on ANY divergence it throws with nothing
 * written.
 *
 * @param packsPath     location of the packs file (array of pack objects)
 * @param validIds      set of asset ids known to the registry
 * @param channelNames  set of channel names known to the channels config
 * @param packId        the pack to remove an asset from
 * @param assetId       the asset id to remove
 * @returns the amended Pack as validated within the candidate array
 */
export function removePackAsset(
  packsPath: string,
  validIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
  packId: string,
  assetId: string,
): Pack {
  // Read the current definition of record: raw TEXT (for the byte-preserving
  // edit) and parsed array (for validation).
  let packsText: string;
  let rawPacks: unknown;
  try {
    packsText = readFileSync(packsPath, "utf8");
    rawPacks = JSON.parse(packsText);
  } catch (e) {
    throw new PackError(`could not read/parse ${packsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(rawPacks)) {
    throw new PackError("packs.json must be a JSON array (array order = publishing order)");
  }
  const current = rawPacks as RawPack[];

  // Locate the target pack.
  const targetIndex = current.findIndex(
    (p) => p !== null && typeof p === "object" && (p as RawPack).id === packId,
  );
  if (targetIndex === -1) {
    throw new PackError(`pack "${packId}" does not exist`);
  }
  const target = current[targetIndex] as RawPack;
  const targetAssets = Array.isArray(target.assets) ? [...(target.assets as unknown[])] : [];

  // The asset must currently be a member.
  if (!targetAssets.includes(assetId)) {
    throw new PackError(`pack "${packId}" does not contain asset "${assetId}"`);
  }

  // The COMPLETE candidate, with the asset removed from the target pack's
  // membership (order of the survivors preserved).
  const remaining = targetAssets.filter((a) => a !== assetId);
  const amendedPack: RawPack = { ...target, assets: remaining };
  const candidate: unknown[] = current.map((p, i) => (i === targetIndex ? amendedPack : p));

  // Validate-before-write: the whole candidate through the load-path validator
  // (reused unchanged). Removing the last asset yields an empty `assets` array,
  // which buildPacks refuses — an asset-less pack is not a valid definition.
  const validated = buildPacks(candidate, validIds, channelNames);

  // Byte-preserving edit. Rewrite ONLY the target pack's `assets` line. Each
  // pack is a multi-line object with `assets` on its own line; find the unique
  // "assets": line within the target pack's block and replace its array value.
  const eol = packsText.includes("\r\n") ? "\r\n" : "\n";
  const lines = packsText.split(eol);

  // Delimit the target pack's block by locating its "id": line, then the next
  // "assets": line at or after it.
  const idToken = `"id": ${JSON.stringify(packId)}`;
  const idLineIdx = lines.findIndex((l) => l.includes(idToken));
  if (idLineIdx === -1) {
    throw new PackError(`could not locate the line for pack "${packId}" — refusing to write`);
  }
  let assetsLineIdx = -1;
  for (let i = idLineIdx; i < lines.length; i++) {
    if (/^\s*"assets"\s*:/u.test(lines[i]!)) {
      assetsLineIdx = i;
      break;
    }
    // Stop if we hit the next pack's id before finding assets (malformed).
    if (i > idLineIdx && /^\s*"id"\s*:/u.test(lines[i]!)) break;
  }
  if (assetsLineIdx === -1) {
    throw new PackError(`could not locate the "assets" line for pack "${packId}" — refusing to write`);
  }

  const original = lines[assetsLineIdx]!;
  const assetsRe = /("assets"\s*:\s*)\[[^\]]*\](\s*,?\s*)$/u;
  if (!assetsRe.test(original)) {
    throw new PackError(
      `the "assets" line for pack "${packId}" is not a single-line array — refusing to write`,
    );
  }
  const newArray = `[${remaining.map((a) => JSON.stringify(a)).join(", ")}]`;
  lines[assetsLineIdx] = original.replace(assetsRe, `$1${newArray}$2`);

  const newText = lines.join(eol);

  // Final guard: the edited text must re-parse to EXACTLY the validated
  // candidate. Any divergence means the line surgery was unsafe; throw with
  // nothing written.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(newText);
  } catch (e) {
    throw new PackError(
      `internal: packs text after removal is not valid JSON — nothing written (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(candidate)) {
    throw new PackError(
      "internal: packs text after removal does not match the validated candidate — nothing written",
    );
  }

  writeFileSync(packsPath, newText);

  const amended = validated.find((p) => p.id === packId);
  if (amended === undefined) {
    throw new PackError(`internal: amended pack "${packId}" missing from validated packs`);
  }
  return amended;
}
/**
 * Rename a Pack's display name through Pack-owned persistence (Constitution
 * §5.3: "Pack ... display rename ... Ungated, in any state, unconfirmed. None
 * of these touches any instance's membership or completeness."). This store
 * owns the packs file; the rename is validate-before-write over the WHOLE
 * candidate.
 *
 * UNGATED, PURE DEFINITION PERSISTENCE. §5.3 edits touch no instance state, so
 * this reads NO workspace state and needs no gate — unlike §5.2 membership
 * editing. It performs only the definition edit and its definition-level
 * validation.
 *
 * VALIDATE-BEFORE-WRITE: the complete candidate pack array (the target pack with
 * its display replaced) is validated with buildPacks — the SAME validator the
 * load path trusts, reused UNCHANGED — before a byte is written. A blank display
 * is refused by buildPacks' existing non-empty rule; an unknown pack is refused
 * first. No validator change is part of this boundary.
 *
 * BYTE-PRESERVING FIELD EDIT: packs.json is operator-owned data recovered via
 * version control (Constitution §2.2.1). The writer never re-serializes the
 * file: it rewrites ONLY the target pack's `display` line's value in place (the
 * pack is a multi-line object; its `display` line's string value is replaced),
 * leaving every other byte — other packs, this pack's id/channel/assets, and
 * the file's trailing convention — verbatim. As a final guard the new text is
 * re-parsed and compared to the validated candidate; on ANY divergence it
 * throws with nothing written.
 *
 * @param packsPath     location of the packs file (array of pack objects)
 * @param validIds      set of asset ids known to the registry
 * @param channelNames  set of channel names known to the channels config
 * @param packId        the pack to rename
 * @param newDisplay    the new display name
 * @returns the amended Pack as validated within the candidate array
 */
export function renamePackDisplay(
  packsPath: string,
  validIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
  packId: string,
  newDisplay: string,
): Pack {
  // Read the current definition of record: raw TEXT (for the byte-preserving
  // edit) and parsed array (for validation).
  let packsText: string;
  let rawPacks: unknown;
  try {
    packsText = readFileSync(packsPath, "utf8");
    rawPacks = JSON.parse(packsText);
  } catch (e) {
    throw new PackError(`could not read/parse ${packsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(rawPacks)) {
    throw new PackError("packs.json must be a JSON array (array order = publishing order)");
  }
  const current = rawPacks as RawPack[];

  // Locate the target pack.
  const targetIndex = current.findIndex(
    (p) => p !== null && typeof p === "object" && (p as RawPack).id === packId,
  );
  if (targetIndex === -1) {
    throw new PackError(`pack "${packId}" does not exist`);
  }
  const target = current[targetIndex] as RawPack;

  // The COMPLETE candidate, with only the target pack's display replaced.
  const amendedPack: RawPack = { ...target, display: newDisplay };
  const candidate: unknown[] = current.map((p, i) => (i === targetIndex ? amendedPack : p));

  // Validate-before-write: the whole candidate through the load-path validator
  // (reused unchanged — enforces the non-empty-display rule).
  const validated = buildPacks(candidate, validIds, channelNames);

  // Byte-preserving edit. Rewrite ONLY the target pack's `display` line. Each
  // pack is a multi-line object; find its "id": line, then the "display": line
  // within that pack's block, and replace only that line's string value.
  const eol = packsText.includes("\r\n") ? "\r\n" : "\n";
  const lines = packsText.split(eol);

  const idToken = `"id": ${JSON.stringify(packId)}`;
  const idLineIdx = lines.findIndex((l) => l.includes(idToken));
  if (idLineIdx === -1) {
    throw new PackError(`could not locate the line for pack "${packId}" — refusing to write`);
  }
  let displayLineIdx = -1;
  for (let i = idLineIdx; i < lines.length; i++) {
    if (i > idLineIdx && /^\s*"id"\s*:/u.test(lines[i]!)) break; // next pack; stop
    if (/^\s*"display"\s*:/u.test(lines[i]!)) {
      displayLineIdx = i;
      break;
    }
  }
  if (displayLineIdx === -1) {
    throw new PackError(`could not locate the "display" line for pack "${packId}" — refusing to write`);
  }

  const original = lines[displayLineIdx]!;
  // Replace only the quoted string VALUE after "display":, preserving the
  // trailing comma/whitespace. Mirrors amendAssetDisplay's display-value regex.
  const displayRe = /("display"\s*:\s*)"(?:[^"\\]|\\.)*"(\s*,?\s*)$/u;
  if (!displayRe.test(original)) {
    throw new PackError(
      `the "display" line for pack "${packId}" is not a single-line string — refusing to write`,
    );
  }
  lines[displayLineIdx] = original.replace(displayRe, `$1${JSON.stringify(newDisplay)}$2`);

  const newText = lines.join(eol);

  // Final guard: the edited text must re-parse to EXACTLY the validated
  // candidate. Any divergence means the line surgery was unsafe; throw with
  // nothing written.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(newText);
  } catch (e) {
    throw new PackError(
      `internal: packs text after rename is not valid JSON — nothing written (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(candidate)) {
    throw new PackError(
      "internal: packs text after rename does not match the validated candidate — nothing written",
    );
  }

  writeFileSync(packsPath, newText);

  const amended = validated.find((p) => p.id === packId);
  if (amended === undefined) {
    throw new PackError(`internal: amended pack "${packId}" missing from validated packs`);
  }
  return amended;
}
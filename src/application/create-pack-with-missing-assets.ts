import { createHash } from "node:crypto";

import type { ValidatedAssetLogo } from "../assets/asset-logo.ts";
import type { Asset } from "../types.ts";
import type { Pack } from "../packs/packs.ts";
import { buildRegistry } from "../registry/registry.ts";
import { buildPacks } from "../packs/packs.ts";
import { transformCanonicalPacksSource } from "../packs/pack-draft-promotion.ts";
import { validateAssetRegistrationChannel } from "../registry/asset-registration-channel.ts";
import {
  ASSET_MARKET_IDENTITY_MAX_LENGTHS,
  isQualifiedTradingViewSymbol,
  validatePublicationCurrency,
} from "../registry/asset-market-identity.ts";
import { computeAssetRegistrationRegistryFingerprint } from "../registry/asset-registration-proposal.ts";
import { createAssetRegistrationUnifiedPatch } from "../registry/asset-registration-source-change.ts";

export const CREATE_PACK_WITH_MISSING_ASSETS_SCHEMA_VERSION = 1 as const;
export const CREATE_PACK_PREVIEW_SCHEMA_VERSION = 2 as const;
export const CREATE_PACK_RECEIPT_SCHEMA_VERSION = 2 as const;
export const CREATE_PACK_PREVIEW_TYPE = "visionx.create-pack-with-missing-assets.preview" as const;
export const CREATE_PACK_RECEIPT_TYPE = "visionx.create-pack-with-missing-assets.receipt" as const;

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const QUALIFIED_COMPONENT = /^[A-Z0-9._!-]+$/u;
const MARKET_COMPONENT = /^[A-Z0-9]+$/u;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const DISPLAY_MAX = 120;
const MAX_MEMBERS = 1000;
const MAX_ALIASES = 32;
const MAX_ALIAS_LENGTH = 64;

export interface CreatePackDefinitionInput {
  readonly id: string;
  readonly display: string;
  readonly channel: string;
}

export interface CreatePackMemberInput {
  readonly id: string;
  readonly display?: string;
  readonly tradingView?: string;
  readonly currency?: string;
  readonly tradingViewAliases?: readonly string[];
}

export interface CreatePackWithMissingAssetsInput {
  readonly schemaVersion: 1;
  readonly pack: CreatePackDefinitionInput;
  readonly members: readonly CreatePackMemberInput[];
}

export type CreatePackWithMissingAssetsFailureReason =
  | "invalid_input"
  | "unknown_field"
  | "invalid_pack"
  | "pack_already_exists"
  | "invalid_channel"
  | "unknown_channel"
  | "unresolved_channel"
  | "invalid_member"
  | "invalid_asset_logo_evidence"
  | "duplicate_member"
  | "existing_asset_metadata_override"
  | "existing_asset_currency_missing"
  | "invalid_asset_id"
  | "invalid_display"
  | "invalid_tradingview"
  | "missing_currency"
  | "invalid_currency"
  | "invalid_alias"
  | "asset_id_conflict"
  | "tradingview_conflict"
  | "display_conflict"
  | "invalid_registry"
  | "invalid_packs"
  | "source_shape_unsupported"
  | "source_serialization_failed"
  | "internal_error";

export interface CreatePackWithMissingAssetsFailure {
  readonly ok: false;
  readonly reason: CreatePackWithMissingAssetsFailureReason;
  readonly detail: string;
  readonly memberIndex?: number;
  readonly field?: string;
}

export interface CreatePackResolvedMember {
  readonly id: string;
  readonly display: string;
  readonly tradingView: string;
  readonly currency: string;
  readonly channel: string;
  readonly tradingViewAliases?: readonly string[];
  readonly existing: boolean;
  readonly market: string;
  readonly symbol: string;
}

export type CreatePackAssetLogoEvidence = Readonly<
  { readonly assetId: string } & ValidatedAssetLogo
>;

export type CreatePackChangedPath =
  | "definitions/registry.json"
  | "definitions/packs.json"
  | `assets/asset-logos/${string}.png`;

export interface CreatePackPreview {
  readonly schemaVersion: 2;
  readonly previewType: typeof CREATE_PACK_PREVIEW_TYPE;
  readonly previewId: string;
  readonly inputSha256: string;
  readonly pack: {
    readonly id: string;
    readonly display: string;
    readonly channel: string;
    readonly assetIds: readonly string[];
  };
  readonly members: readonly CreatePackResolvedMember[];
  readonly assetLogos: readonly CreatePackAssetLogoEvidence[];
  readonly existingAssetCount: number;
  readonly missingAssetCount: number;
  readonly counts: {
    readonly registryAssetsBefore: number;
    readonly registryAssetsAfter: number;
    readonly packsBefore: number;
    readonly packsAfter: number;
    readonly packMembershipsBefore: number;
    readonly packMembershipsAfter: number;
  };
  readonly sourceState: {
    readonly registryBeforeSha256: string;
    readonly registryAfterSha256: string;
    readonly packsBeforeSha256: string;
    readonly packsAfterSha256: string;
    readonly channelsSha256: string;
    readonly registryFingerprintBefore: string;
    readonly registryFingerprintAfter: string;
  };
  readonly changedPaths: readonly CreatePackChangedPath[];
  readonly publicationEffects: {
    readonly rendered: false;
    readonly published: false;
    readonly released: false;
    readonly discordContacted: false;
  };
  readonly technicalEvidence: {
    readonly patchSha256: string;
    readonly patchBytes: number;
    readonly patch: string;
  };
}

export interface PreparedCreatePackWithMissingAssets {
  readonly input: CreatePackWithMissingAssetsInput;
  readonly preview: CreatePackPreview;
  readonly registryAfterBytes: Buffer;
  readonly packsAfterBytes: Buffer;
  readonly patchBytes: Buffer;
  readonly assetsAfter: readonly Asset[];
  readonly packsAfter: readonly Pack[];
}

export type CreatePackWithMissingAssetsResult =
  | { readonly ok: true; readonly value: PreparedCreatePackWithMissingAssets }
  | CreatePackWithMissingAssetsFailure;

function fail(
  reason: CreatePackWithMissingAssetsFailureReason,
  detail: string,
  memberIndex?: number,
  field?: string,
): CreatePackWithMissingAssetsFailure {
  return Object.freeze({
    ok: false,
    reason,
    detail,
    ...(memberIndex === undefined ? {} : { memberIndex }),
    ...(field === undefined ? {} : { field }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function isFailure(value: unknown): value is CreatePackWithMissingAssetsFailure {
  return isRecord(value) && value.ok === false && typeof value.reason === "string" && typeof value.detail === "string";
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): CreatePackWithMissingAssetsFailure | null {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allow.has(key));
  if (unknown.length > 0) return fail("unknown_field", `${where} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  return null;
}

function exactText(value: unknown, label: string, maximum: number): string | CreatePackWithMissingAssetsFailure {
  if (typeof value !== "string") return fail("invalid_input", `${label} must be a string`);
  if (value.length === 0 || value.trim().length === 0) return fail("invalid_input", `${label} must not be empty`);
  if (value.trim() !== value) return fail("invalid_input", `${label} must not contain outer whitespace`);
  if (CONTROL_CHARACTER.test(value)) return fail("invalid_input", `${label} must not contain control characters or newlines`);
  if (value.length > maximum) return fail("invalid_input", `${label} exceeds maximum length ${maximum}`);
  return value;
}

function normalizedDisplay(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function countMemberships(packs: readonly Pack[]): number {
  return packs.reduce((total, pack) => total + pack.assets.length, 0);
}

function parseCanonical(
  registryBytes: Buffer,
  packsBytes: Buffer,
  channelsBytes: Buffer,
):
  | {
      readonly registryRaw: Record<string, Record<string, unknown>>;
      readonly packsRaw: readonly unknown[];
      readonly channels: Record<string, unknown>;
      readonly assets: readonly Asset[];
      readonly packs: readonly Pack[];
    }
  | CreatePackWithMissingAssetsFailure {
  let registryValue: unknown;
  let packsValue: unknown;
  let channelsValue: unknown;
  try { registryValue = JSON.parse(registryBytes.toString("utf8")) as unknown; }
  catch { return fail("invalid_registry", "definitions/registry.json is not valid JSON"); }
  try { packsValue = JSON.parse(packsBytes.toString("utf8")) as unknown; }
  catch { return fail("invalid_packs", "definitions/packs.json is not valid JSON"); }
  try { channelsValue = JSON.parse(channelsBytes.toString("utf8")) as unknown; }
  catch { return fail("invalid_channel", "config/channels.json is not valid JSON"); }
  if (!isRecord(registryValue)) return fail("invalid_registry", "definitions/registry.json must be an object");
  if (!Array.isArray(packsValue)) return fail("invalid_packs", "definitions/packs.json must be an array");
  if (!isRecord(channelsValue)) return fail("invalid_channel", "config/channels.json must be an object");
  try {
    const registry = buildRegistry(registryValue as Record<string, Record<string, unknown>>, channelsValue);
    const assets = Object.freeze([...registry.all()]);
    const packs = Object.freeze([...buildPacks(
      packsValue,
      new Set(assets.map((asset) => asset.id)),
      new Set(Object.keys(channelsValue)),
    )]);
    return Object.freeze({
      registryRaw: registryValue as Record<string, Record<string, unknown>>,
      packsRaw: Object.freeze([...packsValue]),
      channels: channelsValue,
      assets,
      packs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return detail.startsWith("Pack error") ? fail("invalid_packs", detail) : fail("invalid_registry", detail);
  }
}

function parseInput(value: unknown): CreatePackWithMissingAssetsInput | CreatePackWithMissingAssetsFailure {
  if (!isRecord(value)) return fail("invalid_input", "Create Pack input must be a JSON object");
  const top = exactFields(value, ["schemaVersion", "pack", "members"], "Create Pack input");
  if (top !== null) return top;
  if (value.schemaVersion !== CREATE_PACK_WITH_MISSING_ASSETS_SCHEMA_VERSION) return fail("invalid_input", "schemaVersion must equal 1");
  if (!isRecord(value.pack)) return fail("invalid_pack", "pack must be a JSON object");
  const packFields = exactFields(value.pack, ["id", "display", "channel"], "pack");
  if (packFields !== null) return packFields;
  const id = exactText(value.pack.id, "pack.id", 64);
  if (typeof id !== "string" || !PACK_ID_PATTERN.test(id)) return typeof id === "string" ? fail("invalid_pack", "pack.id must be a lowercase safe slug") : id;
  const display = exactText(value.pack.display, "pack.display", DISPLAY_MAX);
  if (typeof display !== "string") return fail("invalid_pack", display.detail);
  const channel = exactText(value.pack.channel, "pack.channel", 32);
  if (typeof channel !== "string") return fail("invalid_pack", channel.detail);
  if (!Array.isArray(value.members) || value.members.length === 0 || value.members.length > MAX_MEMBERS) {
    return fail("invalid_pack", `members must be a nonempty array with at most ${MAX_MEMBERS} entries`);
  }
  const members: CreatePackMemberInput[] = [];
  for (let index = 0; index < value.members.length; index += 1) {
    const member = value.members[index];
    if (!isRecord(member)) return fail("invalid_member", `members[${index}] must be a JSON object`, index);
    const fields = exactFields(member, ["id", "display", "tradingView", "currency", "tradingViewAliases"], `members[${index}]`);
    if (fields !== null) return Object.freeze({ ...fields, memberIndex: index });
    const memberId = exactText(member.id, `members[${index}].id`, ASSET_MARKET_IDENTITY_MAX_LENGTHS.assetId);
    if (typeof memberId !== "string" || !ASSET_ID_PATTERN.test(memberId)) {
      return typeof memberId === "string"
        ? fail("invalid_asset_id", `members[${index}].id must be a lowercase Asset slug`, index, "id")
        : Object.freeze({ ...memberId, reason: "invalid_asset_id" as const, memberIndex: index, field: "id" });
    }
    let aliases: readonly string[] | undefined;
    if (member.tradingViewAliases !== undefined) {
      if (!Array.isArray(member.tradingViewAliases) || member.tradingViewAliases.length > MAX_ALIASES) {
        return fail("invalid_alias", `members[${index}].tradingViewAliases must contain at most ${MAX_ALIASES} strings`, index, "tradingViewAliases");
      }
      const normalizedAliases: string[] = [];
      for (const alias of member.tradingViewAliases) {
        const checked = exactText(alias, `members[${index}].tradingViewAliases`, MAX_ALIAS_LENGTH);
        if (typeof checked !== "string") return fail("invalid_alias", checked.detail, index, "tradingViewAliases");
        normalizedAliases.push(checked);
      }
      aliases = Object.freeze(normalizedAliases);
    }
    members.push(Object.freeze({
      id: memberId,
      ...(member.display === undefined ? {} : { display: member.display as string }),
      ...(member.tradingView === undefined ? {} : { tradingView: member.tradingView as string }),
      ...(member.currency === undefined ? {} : { currency: member.currency as string }),
      ...(aliases === undefined ? {} : { tradingViewAliases: aliases }),
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    pack: Object.freeze({ id, display, channel }),
    members: Object.freeze(members),
  });
}

function validateMissingMember(
  member: CreatePackMemberInput,
  index: number,
  channel: string,
): CreatePackResolvedMember | CreatePackWithMissingAssetsFailure {
  const display = exactText(member.display, `members[${index}].display`, ASSET_MARKET_IDENTITY_MAX_LENGTHS.displayName);
  if (typeof display !== "string") return fail("invalid_display", display.detail, index, "display");
  const token = exactText(member.tradingView, `members[${index}].tradingView`, ASSET_MARKET_IDENTITY_MAX_LENGTHS.tradingViewSymbol);
  if (typeof token !== "string" || !isQualifiedTradingViewSymbol(token)) {
    return typeof token === "string"
      ? fail("invalid_tradingview", `members[${index}].tradingView must be a qualified market:symbol token`, index, "tradingView")
      : fail("invalid_tradingview", token.detail, index, "tradingView");
  }
  const [market, symbol] = token.split(":");
  if (market === undefined || symbol === undefined || market.length < 2 || !MARKET_COMPONENT.test(market) || !QUALIFIED_COMPONENT.test(symbol)) {
    return fail("invalid_tradingview", `members[${index}].tradingView components are invalid`, index, "tradingView");
  }
  const currency = validatePublicationCurrency(member.currency);
  if (!currency.ok) {
    return fail(currency.reason === "missing_currency" ? "missing_currency" : "invalid_currency", currency.detail, index, "currency");
  }
  return Object.freeze({
    id: member.id,
    display,
    tradingView: token,
    currency: currency.currency,
    channel,
    ...(member.tradingViewAliases === undefined ? {} : { tradingViewAliases: Object.freeze([...member.tradingViewAliases]) }),
    existing: false,
    market,
    symbol,
  });
}

function appendMissingAssets(
  registryBytes: Buffer,
  rawRegistry: Record<string, Record<string, unknown>>,
  missing: readonly CreatePackResolvedMember[],
  channels: Record<string, unknown>,
):
  | { readonly bytes: Buffer; readonly assets: readonly Asset[] }
  | CreatePackWithMissingAssetsFailure {
  const text = registryBytes.toString("utf8");
  if (text.includes("\r")) return fail("source_shape_unsupported", "Registry source must use LF line endings");
  const trimmedEnd = text.replace(/\s+$/u, "");
  if (!trimmedEnd.endsWith("}")) return fail("source_shape_unsupported", "Registry source must end with a closing object brace");
  const candidate: Record<string, Record<string, unknown>> = { ...rawRegistry };
  const lines: string[] = [];
  for (const asset of missing) {
    const entry: Record<string, unknown> = {
      tradingView: asset.tradingView,
      ...(asset.tradingViewAliases === undefined ? {} : { tradingViewAliases: [...asset.tradingViewAliases] }),
      display: asset.display,
      currency: asset.currency,
      channel: asset.channel,
    };
    candidate[asset.id] = entry;
    const alias = asset.tradingViewAliases === undefined
      ? ""
      : ` "tradingViewAliases": ${JSON.stringify([...asset.tradingViewAliases])},`;
    lines.push(
      `  ${JSON.stringify(asset.id)}: { "tradingView": ${JSON.stringify(asset.tradingView)},` +
      `${alias} "display": ${JSON.stringify(asset.display)},` +
      ` "currency": ${JSON.stringify(asset.currency)},` +
      ` "channel": ${JSON.stringify(asset.channel)} }`,
    );
  }
  const body = trimmedEnd.slice(0, -1).replace(/\s+$/u, "");
  const separator = body.endsWith("{") ? "\n" : ",\n";
  const afterText = `${body}${separator}${lines.join(",\n")}\n}\n`;
  let parsed: unknown;
  try { parsed = JSON.parse(afterText) as unknown; }
  catch { return fail("source_serialization_failed", "Future Registry source could not be parsed"); }
  if (JSON.stringify(parsed) !== JSON.stringify(candidate)) {
    return fail("source_serialization_failed", "Future Registry bytes do not match the validated candidate");
  }
  try {
    const registry = buildRegistry(candidate, channels);
    return Object.freeze({ bytes: Buffer.from(afterText, "utf8"), assets: Object.freeze([...registry.all()]) });
  } catch (error) {
    return fail("invalid_registry", error instanceof Error ? error.message : String(error));
  }
}

export function serializeCreatePackWithMissingAssetsInput(input: CreatePackWithMissingAssetsInput): Buffer {
  return Buffer.from(`${JSON.stringify(input, null, 2)}\n`, "utf8");
}

export function serializeCreatePackPreview(preview: CreatePackPreview): Buffer {
  return Buffer.from(`${JSON.stringify(preview, null, 2)}\n`, "utf8");
}

export function prepareCreatePackWithMissingAssets(input: {
  readonly value: unknown;
  readonly registryBytes: Buffer;
  readonly packsBytes: Buffer;
  readonly channelsBytes: Buffer;
  readonly assetLogos?: ReadonlyMap<string, ValidatedAssetLogo>;
}): CreatePackWithMissingAssetsResult {
  const parsedInput = parseInput(input.value);
  if (isFailure(parsedInput)) return parsedInput;
  const canonical = parseCanonical(input.registryBytes, input.packsBytes, input.channelsBytes);
  if (isFailure(canonical)) return canonical;
  if (canonical.packs.some((pack) => pack.id === parsedInput.pack.id)) {
    return fail("pack_already_exists", `Pack ${parsedInput.pack.id} already exists`);
  }
  const channel = validateAssetRegistrationChannel(parsedInput.pack.channel, canonical.channels);
  if (!channel.ok) {
    return fail(channel.reason === "unknown_channel" ? "unknown_channel" : channel.reason === "unresolved_channel" ? "unresolved_channel" : "invalid_channel", channel.detail);
  }

  const existingById = new Map(canonical.assets.map((asset) => [asset.id, asset] as const));
  const seenMemberIds = new Set<string>();
  const resolved: CreatePackResolvedMember[] = [];
  for (let index = 0; index < parsedInput.members.length; index += 1) {
    const member = parsedInput.members[index] as CreatePackMemberInput;
    if (seenMemberIds.has(member.id)) return fail("duplicate_member", `Asset ${member.id} appears more than once`, index, "id");
    seenMemberIds.add(member.id);
    const existing = existingById.get(member.id);
    if (existing !== undefined) {
      if (member.display !== undefined || member.tradingView !== undefined || member.currency !== undefined || member.tradingViewAliases !== undefined) {
        return fail("existing_asset_metadata_override", `Existing Asset ${member.id} accepts only its stable id in this workflow`, index);
      }
      if (existing.currency === undefined) {
        return fail("existing_asset_currency_missing", `Asset ${member.id} does not have canonical currency metadata. Complete its Asset metadata before creating the Pack.`, index, "currency");
      }
      if (!isQualifiedTradingViewSymbol(existing.tradingView)) {
        return fail("invalid_tradingview", `Existing Asset ${member.id} does not have a qualified canonical TradingView token`, index, "tradingView");
      }
      const [market, symbol] = existing.tradingView.split(":");
      if (market === undefined || symbol === undefined) return fail("invalid_tradingview", `Existing Asset ${member.id} token is invalid`, index, "tradingView");
      resolved.push(Object.freeze({
        id: existing.id,
        display: existing.display,
        tradingView: existing.tradingView,
        currency: existing.currency,
        channel: existing.channel,
        ...(existing.tradingViewAliases === undefined ? {} : { tradingViewAliases: Object.freeze([...existing.tradingViewAliases]) }),
        existing: true,
        market,
        symbol,
      }));
    } else {
      const missing = validateMissingMember(member, index, channel.channel);
      if (isFailure(missing)) return missing;
      resolved.push(missing);
    }
  }

  const existingTokenOwners = new Map<string, string>();
  for (const asset of canonical.assets) {
    existingTokenOwners.set(asset.tradingView.toUpperCase(), asset.id);
    for (const alias of asset.tradingViewAliases ?? []) existingTokenOwners.set(alias.toUpperCase(), asset.id);
  }
  const proposedTokenOwners = new Map<string, string>();
  const displayOwners = new Map(canonical.assets.map((asset) => [normalizedDisplay(asset.display), asset.id] as const));
  for (let index = 0; index < resolved.length; index += 1) {
    const asset = resolved[index] as CreatePackResolvedMember;
    if (asset.existing) continue;
    if (existingById.has(asset.id)) return fail("asset_id_conflict", `Asset id ${asset.id} is already occupied`, index, "id");
    const displayKey = normalizedDisplay(asset.display);
    const displayOwner = displayOwners.get(displayKey);
    if (displayOwner !== undefined && displayOwner !== asset.id) {
      return fail("display_conflict", `Display name ${asset.display} matches existing Asset ${displayOwner}. Select that Asset or correct the display.`, index, "display");
    }
    if (displayOwners.has(displayKey)) return fail("display_conflict", `Display name ${asset.display} is duplicated in the proposed Assets`, index, "display");
    displayOwners.set(displayKey, asset.id);
    const tokens = [asset.tradingView, ...(asset.tradingViewAliases ?? [])];
    const local = new Set<string>();
    for (const token of tokens) {
      const key = token.toUpperCase();
      if (local.has(key)) return fail("tradingview_conflict", `Asset ${asset.id} repeats TradingView token or alias ${token}`, index, "tradingViewAliases");
      local.add(key);
      const existingOwner = existingTokenOwners.get(key);
      if (existingOwner !== undefined) return fail("tradingview_conflict", `${token} is already assigned to Asset ${existingOwner}`, index, "tradingView");
      const proposedOwner = proposedTokenOwners.get(key);
      if (proposedOwner !== undefined) return fail("tradingview_conflict", `${token} is also proposed for Asset ${proposedOwner}`, index, "tradingView");
      proposedTokenOwners.set(key, asset.id);
    }
  }

  const missing = Object.freeze(
    resolved.filter((asset) => !asset.existing),
  );
  const missingIds = new Set(missing.map((asset) => asset.id));

  for (const assetId of input.assetLogos?.keys() ?? []) {
    if (!missingIds.has(assetId)) {
      return fail(
        "invalid_asset_logo_evidence",
        `Asset logo evidence for ${assetId} does not belong to a missing Asset in this Pack preview`,
      );
    }
  }

  const assetLogos: readonly CreatePackAssetLogoEvidence[] =
    Object.freeze(
      missing.flatMap((asset) => {
        const logo = input.assetLogos?.get(asset.id);
        if (logo === undefined) return [];
        return [
          Object.freeze({
            assetId: asset.id,
            ok: true as const,
            sha256: logo.sha256,
            byteSize: logo.byteSize,
            format: logo.format,
            width: logo.width,
            height: logo.height,
            pageOrFrameCount: logo.pageOrFrameCount,
            channelCount: logo.channelCount,
            hasAlpha: logo.hasAlpha,
          }),
        ];
      }),
    );

  const registryFuture = missing.length === 0
    ? Object.freeze({
        bytes: Buffer.from(input.registryBytes),
        assets: canonical.assets,
      })
    : appendMissingAssets(
        input.registryBytes,
        canonical.registryRaw,
        missing,
        canonical.channels,
      );
  if (isFailure(registryFuture)) return registryFuture;
  const packOperation = Object.freeze({
    type: "create_pack" as const,
    packId: parsedInput.pack.id,
    display: parsedInput.pack.display,
    channel: channel.channel,
    assetIds: Object.freeze(resolved.map((asset) => asset.id)),
  });
  const packsFuture = transformCanonicalPacksSource(
    input.packsBytes,
    packOperation,
    new Set(registryFuture.assets.map((asset) => asset.id)),
    new Set(Object.keys(canonical.channels)),
  );
  if (!packsFuture.ok) return fail("invalid_packs", packsFuture.detail);
  try {
    buildPacks(
      JSON.parse(packsFuture.value.bytes.toString("utf8")) as unknown,
      new Set(registryFuture.assets.map((asset) => asset.id)),
      new Set(Object.keys(canonical.channels)),
    );
  } catch (error) {
    return fail("invalid_packs", error instanceof Error ? error.message : String(error));
  }

  const inputBytes = serializeCreatePackWithMissingAssetsInput(parsedInput);
  const patch = createAssetRegistrationUnifiedPatch([
    { path: "definitions/registry.json", before: input.registryBytes, after: registryFuture.bytes },
    { path: "definitions/packs.json", before: input.packsBytes, after: packsFuture.value.bytes },
  ]);
  if (!Buffer.isBuffer(patch)) return fail("source_serialization_failed", patch.detail);
  const beforeFingerprint = computeAssetRegistrationRegistryFingerprint(canonical.assets, canonical.packs);
  const afterFingerprint = computeAssetRegistrationRegistryFingerprint(registryFuture.assets, packsFuture.value.packs);
  const sourceState = Object.freeze({
    registryBeforeSha256: sha256(input.registryBytes),
    registryAfterSha256: sha256(registryFuture.bytes),
    packsBeforeSha256: sha256(input.packsBytes),
    packsAfterSha256: sha256(packsFuture.value.bytes),
    channelsSha256: sha256(input.channelsBytes),
    registryFingerprintBefore: beforeFingerprint,
    registryFingerprintAfter: afterFingerprint,
  });
  const previewIdentityBytes = Buffer.from(
    JSON.stringify({
      inputSha256: sha256(inputBytes),
      assetLogos,
      sourceState,
    }),
    "utf8",
  );
  const preview: CreatePackPreview = Object.freeze({
    schemaVersion: CREATE_PACK_PREVIEW_SCHEMA_VERSION,
    previewType: CREATE_PACK_PREVIEW_TYPE,
    previewId: sha256(previewIdentityBytes),
    inputSha256: sha256(inputBytes),
    pack: Object.freeze({
      id: parsedInput.pack.id,
      display: parsedInput.pack.display,
      channel: channel.channel,
      assetIds: Object.freeze(resolved.map((asset) => asset.id)),
    }),
    members: Object.freeze(resolved.map((asset) => Object.freeze({ ...asset, ...(asset.tradingViewAliases === undefined ? {} : { tradingViewAliases: Object.freeze([...asset.tradingViewAliases]) }) }))),
    assetLogos,
    existingAssetCount: resolved.length - missing.length,
    missingAssetCount: missing.length,
    counts: Object.freeze({
      registryAssetsBefore: canonical.assets.length,
      registryAssetsAfter: registryFuture.assets.length,
      packsBefore: canonical.packs.length,
      packsAfter: packsFuture.value.packs.length,
      packMembershipsBefore: countMemberships(canonical.packs),
      packMembershipsAfter: countMemberships(packsFuture.value.packs),
    }),
    sourceState,
    changedPaths: Object.freeze([
      ...(input.registryBytes.equals(registryFuture.bytes)
        ? []
        : ["definitions/registry.json" as const]),
      ...(input.packsBytes.equals(packsFuture.value.bytes)
        ? []
        : ["definitions/packs.json" as const]),
      ...assetLogos.map(
        ({ assetId }) =>
          `assets/asset-logos/${assetId}.png` as const,
      ),
    ]),
    publicationEffects: Object.freeze({ rendered: false, published: false, released: false, discordContacted: false }),
    technicalEvidence: Object.freeze({ patchSha256: sha256(patch), patchBytes: patch.length, patch: patch.toString("utf8") }),
  });
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      input: parsedInput,
      preview,
      registryAfterBytes: registryFuture.bytes,
      packsAfterBytes: packsFuture.value.bytes,
      patchBytes: patch,
      assetsAfter: registryFuture.assets,
      packsAfter: packsFuture.value.packs,
    }),
  });
}

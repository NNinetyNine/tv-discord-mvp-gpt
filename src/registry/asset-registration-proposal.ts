import { createHash } from "node:crypto";

import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import {
  validateProposedAssetMarketIdentity,
  type AssetMarketIdentityFailureReason,
  type ProposedAssetMarketIdentity,
} from "./asset-market-identity.ts";
import {
  validateChannelAwareProposedAsset,
  type AssetRegistrationChannelFailureReason,
  type ChannelAwareProposedAssetMarketIdentity,
} from "./asset-registration-channel.ts";
import {
  previewChartPublicationMetadataForProposedAsset,
  type ProposedAssetPublicationMetadataPreview,
} from "../application/chart-publication-metadata-preview.ts";

export const ASSET_REGISTRATION_DECISION_MAX_LENGTHS = Object.freeze({
  reviewerId: 64,
  decidedAt: 40,
  referenceId: 96,
  notes: 500,
});

const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;
const LOWER_SHA256 = /^[a-f0-9]{64}$/u;

export type AssetRegistrationOperation = "add" | "update_identity";

export interface AssetRegistrationExpectedCurrentV1 {
  readonly display: string;
  readonly tradingView: string;
}

export interface AssetRegistrationExpectedCurrentV2 extends AssetRegistrationExpectedCurrentV1 {
  readonly channel: string;
}

export type AssetRegistrationExpectedCurrent =
  | AssetRegistrationExpectedCurrentV1
  | AssetRegistrationExpectedCurrentV2;

export interface AssetRegistrationDecision {
  readonly reviewerId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export interface AssetRegistrationInputV1 {
  readonly schemaVersion: 1;
  readonly operation: AssetRegistrationOperation;
  readonly asset: ProposedAssetMarketIdentity;
  readonly targetPackIds: readonly string[];
  readonly decision: AssetRegistrationDecision;
  readonly expectedCurrent?: AssetRegistrationExpectedCurrentV1;
}

export interface AssetRegistrationInputV2 {
  readonly schemaVersion: 2;
  readonly operation: AssetRegistrationOperation;
  readonly asset: ChannelAwareProposedAssetMarketIdentity;
  readonly targetPackIds: readonly string[];
  readonly decision: AssetRegistrationDecision;
  readonly expectedCurrent?: AssetRegistrationExpectedCurrentV2;
}

export type AssetRegistrationInput = AssetRegistrationInputV1 | AssetRegistrationInputV2;

export interface AssetRegistrationTargetPack {
  readonly packId: string;
  readonly membershipAlreadyExists: false;
}

interface AssetRegistrationProposalCommon {
  readonly proposalType: "visionx.asset-registration";
  readonly operation: AssetRegistrationOperation;
  readonly valid: true;
  readonly registryState: {
    readonly assetCount: number;
    readonly registryFingerprint: string;
  };
  readonly targetPacks: readonly AssetRegistrationTargetPack[];
  readonly publicationMetadataPreview: ProposedAssetPublicationMetadataPreview;
  readonly decision: AssetRegistrationDecision;
  readonly applicationStatus: "not_applied";
}

export interface AssetRegistrationProposalV1 extends AssetRegistrationProposalCommon {
  readonly schemaVersion: 1;
  readonly asset: ProposedAssetMarketIdentity;
  readonly expectedCurrent?: AssetRegistrationExpectedCurrentV1;
}

export interface AssetRegistrationProposalV2 extends AssetRegistrationProposalCommon {
  readonly schemaVersion: 2;
  readonly asset: ChannelAwareProposedAssetMarketIdentity;
  readonly expectedCurrent?: AssetRegistrationExpectedCurrentV2;
}

export type AssetRegistrationProposal = AssetRegistrationProposalV1 | AssetRegistrationProposalV2;

export type AssetRegistrationProposalFailureReason =
  | "invalid_registration_input"
  | "unsupported_schema_version"
  | "legacy_proposal_not_applicable"
  | "unsupported_operation"
  | "asset_already_exists"
  | "unknown_asset"
  | "stale_asset_state"
  | "channel_change_not_authorized"
  | AssetMarketIdentityFailureReason
  | AssetRegistrationChannelFailureReason
  | "unknown_target_pack"
  | "duplicate_target_pack"
  | "pack_membership_already_exists";

export interface AssetRegistrationProposalFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationProposalFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationProposalSuccess {
  readonly ok: true;
  readonly proposal: AssetRegistrationProposalV2;
}

export type AssetRegistrationProposalResult =
  | AssetRegistrationProposalSuccess
  | AssetRegistrationProposalFailure;

export type AssetRegistrationProposalReceiptValidationResult =
  | { readonly ok: true; readonly proposal: AssetRegistrationProposal }
  | AssetRegistrationProposalFailure;

function failure(
  reason: AssetRegistrationProposalFailureReason,
  detail: string,
): AssetRegistrationProposalFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isProposalFailure(value: unknown): value is AssetRegistrationProposalFailure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAllowedFields(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  where: string,
): AssetRegistrationProposalFailure | null {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  return unknown.length === 0
    ? null
    : failure(
      "invalid_registration_input",
      `${where} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
}

function validateExactFields(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
): AssetRegistrationProposalFailure | null {
  const unknown = validateAllowedFields(record, new Set(allowed), where);
  if (unknown !== null) return unknown;
  const missing = allowed.filter((field) => !(field in record));
  return missing.length === 0
    ? null
    : failure(
      "invalid_registration_input",
      `${where} is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
}

function validateDecisionString(
  value: unknown,
  field: keyof typeof ASSET_REGISTRATION_DECISION_MAX_LENGTHS,
  multiline: boolean,
): string | AssetRegistrationProposalFailure {
  if (typeof value !== "string") return failure("invalid_registration_input", `decision.${field} must be a string`);
  if (value.length === 0 || value.trim().length === 0) return failure("invalid_registration_input", `decision.${field} must not be empty or whitespace-only`);
  if (value.trim() !== value) return failure("invalid_registration_input", `decision.${field} must not contain outer whitespace`);
  if ((multiline ? CONTROL_CHARACTER : SINGLE_LINE_CONTROL).test(value)) {
    return failure("invalid_registration_input", `decision.${field} contains forbidden control characters${multiline ? "" : " or newlines"}`);
  }
  if (value.length > ASSET_REGISTRATION_DECISION_MAX_LENGTHS[field]) {
    return failure("invalid_registration_input", `decision.${field} exceeds maximum length ${ASSET_REGISTRATION_DECISION_MAX_LENGTHS[field]}`);
  }
  return value;
}

function validTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const datePart = match[1];
  if (datePart === undefined) return false;
  const [yearText, monthText, dayText] = datePart.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function validateDecision(value: unknown): AssetRegistrationDecision | AssetRegistrationProposalFailure {
  if (!isRecord(value)) return failure("invalid_registration_input", "decision must be a JSON object");
  const unknown = validateAllowedFields(value, new Set(["reviewerId", "decidedAt", "referenceId", "notes"]), "decision");
  if (unknown !== null) return unknown;
  const reviewerId = validateDecisionString(value.reviewerId, "reviewerId", false);
  if (typeof reviewerId !== "string") return reviewerId;
  const decidedAt = validateDecisionString(value.decidedAt, "decidedAt", false);
  if (typeof decidedAt !== "string") return decidedAt;
  if (!validTimestamp(decidedAt)) return failure("invalid_registration_input", "decision.decidedAt must be a valid ISO-8601 timestamp with an explicit timezone");
  const referenceId = validateDecisionString(value.referenceId, "referenceId", false);
  if (typeof referenceId !== "string") return referenceId;
  let notes: string | undefined;
  if (value.notes !== undefined) {
    const validatedNotes = validateDecisionString(value.notes, "notes", true);
    if (typeof validatedNotes !== "string") return validatedNotes;
    notes = validatedNotes;
  }
  return Object.freeze({ reviewerId, decidedAt, referenceId, ...(notes === undefined ? {} : { notes }) });
}

function validateExpectedCurrentV1(value: unknown): AssetRegistrationExpectedCurrentV1 | AssetRegistrationProposalFailure {
  if (!isRecord(value)) return failure("invalid_registration_input", "expectedCurrent must be a JSON object for update_identity");
  const unknown = validateExactFields(value, ["display", "tradingView"], "expectedCurrent");
  if (unknown !== null) return unknown;
  if (typeof value.display !== "string" || value.display.length === 0 || value.display.trim() !== value.display) {
    return failure("invalid_registration_input", "expectedCurrent.display must be an exact non-empty string");
  }
  if (typeof value.tradingView !== "string" || value.tradingView.length === 0 || value.tradingView.trim() !== value.tradingView) {
    return failure("invalid_registration_input", "expectedCurrent.tradingView must be an exact non-empty string");
  }
  return Object.freeze({ display: value.display, tradingView: value.tradingView });
}

function validateExpectedCurrentV2(
  value: unknown,
  channels: Readonly<Record<string, unknown>>,
): AssetRegistrationExpectedCurrentV2 | AssetRegistrationProposalFailure {
  if (!isRecord(value)) return failure("invalid_registration_input", "expectedCurrent must be a JSON object for update_identity");
  const unknown = validateExactFields(value, ["display", "tradingView", "channel"], "expectedCurrent");
  if (unknown !== null) return unknown;
  const base = validateExpectedCurrentV1({ display: value.display, tradingView: value.tradingView });
  if (isProposalFailure(base)) return base;
  const channel = validateChannelAwareProposedAsset(
    {
      id: "expected_current",
      displayName: "Expected Current",
      symbol: "EXPECTED",
      market: "MARKET",
      tradingViewSymbol: "MARKET:EXPECTED",
      currency: "USD",
    },
    value.channel,
    channels,
  );
  if (!channel.ok) return channel;
  return Object.freeze({ ...base, channel: channel.asset.channel });
}

function validateTargetPackIds(value: unknown): readonly string[] | AssetRegistrationProposalFailure {
  if (!Array.isArray(value)) return failure("invalid_registration_input", "targetPackIds must be an array");
  const targetPackIds: string[] = [];
  const seen = new Set<string>();
  for (const target of value) {
    if (typeof target !== "string" || target.length === 0 || target.trim() !== target || SINGLE_LINE_CONTROL.test(target)) {
      return failure("invalid_registration_input", "targetPackIds must contain exact non-empty strings");
    }
    if (seen.has(target)) return failure("duplicate_target_pack", `target Pack id ${target} is duplicated`);
    seen.add(target);
    targetPackIds.push(target);
  }
  return Object.freeze(targetPackIds);
}

function validateBaseAsset(value: unknown):
  | { readonly ok: true; readonly asset: ProposedAssetMarketIdentity }
  | AssetRegistrationProposalFailure {
  const result = validateProposedAssetMarketIdentity(value);
  return result.ok ? result : result;
}

function validateAssetV2(
  value: unknown,
  channels: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly asset: ChannelAwareProposedAssetMarketIdentity }
  | AssetRegistrationProposalFailure {
  if (!isRecord(value)) return failure("invalid_asset_id", "asset must be a JSON object");
  const unknown = validateAllowedFields(
    value,
    new Set(["id", "displayName", "symbol", "market", "tradingViewSymbol", "currency", "channel"]),
    "asset",
  );
  if (unknown !== null) return unknown;
  const base = validateBaseAsset({
    id: value.id,
    displayName: value.displayName,
    symbol: value.symbol,
    market: value.market,
    tradingViewSymbol: value.tradingViewSymbol,
    currency: value.currency,
  });
  if (!base.ok) return base;
  return validateChannelAwareProposedAsset(base.asset, value.channel, channels);
}

export function validateAssetRegistrationInput(
  value: unknown,
  channels?: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly input: AssetRegistrationInput }
  | AssetRegistrationProposalFailure {
  if (!isRecord(value)) return failure("invalid_registration_input", "registration input must be a JSON object");
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    return failure("unsupported_schema_version", "schemaVersion must equal 1 or 2");
  }
  const version = value.schemaVersion;
  const unknown = validateAllowedFields(value, new Set(["schemaVersion", "operation", "asset", "targetPackIds", "decision", "expectedCurrent"]), "registration input");
  if (unknown !== null) return unknown;
  if (value.operation !== "add" && value.operation !== "update_identity") {
    return failure("unsupported_operation", "operation must be add or update_identity");
  }
  const asset = version === 1
    ? validateBaseAsset(value.asset)
    : channels === undefined
      ? failure("unresolved_channel", "channel configuration is required for schemaVersion 2")
      : validateAssetV2(value.asset, channels);
  if (!asset.ok) return asset;
  const targetPackIds = validateTargetPackIds(value.targetPackIds);
  if (isProposalFailure(targetPackIds)) return targetPackIds;
  const decision = validateDecision(value.decision);
  if (isProposalFailure(decision)) return decision;

  if (value.operation === "update_identity") {
    const expected = version === 1
      ? validateExpectedCurrentV1(value.expectedCurrent)
      : validateExpectedCurrentV2(value.expectedCurrent, channels ?? {});
    if (isProposalFailure(expected)) return expected;
    if (version === 1) {
      return Object.freeze({
        ok: true,
        input: Object.freeze({
          schemaVersion: 1,
          operation: value.operation,
          asset: asset.asset as ProposedAssetMarketIdentity,
          targetPackIds,
          decision,
          expectedCurrent: expected as AssetRegistrationExpectedCurrentV1,
        }),
      });
    }
    return Object.freeze({
      ok: true,
      input: Object.freeze({
        schemaVersion: 2,
        operation: value.operation,
        asset: asset.asset as ChannelAwareProposedAssetMarketIdentity,
        targetPackIds,
        decision,
        expectedCurrent: expected as AssetRegistrationExpectedCurrentV2,
      }),
    });
  }
  if (value.expectedCurrent !== undefined) {
    return failure("invalid_registration_input", "expectedCurrent is only allowed for update_identity");
  }
  return version === 1
    ? Object.freeze({
      ok: true,
      input: Object.freeze({
        schemaVersion: 1,
        operation: value.operation,
        asset: asset.asset as ProposedAssetMarketIdentity,
        targetPackIds,
        decision,
      }),
    })
    : Object.freeze({
      ok: true,
      input: Object.freeze({
        schemaVersion: 2,
        operation: value.operation,
        asset: asset.asset as ChannelAwareProposedAssetMarketIdentity,
        targetPackIds,
        decision,
      }),
    });
}

export function computeAssetRegistrationRegistryFingerprint(
  assets: readonly Asset[],
  packs: readonly Pack[],
): string {
  const canonical = {
    assets: [...assets]
      .sort((a, b) => a.id.localeCompare(b.id, "en"))
      .map((asset) => ({
        id: asset.id,
        tradingView: asset.tradingView,
        tradingViewAliases: asset.tradingViewAliases === undefined ? [] : [...asset.tradingViewAliases],
        display: asset.display,
        channel: asset.channel,
      })),
    packs: packs.map((pack) => ({ id: pack.id, display: pack.display, channel: pack.channel, assets: [...pack.assets] })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function freezeProposal<T extends AssetRegistrationProposal>(proposal: T): T {
  return Object.freeze({
    ...proposal,
    registryState: Object.freeze({ ...proposal.registryState }),
    asset: Object.freeze({ ...proposal.asset }),
    targetPacks: Object.freeze(proposal.targetPacks.map((target) => Object.freeze({ ...target }))),
    publicationMetadataPreview: Object.freeze({ ...proposal.publicationMetadataPreview }),
    decision: Object.freeze({ ...proposal.decision }),
    ...(proposal.expectedCurrent === undefined ? {} : { expectedCurrent: Object.freeze({ ...proposal.expectedCurrent }) }),
  }) as unknown as T;
}

function validateRegistryState(value: unknown):
  | { readonly assetCount: number; readonly registryFingerprint: string }
  | AssetRegistrationProposalFailure {
  if (!isRecord(value)) return failure("invalid_registration_input", "proposal.registryState must be a JSON object");
  const fields = validateExactFields(value, ["assetCount", "registryFingerprint"], "proposal.registryState");
  if (fields !== null) return fields;
  if (!Number.isSafeInteger(value.assetCount) || Number(value.assetCount) < 0) {
    return failure("invalid_registration_input", "proposal.registryState.assetCount must be a non-negative safe integer");
  }
  if (typeof value.registryFingerprint !== "string" || !LOWER_SHA256.test(value.registryFingerprint)) {
    return failure("invalid_registration_input", "proposal.registryState.registryFingerprint must be a lowercase SHA-256 digest");
  }
  return Object.freeze({ assetCount: Number(value.assetCount), registryFingerprint: value.registryFingerprint });
}

function validateReceiptTargets(value: unknown): readonly AssetRegistrationTargetPack[] | AssetRegistrationProposalFailure {
  if (!Array.isArray(value)) return failure("invalid_registration_input", "proposal.targetPacks must be an array");
  const targets: AssetRegistrationTargetPack[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const target = value[index];
    if (!isRecord(target)) return failure("invalid_registration_input", `proposal.targetPacks[${index}] must be a JSON object`);
    const fields = validateExactFields(target, ["packId", "membershipAlreadyExists"], `proposal.targetPacks[${index}]`);
    if (fields !== null) return fields;
    if (typeof target.packId !== "string" || target.packId.length === 0 || target.packId.trim() !== target.packId) {
      return failure("invalid_registration_input", `proposal.targetPacks[${index}].packId must be an exact non-empty string`);
    }
    if (target.membershipAlreadyExists !== false) {
      return failure("invalid_registration_input", `proposal.targetPacks[${index}].membershipAlreadyExists must equal false`);
    }
    if (seen.has(target.packId)) return failure("duplicate_target_pack", `proposal target Pack ${target.packId} is duplicated`);
    seen.add(target.packId);
    targets.push(Object.freeze({ packId: target.packId, membershipAlreadyExists: false }));
  }
  return Object.freeze(targets);
}

export function validateAssetRegistrationProposalReceipt(
  value: unknown,
  channels?: Readonly<Record<string, unknown>>,
): AssetRegistrationProposalReceiptValidationResult {
  if (!isRecord(value)) return failure("invalid_registration_input", "proposal must be a JSON object");
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    return failure("unsupported_schema_version", "proposal.schemaVersion must equal 1 or 2");
  }
  const version = value.schemaVersion;
  if (value.operation !== "add" && value.operation !== "update_identity") {
    return failure("unsupported_operation", "proposal.operation must be add or update_identity");
  }
  const topFields = value.operation === "update_identity"
    ? ["schemaVersion", "proposalType", "operation", "valid", "registryState", "asset", "targetPacks", "publicationMetadataPreview", "decision", "expectedCurrent", "applicationStatus"]
    : ["schemaVersion", "proposalType", "operation", "valid", "registryState", "asset", "targetPacks", "publicationMetadataPreview", "decision", "applicationStatus"];
  const top = validateExactFields(value, topFields, "proposal");
  if (top !== null) return top;
  if (value.proposalType !== "visionx.asset-registration" || value.valid !== true || value.applicationStatus !== "not_applied") {
    return failure("invalid_registration_input", "proposal identity, validity, or applicationStatus is unsupported");
  }
  const registryState = validateRegistryState(value.registryState);
  if (isProposalFailure(registryState)) return registryState;
  const targets = validateReceiptTargets(value.targetPacks);
  if (isProposalFailure(targets)) return targets;
  const reconstructed = validateAssetRegistrationInput({
    schemaVersion: version,
    operation: value.operation,
    asset: value.asset,
    targetPackIds: targets.map((target) => target.packId),
    decision: value.decision,
    ...(value.operation === "update_identity" ? { expectedCurrent: value.expectedCurrent } : {}),
  }, channels);
  if (!reconstructed.ok) return reconstructed;
  if (!isRecord(value.publicationMetadataPreview)) {
    return failure("invalid_registration_input", "proposal.publicationMetadataPreview must be a JSON object");
  }
  const previewFields = validateExactFields(value.publicationMetadataPreview, ["title", "symbol", "market", "currency"], "proposal.publicationMetadataPreview");
  if (previewFields !== null) return previewFields;
  const expectedPreview = previewChartPublicationMetadataForProposedAsset(reconstructed.input.asset);
  if (JSON.stringify(value.publicationMetadataPreview) !== JSON.stringify(expectedPreview)) {
    return failure("invalid_registration_input", "proposal.publicationMetadataPreview does not match the proposed Asset identity");
  }
  if (version === 1) {
    const input = reconstructed.input as AssetRegistrationInputV1;
    return Object.freeze({
      ok: true,
      proposal: freezeProposal({
        schemaVersion: 1,
        proposalType: "visionx.asset-registration",
        operation: input.operation,
        valid: true,
        registryState,
        asset: input.asset,
        targetPacks: targets,
        publicationMetadataPreview: expectedPreview,
        decision: input.decision,
        ...(input.expectedCurrent === undefined ? {} : { expectedCurrent: input.expectedCurrent }),
        applicationStatus: "not_applied",
      }),
    });
  }
  const input = reconstructed.input as AssetRegistrationInputV2;
  return Object.freeze({
    ok: true,
    proposal: freezeProposal({
      schemaVersion: 2,
      proposalType: "visionx.asset-registration",
      operation: input.operation,
      valid: true,
      registryState,
      asset: input.asset,
      targetPacks: targets,
      publicationMetadataPreview: expectedPreview,
      decision: input.decision,
      ...(input.expectedCurrent === undefined ? {} : { expectedCurrent: input.expectedCurrent }),
      applicationStatus: "not_applied",
    }),
  });
}

export function proposeAssetRegistration(
  value: unknown,
  assets: readonly Asset[],
  packs: readonly Pack[],
  channels: Readonly<Record<string, unknown>>,
): AssetRegistrationProposalResult {
  const validated = validateAssetRegistrationInput(value, channels);
  if (!validated.ok) return validated;
  if (validated.input.schemaVersion === 1) {
    return failure("legacy_proposal_not_applicable", "new registration proposals require schemaVersion 2 with explicit channel");
  }
  const input = validated.input;
  const existing = assets.find((asset) => asset.id === input.asset.id);
  if (input.operation === "add" && existing !== undefined) {
    return failure("asset_already_exists", `Asset id ${input.asset.id} already exists`);
  }
  if (input.operation === "update_identity") {
    if (existing === undefined) return failure("unknown_asset", `Asset id ${input.asset.id} is not registered`);
    const expected = input.expectedCurrent;
    if (expected === undefined) return failure("invalid_registration_input", "expectedCurrent is required for update_identity");
    if (
      existing.display !== expected.display ||
      existing.tradingView !== expected.tradingView ||
      existing.channel !== expected.channel
    ) {
      return failure("stale_asset_state", `Asset ${input.asset.id} no longer matches expectedCurrent`);
    }
    if (input.asset.channel !== existing.channel) {
      return failure("channel_change_not_authorized", "update_identity cannot change an Asset logical channel");
    }
  }

  const packById = new Map(packs.map((pack, index) => [pack.id, { pack, index }] as const));
  const targets: Array<{ packId: string; membershipAlreadyExists: false; index: number }> = [];
  for (const packId of input.targetPackIds) {
    const found = packById.get(packId);
    if (found === undefined) return failure("unknown_target_pack", `Pack id ${packId} does not exist`);
    if (found.pack.assets.includes(input.asset.id)) {
      return failure("pack_membership_already_exists", `Pack ${packId} already contains Asset ${input.asset.id}`);
    }
    targets.push({ packId, membershipAlreadyExists: false, index: found.index });
  }
  targets.sort((a, b) => a.index - b.index || a.packId.localeCompare(b.packId, "en"));

  const proposal = freezeProposal<AssetRegistrationProposalV2>({
    schemaVersion: 2,
    proposalType: "visionx.asset-registration",
    operation: input.operation,
    valid: true,
    registryState: Object.freeze({
      assetCount: assets.length,
      registryFingerprint: computeAssetRegistrationRegistryFingerprint(assets, packs),
    }),
    asset: input.asset,
    targetPacks: Object.freeze(targets.map(({ packId, membershipAlreadyExists }) => Object.freeze({ packId, membershipAlreadyExists }))),
    publicationMetadataPreview: previewChartPublicationMetadataForProposedAsset(input.asset),
    decision: input.decision,
    ...(input.expectedCurrent === undefined ? {} : { expectedCurrent: input.expectedCurrent }),
    applicationStatus: "not_applied",
  });
  return Object.freeze({ ok: true, proposal });
}

export function serializeAssetRegistrationProposal(proposal: AssetRegistrationProposal): Buffer {
  return Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

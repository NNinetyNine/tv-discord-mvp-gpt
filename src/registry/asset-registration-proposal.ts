import { createHash } from "node:crypto";

import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import {
  validateProposedAssetMarketIdentity,
  type AssetMarketIdentityFailureReason,
  type ProposedAssetMarketIdentity,
} from "./asset-market-identity.ts";
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

export type AssetRegistrationOperation = "add" | "update_identity";

export interface AssetRegistrationExpectedCurrent {
  readonly display: string;
  readonly tradingView: string;
}

export interface AssetRegistrationDecision {
  readonly reviewerId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export interface AssetRegistrationInput {
  readonly schemaVersion: 1;
  readonly operation: AssetRegistrationOperation;
  readonly asset: ProposedAssetMarketIdentity;
  readonly targetPackIds: readonly string[];
  readonly decision: AssetRegistrationDecision;
  readonly expectedCurrent?: AssetRegistrationExpectedCurrent;
}

export interface AssetRegistrationTargetPack {
  readonly packId: string;
  readonly membershipAlreadyExists: false;
}

export interface AssetRegistrationProposal {
  readonly schemaVersion: 1;
  readonly proposalType: "visionx.asset-registration";
  readonly operation: AssetRegistrationOperation;
  readonly valid: true;
  readonly registryState: {
    readonly assetCount: number;
    readonly registryFingerprint: string;
  };
  readonly asset: ProposedAssetMarketIdentity;
  readonly targetPacks: readonly AssetRegistrationTargetPack[];
  readonly publicationMetadataPreview: ProposedAssetPublicationMetadataPreview;
  readonly decision: AssetRegistrationDecision;
  readonly expectedCurrent?: AssetRegistrationExpectedCurrent;
  readonly applicationStatus: "not_applied";
}

export type AssetRegistrationProposalFailureReason =
  | "invalid_registration_input"
  | "unsupported_operation"
  | "asset_already_exists"
  | "unknown_asset"
  | "stale_asset_state"
  | AssetMarketIdentityFailureReason
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
  readonly proposal: AssetRegistrationProposal;
}

export type AssetRegistrationProposalResult = AssetRegistrationProposalSuccess | AssetRegistrationProposalFailure;

function failure(reason: AssetRegistrationProposalFailureReason, detail: string): AssetRegistrationProposalFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isProposalFailure(value: unknown): value is AssetRegistrationProposalFailure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAllowedFields(record: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, where: string): AssetRegistrationProposalFailure | null {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  return unknown.length === 0
    ? null
    : failure("invalid_registration_input", `${where} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
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

function validateExpectedCurrent(value: unknown): AssetRegistrationExpectedCurrent | AssetRegistrationProposalFailure {
  if (!isRecord(value)) return failure("invalid_registration_input", "expectedCurrent must be a JSON object for update_identity");
  const unknown = validateAllowedFields(value, new Set(["display", "tradingView"]), "expectedCurrent");
  if (unknown !== null) return unknown;
  if (typeof value.display !== "string" || value.display.length === 0 || value.display.trim() !== value.display) {
    return failure("invalid_registration_input", "expectedCurrent.display must be an exact non-empty string");
  }
  if (typeof value.tradingView !== "string" || value.tradingView.length === 0 || value.tradingView.trim() !== value.tradingView) {
    return failure("invalid_registration_input", "expectedCurrent.tradingView must be an exact non-empty string");
  }
  return Object.freeze({ display: value.display, tradingView: value.tradingView });
}

export function validateAssetRegistrationInput(value: unknown):
  | { readonly ok: true; readonly input: AssetRegistrationInput }
  | AssetRegistrationProposalFailure {
  if (!isRecord(value)) return failure("invalid_registration_input", "registration input must be a JSON object");
  const unknown = validateAllowedFields(value, new Set(["schemaVersion", "operation", "asset", "targetPackIds", "decision", "expectedCurrent"]), "registration input");
  if (unknown !== null) return unknown;
  if (value.schemaVersion !== 1) return failure("invalid_registration_input", "schemaVersion must equal 1");
  if (value.operation !== "add" && value.operation !== "update_identity") {
    return failure("unsupported_operation", "operation must be add or update_identity");
  }
  const asset = validateProposedAssetMarketIdentity(value.asset);
  if (!asset.ok) return asset;
  if (!Array.isArray(value.targetPackIds)) return failure("invalid_registration_input", "targetPackIds must be an array");
  const targetPackIds: string[] = [];
  const seen = new Set<string>();
  for (const target of value.targetPackIds) {
    if (typeof target !== "string" || target.length === 0 || target.trim() !== target || SINGLE_LINE_CONTROL.test(target)) {
      return failure("invalid_registration_input", "targetPackIds must contain exact non-empty strings");
    }
    if (seen.has(target)) return failure("duplicate_target_pack", `target Pack id ${target} is duplicated`);
    seen.add(target);
    targetPackIds.push(target);
  }
  const decision = validateDecision(value.decision);
  if (isProposalFailure(decision)) return decision;
  let expectedCurrent: AssetRegistrationExpectedCurrent | undefined;
  if (value.operation === "update_identity") {
    const validated = validateExpectedCurrent(value.expectedCurrent);
    if (isProposalFailure(validated)) return validated;
    expectedCurrent = validated;
  } else if (value.expectedCurrent !== undefined) {
    return failure("invalid_registration_input", "expectedCurrent is only allowed for update_identity");
  }

  return Object.freeze({
    ok: true,
    input: Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      asset: asset.asset,
      targetPackIds: Object.freeze(targetPackIds),
      decision,
      ...(expectedCurrent === undefined ? {} : { expectedCurrent }),
    }),
  });
}

export function computeAssetRegistrationRegistryFingerprint(assets: readonly Asset[], packs: readonly Pack[]): string {
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

function freezeProposal(proposal: AssetRegistrationProposal): AssetRegistrationProposal {
  return Object.freeze({
    ...proposal,
    registryState: Object.freeze({ ...proposal.registryState }),
    asset: Object.freeze({ ...proposal.asset }),
    targetPacks: Object.freeze(proposal.targetPacks.map((target) => Object.freeze({ ...target }))),
    publicationMetadataPreview: Object.freeze({ ...proposal.publicationMetadataPreview }),
    decision: Object.freeze({ ...proposal.decision }),
    ...(proposal.expectedCurrent === undefined ? {} : { expectedCurrent: Object.freeze({ ...proposal.expectedCurrent }) }),
  });
}

export function proposeAssetRegistration(
  value: unknown,
  assets: readonly Asset[],
  packs: readonly Pack[],
): AssetRegistrationProposalResult {
  const validated = validateAssetRegistrationInput(value);
  if (!validated.ok) return validated;
  const input = validated.input;
  const existing = assets.find((asset) => asset.id === input.asset.id);
  if (input.operation === "add" && existing !== undefined) {
    return failure("asset_already_exists", `Asset id ${input.asset.id} already exists`);
  }
  if (input.operation === "update_identity") {
    if (existing === undefined) return failure("unknown_asset", `Asset id ${input.asset.id} is not registered`);
    const expected = input.expectedCurrent;
    if (expected === undefined) return failure("invalid_registration_input", "expectedCurrent is required for update_identity");
    if (existing.display !== expected.display || existing.tradingView !== expected.tradingView) {
      return failure("stale_asset_state", `Asset ${input.asset.id} no longer matches expectedCurrent`);
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

  const proposal = freezeProposal({
    schemaVersion: 1,
    proposalType: "visionx.asset-registration",
    operation: input.operation,
    valid: true,
    registryState: Object.freeze({ assetCount: assets.length, registryFingerprint: computeAssetRegistrationRegistryFingerprint(assets, packs) }),
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

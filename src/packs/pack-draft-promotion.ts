import { createHash } from "node:crypto";

import type { Asset } from "../types.ts";
import { type Pack, buildPacks } from "./packs.ts";
import {
  type PackDraft,
  parsePackDraft,
  serializePackDraft,
  isValidPackDraftId,
} from "../admin/admin-types.ts";
import { validateAssetRegistrationChannel } from "../registry/asset-registration-channel.ts";
import { computeAssetRegistrationRegistryFingerprint } from "../registry/asset-registration-proposal.ts";

export const PACK_PROMOTION_REQUEST_SCHEMA_VERSION = 1 as const;
export const PACK_PROMOTION_REQUEST_TYPE = "visionx.pack-draft-promotion-request" as const;
export const PACK_SOURCE_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const PACK_SOURCE_PROPOSAL_TYPE = "visionx.pack-source-proposal" as const;
export const PACK_SOURCE_PLANNING_AUTHORIZATION_SCHEMA_VERSION = 1 as const;
export const PACK_SOURCE_APPLICATION_PLAN_SCHEMA_VERSION = 1 as const;
export const PACK_SOURCE_APPLICATION_PLAN_TYPE = "visionx.pack-source.application-plan" as const;
export const PACK_SOURCE_CHANGE_SCHEMA_VERSION = 1 as const;
export const PACK_SOURCE_CHANGE_TYPE = "visionx.pack.source-change" as const;

export const PACK_PROMOTION_TEXT_LIMITS = Object.freeze({
  curatorId: 64,
  decidedAt: 40,
  referenceId: 96,
  notes: 500,
});

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;
const NUMERIC_DISCORD_CHANNEL = /^[0-9]{17,20}$/u;

export type PackPromotionOperation = "create_pack" | "replace_pack_assets";
export type PackPromotionDecision = "approved" | "rejected";

export type PackPromotionFailureReason =
  | "invalid_promotion_request"
  | "invalid_pack_proposal"
  | "invalid_planning_authorization"
  | "invalid_pack_application_plan"
  | "invalid_pack_source_change_receipt"
  | "unsupported_schema_version"
  | "operation_not_supported"
  | "operation_state_mismatch"
  | "promotion_not_authorized"
  | "planning_authorization_rejected"
  | "draft_not_found"
  | "draft_revision_conflict"
  | "draft_hash_mismatch"
  | "draft_asset_not_found"
  | "duplicate_draft_asset"
  | "proposal_hash_mismatch"
  | "planning_authorization_hash_mismatch"
  | "application_plan_hash_mismatch"
  | "proposal_reconstruction_mismatch"
  | "plan_reconstruction_mismatch"
  | "stale_registry_state"
  | "stale_pack_state"
  | "stale_pack_membership"
  | "stale_registry_fingerprint"
  | "pack_already_exists"
  | "pack_not_found"
  | "pack_channel_required"
  | "pack_channel_invalid"
  | "pack_channel_not_configured"
  | "pack_channel_change_not_supported"
  | "numeric_channel_id_not_allowed"
  | "source_shape_unsupported"
  | "source_serialization_failed"
  | "source_reload_failed"
  | "source_result_mismatch"
  | "patch_generation_failed";

export interface PackPromotionFailure {
  readonly ok: false;
  readonly reason: PackPromotionFailureReason;
  readonly detail: string;
}

export interface PackDraftPromotionRequest {
  readonly schemaVersion: 1;
  readonly requestType: typeof PACK_PROMOTION_REQUEST_TYPE;
  readonly operation: PackPromotionOperation;
  readonly draftId: string;
  readonly expectedRevision: number;
  readonly channel?: string;
  readonly curatorId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export interface PackPromotionCanonicalPack {
  readonly id: string;
  readonly display: string;
  readonly channel: string;
  readonly assetIds: readonly string[];
}

export interface PackSourceProposal {
  readonly schemaVersion: 1;
  readonly proposalType: typeof PACK_SOURCE_PROPOSAL_TYPE;
  readonly operation: PackPromotionOperation;
  readonly pack: PackPromotionCanonicalPack;
  readonly workspaceMetadata: {
    readonly description?: string;
    readonly canonicalFields: readonly ["id", "display", "channel", "assets"];
    readonly workspaceOnlyFields: readonly ["description", "draftRevision", "curatorNotes"];
  };
  readonly draft: {
    readonly id: string;
    readonly revision: number;
    readonly sha256: string;
  };
  readonly promotionRequest: {
    readonly sha256: string;
    readonly curatorId: string;
    readonly decidedAt: string;
    readonly referenceId: string;
    readonly notes?: string;
  };
  readonly sourceState: {
    readonly registrySha256: string;
    readonly packsSha256: string;
    readonly channelsSha256: string;
    readonly registryFingerprint: string;
  };
  readonly proposalStatus: "proposed_not_planned";
  readonly sourceChangesApplied: false;
}

export interface PackSourcePlanningAuthorization {
  readonly schemaVersion: 1;
  readonly decision: PackPromotionDecision;
  readonly packProposalSha256: string;
  readonly draftSha256: string;
  readonly promotionRequestSha256: string;
  readonly curatorId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export interface CreatePackPlanOperation {
  readonly type: "create_pack";
  readonly packId: string;
  readonly display: string;
  readonly channel: string;
  readonly assetIds: readonly string[];
}

export interface ReplacePackAssetsPlanOperation {
  readonly type: "replace_pack_assets";
  readonly packId: string;
  readonly channel: string;
  readonly beforeAssetIds: readonly string[];
  readonly afterAssetIds: readonly string[];
  readonly channelChanged: false;
}

export type PackSourcePlanOperation = CreatePackPlanOperation | ReplacePackAssetsPlanOperation;

export interface PackSourceApplicationPlan {
  readonly schemaVersion: 1;
  readonly planType: typeof PACK_SOURCE_APPLICATION_PLAN_TYPE;
  readonly applicationAuthorized: true;
  readonly applicationStatus: "planned_not_applied";
  readonly technicalValidation: {
    readonly ok: true;
    readonly promotionRequestVerified: true;
    readonly draftVerified: true;
    readonly proposalReconstructed: true;
    readonly proposalBytesVerified: true;
    readonly planningAuthorizationVerified: true;
    readonly registryFingerprintVerified: true;
    readonly channelConfigurationVerified: true;
    readonly staleStateDetected: false;
  };
  readonly inputs: {
    readonly promotionRequestSha256: string;
    readonly draftSha256: string;
    readonly packProposalSha256: string;
    readonly planningAuthorizationSha256: string;
  };
  readonly operation: PackSourcePlanOperation;
  readonly workspaceMetadata: PackSourceProposal["workspaceMetadata"];
  readonly sourceState: PackSourceProposal["sourceState"] & {
    readonly packsSha256After: string;
  };
  readonly simulatedResult: {
    readonly registryAssetCount: number;
    readonly registryFingerprint: string;
    readonly packCountBefore: number;
    readonly packCountAfter: number;
    readonly packMembershipCountBefore: number;
    readonly packMembershipCountAfter: number;
    readonly targetPackMembershipCountBefore: number;
    readonly targetPackMembershipCountAfter: number;
  };
  readonly sourceChangesApplied: false;
}

export interface PackSourceChangeReceipt {
  readonly schemaVersion: 1;
  readonly changeType: typeof PACK_SOURCE_CHANGE_TYPE;
  readonly generationStatus: "generated_not_applied";
  readonly technicalValidation: {
    readonly ok: true;
    readonly promotionRequestVerified: true;
    readonly draftVerified: true;
    readonly proposalReconstructed: true;
    readonly proposalBytesVerified: true;
    readonly planningAuthorizationVerified: true;
    readonly applicationPlanReconstructed: true;
    readonly applicationPlanBytesVerified: true;
    readonly sourceStateVerified: true;
    readonly futureStateVerified: true;
    readonly patchVerified: true;
    readonly staleStateDetected: false;
  };
  readonly inputs: {
    readonly promotionRequestSha256: string;
    readonly draftSha256: string;
    readonly packProposalSha256: string;
    readonly planningAuthorizationSha256: string;
    readonly applicationPlanSha256: string;
  };
  readonly operation: PackPromotionOperation;
  readonly pack: PackPromotionCanonicalPack;
  readonly workspaceMetadata: PackSourceProposal["workspaceMetadata"] & {
    readonly descriptionWrittenToCanonicalSource: false;
  };
  readonly sourceState: {
    readonly registry: { readonly path: "definitions/registry.json"; readonly sha256: string; readonly changed: false };
    readonly packs: { readonly path: "definitions/packs.json"; readonly beforeSha256: string; readonly afterSha256: string; readonly changed: true };
    readonly channels: { readonly path: "config/channels.json"; readonly sha256: string; readonly changed: false };
  };
  readonly simulatedResult: PackSourceApplicationPlan["simulatedResult"];
  readonly patch: {
    readonly format: "unified-diff";
    readonly sha256: string;
    readonly bytes: number;
    readonly changedPaths: readonly ["definitions/packs.json"];
  };
  readonly numericDiscordDestinationStored: false;
  readonly sourceChangesApplied: false;
}

export interface PackPromotionContext {
  readonly assets: readonly Asset[];
  readonly packs: readonly Pack[];
  readonly channels: Readonly<Record<string, unknown>>;
  readonly registryBytes: Buffer;
  readonly packsBytes: Buffer;
  readonly channelsBytes: Buffer;
  readonly registrySha256: string;
  readonly packsSha256: string;
  readonly channelsSha256: string;
  readonly registryFingerprint: string;
}

export interface PackPromotionSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type PackPromotionResult<T> = PackPromotionSuccess<T> | PackPromotionFailure;

function failure(reason: PackPromotionFailureReason, detail: string): PackPromotionFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function success<T>(value: T): PackPromotionSuccess<T> {
  return Object.freeze({ ok: true, value });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], label: string): PackPromotionFailure | null {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    return failure("invalid_promotion_request", `${label} fields must be exactly: ${wanted.join(", ")}`);
  }
  return null;
}

function validTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const datePart = match[1];
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59 || datePart === undefined) return false;
  const [yearText, monthText, dayText] = datePart.split("-");
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function validateText(value: unknown, field: keyof typeof PACK_PROMOTION_TEXT_LIMITS, optional = false, multiline = false): string | undefined | PackPromotionFailure {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") return failure("invalid_promotion_request", `${field} must be a string`);
  if (value.length === 0 || value.trim().length === 0 || value.trim() !== value) {
    return failure("invalid_promotion_request", `${field} must be normalized nonempty text`);
  }
  if ((multiline ? CONTROL_CHARACTER : SINGLE_LINE_CONTROL).test(value)) {
    return failure("invalid_promotion_request", `${field} contains forbidden control characters`);
  }
  if (value.length > PACK_PROMOTION_TEXT_LIMITS[field]) {
    return failure("invalid_promotion_request", `${field} exceeds maximum length ${PACK_PROMOTION_TEXT_LIMITS[field]}`);
  }
  return value;
}

function validatePackChannel(value: unknown, channels: Readonly<Record<string, unknown>>): string | PackPromotionFailure {
  if (value === undefined) return failure("pack_channel_required", "create_pack requires an explicit logical Pack channel");
  if (typeof value === "string" && NUMERIC_DISCORD_CHANNEL.test(value)) {
    return failure("numeric_channel_id_not_allowed", "Pack channel must be a logical channel key, not a numeric Discord destination");
  }
  const result = validateAssetRegistrationChannel(value, channels);
  if (result.ok) return result.channel;
  if (result.reason === "proposal_channel_required") return failure("pack_channel_required", result.detail);
  if (result.reason === "unknown_channel") return failure("pack_channel_not_configured", result.detail);
  return failure("pack_channel_invalid", result.detail);
}

export function validatePackDraftPromotionRequest(
  value: unknown,
  channels: Readonly<Record<string, unknown>>,
): PackPromotionResult<PackDraftPromotionRequest> {
  if (!isRecord(value)) return failure("invalid_promotion_request", "Promotion request must be a JSON object");
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "Promotion request schemaVersion must equal 1");
  if (value.operation !== "create_pack" && value.operation !== "replace_pack_assets") {
    return failure("operation_not_supported", "Promotion operation must be create_pack or replace_pack_assets");
  }
  if (value.operation === "replace_pack_assets" && Object.prototype.hasOwnProperty.call(value, "channel")) {
    return failure("pack_channel_change_not_supported", "replace_pack_assets must not contain a channel field");
  }
  if (value.operation === "create_pack" && !Object.prototype.hasOwnProperty.call(value, "channel")) {
    return failure("pack_channel_required", "create_pack requires an explicit logical Pack channel");
  }
  const expected = value.operation === "create_pack"
    ? ["schemaVersion", "requestType", "operation", "draftId", "expectedRevision", "channel", "curatorId", "decidedAt", "referenceId", ...(value.notes === undefined ? [] : ["notes"])]
    : ["schemaVersion", "requestType", "operation", "draftId", "expectedRevision", "curatorId", "decidedAt", "referenceId", ...(value.notes === undefined ? [] : ["notes"])] ;
  const fields = exactFields(value, expected, "Promotion request");
  if (fields !== null) return fields;
  if (value.requestType !== PACK_PROMOTION_REQUEST_TYPE) return failure("invalid_promotion_request", "Promotion request type is unsupported");
  if (!isValidPackDraftId(value.draftId)) return failure("invalid_promotion_request", "draftId must be a valid safe draft slug");
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
    return failure("invalid_promotion_request", "expectedRevision must be a positive safe integer");
  }
  const curatorId = validateText(value.curatorId, "curatorId"); if (typeof curatorId !== "string") return curatorId ?? failure("invalid_promotion_request", "curatorId is required");
  const decidedAt = validateText(value.decidedAt, "decidedAt"); if (typeof decidedAt !== "string") return decidedAt ?? failure("invalid_promotion_request", "decidedAt is required");
  if (!validTimestamp(decidedAt)) return failure("invalid_promotion_request", "decidedAt must be a valid timezone-qualified timestamp");
  const referenceId = validateText(value.referenceId, "referenceId"); if (typeof referenceId !== "string") return referenceId ?? failure("invalid_promotion_request", "referenceId is required");
  const notes = validateText(value.notes, "notes", true, true); if (notes !== undefined && typeof notes !== "string") return notes;
  if (value.operation === "create_pack") {
    const channel = validatePackChannel(value.channel, channels); if (typeof channel !== "string") return channel;
    return success(Object.freeze({ schemaVersion: 1, requestType: PACK_PROMOTION_REQUEST_TYPE, operation: "create_pack", draftId: value.draftId, expectedRevision: Number(value.expectedRevision), channel, curatorId, decidedAt, referenceId, ...(notes === undefined ? {} : { notes }) }));
  }
  return success(Object.freeze({ schemaVersion: 1, requestType: PACK_PROMOTION_REQUEST_TYPE, operation: "replace_pack_assets", draftId: value.draftId, expectedRevision: Number(value.expectedRevision), curatorId, decidedAt, referenceId, ...(notes === undefined ? {} : { notes }) }));
}

export function serializePackDraftPromotionRequest(request: PackDraftPromotionRequest): Buffer {
  return Buffer.from(`${JSON.stringify(request, null, 2)}\n`, "utf8");
}

function parseDraftBytes(bytes: Buffer, validAssetIds: ReadonlySet<string>): PackPromotionResult<PackDraft> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { return failure("invalid_pack_proposal", "Saved Pack draft is not valid JSON"); }
  try {
    const draft = parsePackDraft(value, validAssetIds);
    if (!bytes.equals(serializePackDraft(draft))) return failure("draft_hash_mismatch", "Saved Pack draft is not canonically serialized");
    return success(draft);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("duplicate") || message.includes("more than once")) return failure("duplicate_draft_asset", message);
    if (message.includes("not found") || message.includes("unknown") || message.includes("not present")) return failure("draft_asset_not_found", message);
    return failure("invalid_pack_proposal", message);
  }
}

function countMemberships(packs: readonly Pack[]): number {
  return packs.reduce((sum, pack) => sum + pack.assets.length, 0);
}

function freezeWorkspaceMetadata(description: string | undefined): PackSourceProposal["workspaceMetadata"] {
  return Object.freeze({
    ...(description === undefined ? {} : { description }),
    canonicalFields: Object.freeze(["id", "display", "channel", "assets"] as const),
    workspaceOnlyFields: Object.freeze(["description", "draftRevision", "curatorNotes"] as const),
  });
}

export function proposePackDraftPromotion(input: {
  readonly requestValue: unknown;
  readonly requestBytes: Buffer;
  readonly draftBytes: Buffer;
  readonly context: PackPromotionContext;
}): PackPromotionResult<PackSourceProposal> {
  const requestResult = validatePackDraftPromotionRequest(input.requestValue, input.context.channels);
  if (!requestResult.ok) return requestResult;
  const request = requestResult.value;
  if (!input.requestBytes.equals(serializePackDraftPromotionRequest(request))) {
    return failure("invalid_promotion_request", "Promotion request bytes are not canonical");
  }
  const draftResult = parseDraftBytes(input.draftBytes, new Set(input.context.assets.map((asset) => asset.id)));
  if (!draftResult.ok) return draftResult;
  const draft = draftResult.value;
  if (draft.id !== request.draftId) return failure("draft_hash_mismatch", "Promotion request draftId does not match the saved draft");
  if (draft.revision !== request.expectedRevision) return failure("draft_revision_conflict", `Expected draft revision ${request.expectedRevision} but found ${draft.revision}`);
  if (draft.assetIds.length === 0) return failure("invalid_pack_proposal", "Canonical Packs require at least one Asset");
  const existing = input.context.packs.find((pack) => pack.id === draft.id);
  let channel: string;
  if (request.operation === "create_pack") {
    if (existing !== undefined) return failure("pack_already_exists", `Pack ${draft.id} already exists`);
    channel = request.channel as string;
  } else {
    if (existing === undefined) return failure("pack_not_found", `Pack ${draft.id} does not exist`);
    channel = existing.channel;
  }
  const proposal: PackSourceProposal = Object.freeze({
    schemaVersion: 1,
    proposalType: PACK_SOURCE_PROPOSAL_TYPE,
    operation: request.operation,
    pack: Object.freeze({ id: draft.id, display: draft.displayName, channel, assetIds: Object.freeze([...draft.assetIds]) }),
    workspaceMetadata: freezeWorkspaceMetadata(draft.description),
    draft: Object.freeze({ id: draft.id, revision: draft.revision, sha256: sha256(input.draftBytes) }),
    promotionRequest: Object.freeze({ sha256: sha256(input.requestBytes), curatorId: request.curatorId, decidedAt: request.decidedAt, referenceId: request.referenceId, ...(request.notes === undefined ? {} : { notes: request.notes }) }),
    sourceState: Object.freeze({ registrySha256: input.context.registrySha256, packsSha256: input.context.packsSha256, channelsSha256: input.context.channelsSha256, registryFingerprint: input.context.registryFingerprint }),
    proposalStatus: "proposed_not_planned",
    sourceChangesApplied: false,
  });
  return success(proposal);
}

export function serializePackSourceProposal(proposal: PackSourceProposal): Buffer {
  return Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

export function validatePackSourceProposal(value: unknown): PackPromotionResult<PackSourceProposal> {
  if (!isRecord(value)) return failure("invalid_pack_proposal", "Pack proposal must be a JSON object");
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "Pack proposal schemaVersion must equal 1");
  const top = exactFields(value, ["schemaVersion", "proposalType", "operation", "pack", "workspaceMetadata", "draft", "promotionRequest", "sourceState", "proposalStatus", "sourceChangesApplied"], "Pack proposal");
  if (top !== null) return failure("invalid_pack_proposal", top.detail);
  if (value.proposalType !== PACK_SOURCE_PROPOSAL_TYPE || (value.operation !== "create_pack" && value.operation !== "replace_pack_assets") || value.proposalStatus !== "proposed_not_planned" || value.sourceChangesApplied !== false) {
    return failure("invalid_pack_proposal", "Pack proposal identity or state is invalid");
  }
  if (!isRecord(value.pack) || !isRecord(value.workspaceMetadata) || !isRecord(value.draft) || !isRecord(value.promotionRequest) || !isRecord(value.sourceState)) return failure("invalid_pack_proposal", "Pack proposal nested structures are invalid");
  const packFields = exactFields(value.pack, ["id", "display", "channel", "assetIds"], "Pack proposal pack"); if (packFields) return failure("invalid_pack_proposal", packFields.detail);
  if (!isValidPackDraftId(value.pack.id) || typeof value.pack.display !== "string" || value.pack.display.trim() !== value.pack.display || value.pack.display.length === 0 || typeof value.pack.channel !== "string" || !Array.isArray(value.pack.assetIds) || value.pack.assetIds.some((id) => typeof id !== "string")) return failure("invalid_pack_proposal", "Pack proposal canonical Pack fields are invalid");
  const unique = new Set(value.pack.assetIds as string[]); if (unique.size !== value.pack.assetIds.length) return failure("duplicate_draft_asset", "Pack proposal contains duplicate Asset membership");
  const metadataFields = exactFields(value.workspaceMetadata, [ ...(value.workspaceMetadata.description === undefined ? [] : ["description"]), "canonicalFields", "workspaceOnlyFields"], "Pack proposal workspaceMetadata"); if (metadataFields) return failure("invalid_pack_proposal", metadataFields.detail);
  if (value.workspaceMetadata.description !== undefined && typeof value.workspaceMetadata.description !== "string") return failure("invalid_pack_proposal", "workspaceMetadata.description must be a string");
  if (JSON.stringify(value.workspaceMetadata.canonicalFields) !== JSON.stringify(["id", "display", "channel", "assets"]) || JSON.stringify(value.workspaceMetadata.workspaceOnlyFields) !== JSON.stringify(["description", "draftRevision", "curatorNotes"])) return failure("invalid_pack_proposal", "Workspace metadata field classification is invalid");
  const draftFields = exactFields(value.draft, ["id", "revision", "sha256"], "Pack proposal draft"); if (draftFields) return failure("invalid_pack_proposal", draftFields.detail);
  if (value.draft.id !== value.pack.id || !Number.isSafeInteger(value.draft.revision) || Number(value.draft.revision) < 1 || typeof value.draft.sha256 !== "string" || !LOWER_SHA256.test(value.draft.sha256)) return failure("invalid_pack_proposal", "Pack proposal draft binding is invalid");
  const prExpected = ["sha256", "curatorId", "decidedAt", "referenceId", ...(value.promotionRequest.notes === undefined ? [] : ["notes"])]; const prFields = exactFields(value.promotionRequest, prExpected, "Pack proposal promotionRequest"); if (prFields) return failure("invalid_pack_proposal", prFields.detail);
  if (typeof value.promotionRequest.sha256 !== "string" || !LOWER_SHA256.test(value.promotionRequest.sha256) || typeof value.promotionRequest.curatorId !== "string" || typeof value.promotionRequest.decidedAt !== "string" || !validTimestamp(value.promotionRequest.decidedAt) || typeof value.promotionRequest.referenceId !== "string" || (value.promotionRequest.notes !== undefined && typeof value.promotionRequest.notes !== "string")) return failure("invalid_pack_proposal", "Pack proposal promotion-request binding is invalid");
  const sourceFields = exactFields(value.sourceState, ["registrySha256", "packsSha256", "channelsSha256", "registryFingerprint"], "Pack proposal sourceState"); if (sourceFields) return failure("invalid_pack_proposal", sourceFields.detail);
  if ([value.sourceState.registrySha256, value.sourceState.packsSha256, value.sourceState.channelsSha256, value.sourceState.registryFingerprint].some((digest) => typeof digest !== "string" || !LOWER_SHA256.test(digest))) return failure("invalid_pack_proposal", "Pack proposal source identities are invalid");
  return success(Object.freeze({
    schemaVersion: 1, proposalType: PACK_SOURCE_PROPOSAL_TYPE, operation: value.operation,
    pack: Object.freeze({ id: value.pack.id as string, display: value.pack.display as string, channel: value.pack.channel as string, assetIds: Object.freeze([...(value.pack.assetIds as string[])]) }),
    workspaceMetadata: freezeWorkspaceMetadata(value.workspaceMetadata.description as string | undefined),
    draft: Object.freeze({ id: value.draft.id as string, revision: Number(value.draft.revision), sha256: value.draft.sha256 as string }),
    promotionRequest: Object.freeze({ sha256: value.promotionRequest.sha256 as string, curatorId: value.promotionRequest.curatorId as string, decidedAt: value.promotionRequest.decidedAt as string, referenceId: value.promotionRequest.referenceId as string, ...(value.promotionRequest.notes === undefined ? {} : { notes: value.promotionRequest.notes as string }) }),
    sourceState: Object.freeze({ registrySha256: value.sourceState.registrySha256 as string, packsSha256: value.sourceState.packsSha256 as string, channelsSha256: value.sourceState.channelsSha256 as string, registryFingerprint: value.sourceState.registryFingerprint as string }),
    proposalStatus: "proposed_not_planned", sourceChangesApplied: false,
  }));
}

function validateAuthorizationText(value: unknown, field: keyof typeof PACK_PROMOTION_TEXT_LIMITS, optional = false, multiline = false): string | undefined | PackPromotionFailure {
  const result = validateText(value, field, optional, multiline);
  if (result !== undefined && typeof result !== "string") return failure("invalid_planning_authorization", result.detail);
  return result;
}

export function validatePackSourcePlanningAuthorization(value: unknown): PackPromotionResult<PackSourcePlanningAuthorization> {
  if (!isRecord(value)) return failure("invalid_planning_authorization", "Planning authorization must be a JSON object");
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "Planning authorization schemaVersion must equal 1");
  const expected = ["schemaVersion", "decision", "packProposalSha256", "draftSha256", "promotionRequestSha256", "curatorId", "decidedAt", "referenceId", ...(value.notes === undefined ? [] : ["notes"])];
  const fields = exactFields(value, expected, "Planning authorization"); if (fields) return failure("invalid_planning_authorization", fields.detail);
  if (value.decision !== "approved" && value.decision !== "rejected") return failure("invalid_planning_authorization", "Planning authorization decision must be approved or rejected");
  for (const field of ["packProposalSha256", "draftSha256", "promotionRequestSha256"] as const) if (typeof value[field] !== "string" || !LOWER_SHA256.test(value[field] as string)) return failure("invalid_planning_authorization", `${field} must be a lowercase SHA-256 digest`);
  const curatorId = validateAuthorizationText(value.curatorId, "curatorId"); if (typeof curatorId !== "string") return curatorId ?? failure("invalid_planning_authorization", "curatorId is required");
  const decidedAt = validateAuthorizationText(value.decidedAt, "decidedAt"); if (typeof decidedAt !== "string") return decidedAt ?? failure("invalid_planning_authorization", "decidedAt is required");
  if (!validTimestamp(decidedAt)) return failure("invalid_planning_authorization", "decidedAt must be a valid timezone-qualified timestamp");
  const referenceId = validateAuthorizationText(value.referenceId, "referenceId"); if (typeof referenceId !== "string") return referenceId ?? failure("invalid_planning_authorization", "referenceId is required");
  const notes = validateAuthorizationText(value.notes, "notes", true, true); if (notes !== undefined && typeof notes !== "string") return notes;
  return success(Object.freeze({ schemaVersion: 1, decision: value.decision, packProposalSha256: value.packProposalSha256 as string, draftSha256: value.draftSha256 as string, promotionRequestSha256: value.promotionRequestSha256 as string, curatorId, decidedAt, referenceId, ...(notes === undefined ? {} : { notes }) }));
}

export function serializePackSourcePlanningAuthorization(value: PackSourcePlanningAuthorization): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function transformCanonicalPacksSource(
  packsBytes: Buffer,
  operation: PackSourcePlanOperation,
  validAssetIds: ReadonlySet<string>,
  channelNames: ReadonlySet<string>,
): PackPromotionResult<{ readonly bytes: Buffer; readonly packs: readonly Pack[] }> {
  const text = packsBytes.toString("utf8");
  if (text.includes("\r")) return failure("source_shape_unsupported", "Pack source must use LF line endings");
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; } catch { return failure("source_reload_failed", "Pack source is not valid JSON"); }
  if (!Array.isArray(raw)) return failure("source_shape_unsupported", "Pack source must be a JSON array");
  let nextText: string;
  if (operation.type === "create_pack") {
    if (raw.some((entry) => isRecord(entry) && entry.id === operation.packId)) return failure("pack_already_exists", `Pack ${operation.packId} already exists`);
    const closing = /\n\](?:\n)?$/u.exec(text);
    if (closing === null) return failure("source_shape_unsupported", "Pack source closing array shape is unsupported");
    const object = [
      "  {",
      `    \"id\": ${JSON.stringify(operation.packId)},`,
      `    \"display\": ${JSON.stringify(operation.display)},`,
      `    \"channel\": ${JSON.stringify(operation.channel)},`,
      `    \"assets\": [${operation.assetIds.map((assetId) => JSON.stringify(assetId)).join(", ")}]`,
      "  }",
    ].join("\n");
    const prefix = text.slice(0, closing.index);
    nextText = `${prefix.trimEnd()},\n${object}\n]${text.endsWith("\n") ? "\n" : ""}`;
  } else {
    const index = raw.findIndex((entry) => isRecord(entry) && entry.id === operation.packId);
    if (index < 0) return failure("pack_not_found", `Pack ${operation.packId} does not exist`);
    const existing = raw[index];
    if (!isRecord(existing) || existing.channel !== operation.channel) return failure("pack_channel_change_not_supported", "replace_pack_assets must preserve the existing Pack channel");
    if (JSON.stringify(existing.assets) !== JSON.stringify(operation.beforeAssetIds)) return failure("stale_pack_membership", "Target Pack membership changed");
    const idNeedle = `\"id\": ${JSON.stringify(operation.packId)}`;
    const lines = text.split("\n");
    const matches: number[] = [];
    for (let i = 0; i < lines.length; i += 1) if (lines[i]?.includes(idNeedle)) matches.push(i);
    if (matches.length !== 1) return failure("source_shape_unsupported", "Target Pack source entry is ambiguous");
    const idLine = matches[0] as number;
    let assetsLine = -1;
    for (let i = idLine; i < Math.min(lines.length, idLine + 8); i += 1) {
      if (/^\s{4}"assets": \[.*\]$/u.test(lines[i] ?? "")) { assetsLine = i; break; }
    }
    if (assetsLine < 0) return failure("source_shape_unsupported", "Target Pack assets line shape is unsupported");
    lines[assetsLine] = `    \"assets\": [${operation.afterAssetIds.map((assetId) => JSON.stringify(assetId)).join(", ")}]`;
    nextText = lines.join("\n");
  }
  const bytes = Buffer.from(nextText, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(nextText) as unknown; } catch { return failure("source_serialization_failed", "Future Pack source could not be parsed"); }
  let packs: readonly Pack[];
  try { packs = buildPacks(parsed, validAssetIds, channelNames); }
  catch (error) { return failure("source_reload_failed", error instanceof Error ? error.message : String(error)); }
  return success(Object.freeze({ bytes, packs: Object.freeze([...packs]) }));
}

function proposalMatches(actual: Buffer, proposal: PackSourceProposal): boolean {
  return actual.equals(serializePackSourceProposal(proposal));
}

export function planPackSourceChange(input: {
  readonly requestValue: unknown;
  readonly requestBytes: Buffer;
  readonly draftBytes: Buffer;
  readonly proposalValue: unknown;
  readonly proposalBytes: Buffer;
  readonly authorizationValue: unknown;
  readonly authorizationBytes: Buffer;
  readonly context: PackPromotionContext;
}): PackPromotionResult<PackSourceApplicationPlan> {
  const proposalValidation = validatePackSourceProposal(input.proposalValue); if (!proposalValidation.ok) return proposalValidation;
  const suppliedProposal = proposalValidation.value;
  if (suppliedProposal.sourceState.registrySha256 !== input.context.registrySha256 || suppliedProposal.sourceState.registryFingerprint !== input.context.registryFingerprint) return failure("stale_registry_state", "Canonical Registry state changed after proposal creation");
  if (suppliedProposal.sourceState.packsSha256 !== input.context.packsSha256) return failure("stale_pack_state", "Canonical Pack source changed after proposal creation");
  if (suppliedProposal.sourceState.channelsSha256 !== input.context.channelsSha256) return failure("stale_pack_state", "Canonical channel configuration changed after proposal creation");
  const reconstructed = proposePackDraftPromotion({ requestValue: input.requestValue, requestBytes: input.requestBytes, draftBytes: input.draftBytes, context: input.context }); if (!reconstructed.ok) return reconstructed;
  if (!proposalMatches(input.proposalBytes, reconstructed.value) || !input.proposalBytes.equals(serializePackSourceProposal(suppliedProposal))) return failure("proposal_reconstruction_mismatch", "Pack proposal bytes do not match canonical reconstruction");
  const authorizationResult = validatePackSourcePlanningAuthorization(input.authorizationValue); if (!authorizationResult.ok) return authorizationResult;
  const authorization = authorizationResult.value;
  if (!input.authorizationBytes.equals(serializePackSourcePlanningAuthorization(authorization))) return failure("invalid_planning_authorization", "Planning authorization bytes are not canonical");
  if (authorization.decision !== "approved") return failure("planning_authorization_rejected", "Planning authorization was rejected");
  if (authorization.packProposalSha256 !== sha256(input.proposalBytes)) return failure("proposal_hash_mismatch", "Planning authorization does not bind the supplied proposal");
  if (authorization.draftSha256 !== sha256(input.draftBytes)) return failure("draft_hash_mismatch", "Planning authorization does not bind the saved draft");
  if (authorization.promotionRequestSha256 !== sha256(input.requestBytes)) return failure("planning_authorization_hash_mismatch", "Planning authorization does not bind the promotion request");
  const proposal = reconstructed.value;
  if (proposal.sourceState.registrySha256 !== input.context.registrySha256 || proposal.sourceState.packsSha256 !== input.context.packsSha256 || proposal.sourceState.channelsSha256 !== input.context.channelsSha256) return failure("stale_pack_state", "Canonical source bytes changed after proposal creation");
  if (proposal.sourceState.registryFingerprint !== input.context.registryFingerprint) return failure("stale_registry_fingerprint", "Registry fingerprint changed after proposal creation");
  const existing = input.context.packs.find((pack) => pack.id === proposal.pack.id);
  let operation: PackSourcePlanOperation;
  if (proposal.operation === "create_pack") {
    operation = Object.freeze({ type: "create_pack", packId: proposal.pack.id, display: proposal.pack.display, channel: proposal.pack.channel, assetIds: Object.freeze([...proposal.pack.assetIds]) });
  } else {
    if (existing === undefined) return failure("pack_not_found", `Pack ${proposal.pack.id} does not exist`);
    if (existing.channel !== proposal.pack.channel) return failure("pack_channel_change_not_supported", "replace_pack_assets channel does not match the canonical Pack channel");
    operation = Object.freeze({ type: "replace_pack_assets", packId: proposal.pack.id, channel: existing.channel, beforeAssetIds: Object.freeze([...existing.assets]), afterAssetIds: Object.freeze([...proposal.pack.assetIds]), channelChanged: false });
  }
  const source = transformCanonicalPacksSource(input.context.packsBytes, operation, new Set(input.context.assets.map((asset) => asset.id)), new Set(Object.keys(input.context.channels)));
  if (!source.ok) return source;
  const afterPacks = source.value.packs;
  const beforeTarget = existing?.assets.length ?? 0;
  const afterTarget = operation.type === "create_pack" ? operation.assetIds.length : operation.afterAssetIds.length;
  const plan: PackSourceApplicationPlan = Object.freeze({
    schemaVersion: 1,
    planType: PACK_SOURCE_APPLICATION_PLAN_TYPE,
    applicationAuthorized: true,
    applicationStatus: "planned_not_applied",
    technicalValidation: Object.freeze({ ok: true, promotionRequestVerified: true, draftVerified: true, proposalReconstructed: true, proposalBytesVerified: true, planningAuthorizationVerified: true, registryFingerprintVerified: true, channelConfigurationVerified: true, staleStateDetected: false }),
    inputs: Object.freeze({ promotionRequestSha256: sha256(input.requestBytes), draftSha256: sha256(input.draftBytes), packProposalSha256: sha256(input.proposalBytes), planningAuthorizationSha256: sha256(input.authorizationBytes) }),
    operation,
    workspaceMetadata: proposal.workspaceMetadata,
    sourceState: Object.freeze({ ...proposal.sourceState, packsSha256After: sha256(source.value.bytes) }),
    simulatedResult: Object.freeze({ registryAssetCount: input.context.assets.length, registryFingerprint: input.context.registryFingerprint, packCountBefore: input.context.packs.length, packCountAfter: afterPacks.length, packMembershipCountBefore: countMemberships(input.context.packs), packMembershipCountAfter: countMemberships(afterPacks), targetPackMembershipCountBefore: beforeTarget, targetPackMembershipCountAfter: afterTarget }),
    sourceChangesApplied: false,
  });
  return success(plan);
}

export function serializePackSourceApplicationPlan(plan: PackSourceApplicationPlan): Buffer {
  return Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

export function validatePackSourceApplicationPlan(value: unknown): PackPromotionResult<PackSourceApplicationPlan> {
  if (!isRecord(value)) return failure("invalid_pack_application_plan", "Pack application plan must be a JSON object");
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "Pack application plan schemaVersion must equal 1");
  const top = exactFields(value, ["schemaVersion", "planType", "applicationAuthorized", "applicationStatus", "technicalValidation", "inputs", "operation", "workspaceMetadata", "sourceState", "simulatedResult", "sourceChangesApplied"], "Pack application plan");
  if (top !== null) return failure("invalid_pack_application_plan", top.detail);
  if (value.planType !== PACK_SOURCE_APPLICATION_PLAN_TYPE || value.applicationAuthorized !== true || value.applicationStatus !== "planned_not_applied" || value.sourceChangesApplied !== false) return failure("invalid_pack_application_plan", "Pack application plan identity or state is invalid");
  if (!isRecord(value.technicalValidation) || !isRecord(value.inputs) || !isRecord(value.operation) || !isRecord(value.workspaceMetadata) || !isRecord(value.sourceState) || !isRecord(value.simulatedResult)) return failure("invalid_pack_application_plan", "Pack application plan nested structures are invalid");
  const technicalFields = exactFields(value.technicalValidation, ["ok", "promotionRequestVerified", "draftVerified", "proposalReconstructed", "proposalBytesVerified", "planningAuthorizationVerified", "registryFingerprintVerified", "channelConfigurationVerified", "staleStateDetected"], "Pack application plan technicalValidation");
  if (technicalFields !== null) return failure("invalid_pack_application_plan", technicalFields.detail);
  const expectedTechnical: Readonly<Record<string, boolean>> = Object.freeze({ ok: true, promotionRequestVerified: true, draftVerified: true, proposalReconstructed: true, proposalBytesVerified: true, planningAuthorizationVerified: true, registryFingerprintVerified: true, channelConfigurationVerified: true, staleStateDetected: false });
  for (const [key, expected] of Object.entries(expectedTechnical)) if (value.technicalValidation[key] !== expected) return failure("invalid_pack_application_plan", `technicalValidation.${key} is invalid`);
  const inputFields = exactFields(value.inputs, ["promotionRequestSha256", "draftSha256", "packProposalSha256", "planningAuthorizationSha256"], "Pack application plan inputs");
  if (inputFields !== null) return failure("invalid_pack_application_plan", inputFields.detail);
  for (const key of ["promotionRequestSha256", "draftSha256", "packProposalSha256", "planningAuthorizationSha256"] as const) if (typeof value.inputs[key] !== "string" || !LOWER_SHA256.test(value.inputs[key] as string)) return failure("invalid_pack_application_plan", `${key} must be a lowercase SHA-256 digest`);
  let operation: PackSourcePlanOperation;
  if (value.operation.type === "create_pack") {
    const operationFields = exactFields(value.operation, ["type", "packId", "display", "channel", "assetIds"], "create_pack operation");
    if (operationFields !== null) return failure("invalid_pack_application_plan", operationFields.detail);
    if (!isValidPackDraftId(value.operation.packId) || typeof value.operation.display !== "string" || value.operation.display.trim() !== value.operation.display || value.operation.display.length === 0 || typeof value.operation.channel !== "string" || !Array.isArray(value.operation.assetIds) || value.operation.assetIds.length === 0 || value.operation.assetIds.some((assetId) => typeof assetId !== "string")) return failure("invalid_pack_application_plan", "create_pack operation is invalid");
    if (new Set(value.operation.assetIds as string[]).size !== value.operation.assetIds.length) return failure("duplicate_draft_asset", "create_pack operation contains duplicate Asset membership");
    operation = Object.freeze({ type: "create_pack", packId: value.operation.packId as string, display: value.operation.display as string, channel: value.operation.channel as string, assetIds: Object.freeze([...(value.operation.assetIds as string[])]) });
  } else if (value.operation.type === "replace_pack_assets") {
    const operationFields = exactFields(value.operation, ["type", "packId", "channel", "beforeAssetIds", "afterAssetIds", "channelChanged"], "replace_pack_assets operation");
    if (operationFields !== null) return failure("invalid_pack_application_plan", operationFields.detail);
    if (!isValidPackDraftId(value.operation.packId) || typeof value.operation.channel !== "string" || !Array.isArray(value.operation.beforeAssetIds) || !Array.isArray(value.operation.afterAssetIds) || value.operation.beforeAssetIds.some((assetId) => typeof assetId !== "string") || value.operation.afterAssetIds.some((assetId) => typeof assetId !== "string") || value.operation.channelChanged !== false) return failure("invalid_pack_application_plan", "replace_pack_assets operation is invalid");
    if (new Set(value.operation.afterAssetIds as string[]).size !== value.operation.afterAssetIds.length) return failure("duplicate_draft_asset", "replace_pack_assets operation contains duplicate Asset membership");
    operation = Object.freeze({ type: "replace_pack_assets", packId: value.operation.packId as string, channel: value.operation.channel as string, beforeAssetIds: Object.freeze([...(value.operation.beforeAssetIds as string[])]), afterAssetIds: Object.freeze([...(value.operation.afterAssetIds as string[])]), channelChanged: false });
  } else return failure("operation_not_supported", "Pack application operation is unsupported");
  const metadataExpected = [ ...(value.workspaceMetadata.description === undefined ? [] : ["description"]), "canonicalFields", "workspaceOnlyFields"];
  const metadataFields = exactFields(value.workspaceMetadata, metadataExpected, "Pack application plan workspaceMetadata");
  if (metadataFields !== null) return failure("invalid_pack_application_plan", metadataFields.detail);
  if (value.workspaceMetadata.description !== undefined && typeof value.workspaceMetadata.description !== "string") return failure("invalid_pack_application_plan", "workspaceMetadata.description must be a string");
  if (JSON.stringify(value.workspaceMetadata.canonicalFields) !== JSON.stringify(["id", "display", "channel", "assets"]) || JSON.stringify(value.workspaceMetadata.workspaceOnlyFields) !== JSON.stringify(["description", "draftRevision", "curatorNotes"])) return failure("invalid_pack_application_plan", "Workspace metadata field classification is invalid");
  const sourceFields = exactFields(value.sourceState, ["registrySha256", "packsSha256", "channelsSha256", "registryFingerprint", "packsSha256After"], "Pack application plan sourceState");
  if (sourceFields !== null) return failure("invalid_pack_application_plan", sourceFields.detail);
  for (const key of ["registrySha256", "packsSha256", "channelsSha256", "registryFingerprint", "packsSha256After"] as const) if (typeof value.sourceState[key] !== "string" || !LOWER_SHA256.test(value.sourceState[key] as string)) return failure("invalid_pack_application_plan", `${key} must be a lowercase SHA-256 digest`);
  const simulatedFields = exactFields(value.simulatedResult, ["registryAssetCount", "registryFingerprint", "packCountBefore", "packCountAfter", "packMembershipCountBefore", "packMembershipCountAfter", "targetPackMembershipCountBefore", "targetPackMembershipCountAfter"], "Pack application plan simulatedResult");
  if (simulatedFields !== null) return failure("invalid_pack_application_plan", simulatedFields.detail);
  for (const key of ["registryAssetCount", "packCountBefore", "packCountAfter", "packMembershipCountBefore", "packMembershipCountAfter", "targetPackMembershipCountBefore", "targetPackMembershipCountAfter"] as const) if (!Number.isSafeInteger(value.simulatedResult[key]) || Number(value.simulatedResult[key]) < 0) return failure("invalid_pack_application_plan", `${key} must be a nonnegative safe integer`);
  if (typeof value.simulatedResult.registryFingerprint !== "string" || !LOWER_SHA256.test(value.simulatedResult.registryFingerprint)) return failure("invalid_pack_application_plan", "simulatedResult.registryFingerprint must be a lowercase SHA-256 digest");
  const normalized: PackSourceApplicationPlan = Object.freeze({
    schemaVersion: 1,
    planType: PACK_SOURCE_APPLICATION_PLAN_TYPE,
    applicationAuthorized: true,
    applicationStatus: "planned_not_applied",
    technicalValidation: Object.freeze({ ...expectedTechnical }) as PackSourceApplicationPlan["technicalValidation"],
    inputs: Object.freeze({ promotionRequestSha256: value.inputs.promotionRequestSha256 as string, draftSha256: value.inputs.draftSha256 as string, packProposalSha256: value.inputs.packProposalSha256 as string, planningAuthorizationSha256: value.inputs.planningAuthorizationSha256 as string }),
    operation,
    workspaceMetadata: freezeWorkspaceMetadata(value.workspaceMetadata.description as string | undefined),
    sourceState: Object.freeze({ registrySha256: value.sourceState.registrySha256 as string, packsSha256: value.sourceState.packsSha256 as string, channelsSha256: value.sourceState.channelsSha256 as string, registryFingerprint: value.sourceState.registryFingerprint as string, packsSha256After: value.sourceState.packsSha256After as string }),
    simulatedResult: Object.freeze({ registryAssetCount: Number(value.simulatedResult.registryAssetCount), registryFingerprint: value.simulatedResult.registryFingerprint as string, packCountBefore: Number(value.simulatedResult.packCountBefore), packCountAfter: Number(value.simulatedResult.packCountAfter), packMembershipCountBefore: Number(value.simulatedResult.packMembershipCountBefore), packMembershipCountAfter: Number(value.simulatedResult.packMembershipCountAfter), targetPackMembershipCountBefore: Number(value.simulatedResult.targetPackMembershipCountBefore), targetPackMembershipCountAfter: Number(value.simulatedResult.targetPackMembershipCountAfter) }),
    sourceChangesApplied: false,
  });
  return success(normalized);
}

interface DiffLine { readonly text: string; readonly hadNewline: boolean }
interface DiffOp { readonly kind: "equal" | "delete" | "insert"; readonly line: DiffLine }
function splitLines(bytes: Buffer): DiffLine[] {
  const text = bytes.toString("utf8"); const parts = text.split("\n"); const result: DiffLine[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index === parts.length - 1 && parts[index] === "") break;
    result.push({ text: parts[index] ?? "", hadNewline: index < parts.length - 1 });
  }
  return result;
}
function lineDiff(before: DiffLine[], after: DiffLine[]): DiffOp[] {
  const table = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) for (let j = after.length - 1; j >= 0; j -= 1) table[i]![j] = before[i]!.text === after[j]!.text && before[i]!.hadNewline === after[j]!.hadNewline ? 1 + table[i + 1]![j + 1]! : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const ops: DiffOp[] = []; let i = 0; let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i]!.text === after[j]!.text && before[i]!.hadNewline === after[j]!.hadNewline) { ops.push({ kind: "equal", line: before[i]! }); i += 1; j += 1; }
    else if (j < after.length && (i >= before.length || table[i]![j + 1]! >= table[i + 1]![j]!)) { ops.push({ kind: "insert", line: after[j]! }); j += 1; }
    else { ops.push({ kind: "delete", line: before[i]! }); i += 1; }
  }
  return ops;
}
export function createPackUnifiedPatch(before: Buffer, after: Buffer): PackPromotionResult<Buffer> {
  if (before.equals(after)) return failure("patch_generation_failed", "Future Pack source is unchanged");
  const ops = lineDiff(splitLines(before), splitLines(after));
  const changed = ops.map((op, index) => op.kind === "equal" ? -1 : index).filter((index) => index >= 0);
  const start = Math.max(0, Math.min(...changed) - 3); const end = Math.min(ops.length, Math.max(...changed) + 4);
  let beforeLine = 1; let afterLine = 1;
  for (let index = 0; index < start; index += 1) { const op = ops[index]!; if (op.kind !== "insert") beforeLine += 1; if (op.kind !== "delete") afterLine += 1; }
  const hunk = ops.slice(start, end); const beforeCount = hunk.filter((op) => op.kind !== "insert").length; const afterCount = hunk.filter((op) => op.kind !== "delete").length;
  const lines = ["diff --git a/definitions/packs.json b/definitions/packs.json", "--- a/definitions/packs.json", "+++ b/definitions/packs.json", `@@ -${beforeLine},${beforeCount} +${afterLine},${afterCount} @@`];
  for (const op of hunk) {
    lines.push(`${op.kind === "equal" ? " " : op.kind === "delete" ? "-" : "+"}${op.line.text}`);
    if (!op.line.hadNewline) lines.push("\\ No newline at end of file");
  }
  return success(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
}

export function generatePackSourceChange(input: {
  readonly requestValue: unknown;
  readonly requestBytes: Buffer;
  readonly draftBytes: Buffer;
  readonly proposalValue: unknown;
  readonly proposalBytes: Buffer;
  readonly authorizationValue: unknown;
  readonly authorizationBytes: Buffer;
  readonly planValue: unknown;
  readonly planBytes: Buffer;
  readonly context: PackPromotionContext;
}): PackPromotionResult<{ readonly patch: Buffer; readonly receipt: PackSourceChangeReceipt; readonly packsAfter: Buffer }> {
  const suppliedPlan = validatePackSourceApplicationPlan(input.planValue); if (!suppliedPlan.ok) return suppliedPlan;
  const planned = planPackSourceChange({ requestValue: input.requestValue, requestBytes: input.requestBytes, draftBytes: input.draftBytes, proposalValue: input.proposalValue, proposalBytes: input.proposalBytes, authorizationValue: input.authorizationValue, authorizationBytes: input.authorizationBytes, context: input.context }); if (!planned.ok) return planned;
  const canonicalPlanBytes = serializePackSourceApplicationPlan(planned.value);
  if (!input.planBytes.equals(canonicalPlanBytes)) return failure("plan_reconstruction_mismatch", "Pack application plan bytes do not match canonical reconstruction");
  const source = transformCanonicalPacksSource(input.context.packsBytes, planned.value.operation, new Set(input.context.assets.map((asset) => asset.id)), new Set(Object.keys(input.context.channels))); if (!source.ok) return source;
  if (sha256(source.value.bytes) !== planned.value.sourceState.packsSha256After) return failure("source_result_mismatch", "Future Pack source hash does not match the plan");
  const patchResult = createPackUnifiedPatch(input.context.packsBytes, source.value.bytes); if (!patchResult.ok) return patchResult;
  const proposalResult = validatePackSourceProposal(input.proposalValue); if (!proposalResult.ok) return proposalResult;
  const proposal = proposalResult.value;
  const receipt: PackSourceChangeReceipt = Object.freeze({
    schemaVersion: 1,
    changeType: PACK_SOURCE_CHANGE_TYPE,
    generationStatus: "generated_not_applied",
    technicalValidation: Object.freeze({ ok: true, promotionRequestVerified: true, draftVerified: true, proposalReconstructed: true, proposalBytesVerified: true, planningAuthorizationVerified: true, applicationPlanReconstructed: true, applicationPlanBytesVerified: true, sourceStateVerified: true, futureStateVerified: true, patchVerified: true, staleStateDetected: false }),
    inputs: Object.freeze({ promotionRequestSha256: sha256(input.requestBytes), draftSha256: sha256(input.draftBytes), packProposalSha256: sha256(input.proposalBytes), planningAuthorizationSha256: sha256(input.authorizationBytes), applicationPlanSha256: sha256(input.planBytes) }),
    operation: proposal.operation,
    pack: proposal.pack,
    workspaceMetadata: Object.freeze({ ...proposal.workspaceMetadata, descriptionWrittenToCanonicalSource: false }),
    sourceState: Object.freeze({ registry: Object.freeze({ path: "definitions/registry.json", sha256: input.context.registrySha256, changed: false }), packs: Object.freeze({ path: "definitions/packs.json", beforeSha256: input.context.packsSha256, afterSha256: sha256(source.value.bytes), changed: true }), channels: Object.freeze({ path: "config/channels.json", sha256: input.context.channelsSha256, changed: false }) }),
    simulatedResult: planned.value.simulatedResult,
    patch: Object.freeze({ format: "unified-diff", sha256: sha256(patchResult.value), bytes: patchResult.value.length, changedPaths: Object.freeze(["definitions/packs.json"] as const) }),
    numericDiscordDestinationStored: false,
    sourceChangesApplied: false,
  });
  return success(Object.freeze({ patch: patchResult.value, receipt, packsAfter: source.value.bytes }));
}

export function serializePackSourceChangeReceipt(receipt: PackSourceChangeReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export function validatePackSourceChangeReceipt(value: unknown): PackPromotionResult<PackSourceChangeReceipt> {
  if (!isRecord(value)) return failure("invalid_pack_source_change_receipt", "Pack source-change receipt must be a JSON object");
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "Pack source-change receipt schemaVersion must equal 1");
  const top = exactFields(value, ["schemaVersion", "changeType", "generationStatus", "technicalValidation", "inputs", "operation", "pack", "workspaceMetadata", "sourceState", "simulatedResult", "patch", "numericDiscordDestinationStored", "sourceChangesApplied"], "Pack source-change receipt");
  if (top !== null) return failure("invalid_pack_source_change_receipt", top.detail);
  if (value.changeType !== PACK_SOURCE_CHANGE_TYPE || value.generationStatus !== "generated_not_applied" || value.numericDiscordDestinationStored !== false || value.sourceChangesApplied !== false || (value.operation !== "create_pack" && value.operation !== "replace_pack_assets")) return failure("invalid_pack_source_change_receipt", "Pack source-change receipt identity or state is invalid");
  if (!isRecord(value.technicalValidation) || !isRecord(value.inputs) || !isRecord(value.pack) || !isRecord(value.workspaceMetadata) || !isRecord(value.sourceState) || !isRecord(value.simulatedResult) || !isRecord(value.patch)) return failure("invalid_pack_source_change_receipt", "Pack source-change receipt nested structures are invalid");
  const technicalExpected = ["ok", "promotionRequestVerified", "draftVerified", "proposalReconstructed", "proposalBytesVerified", "planningAuthorizationVerified", "applicationPlanReconstructed", "applicationPlanBytesVerified", "sourceStateVerified", "futureStateVerified", "patchVerified", "staleStateDetected"];
  const technicalFields = exactFields(value.technicalValidation, technicalExpected, "Pack source-change receipt technicalValidation"); if (technicalFields !== null) return failure("invalid_pack_source_change_receipt", technicalFields.detail);
  for (const key of technicalExpected) if (value.technicalValidation[key] !== (key === "staleStateDetected" ? false : true)) return failure("invalid_pack_source_change_receipt", `technicalValidation.${key} is invalid`);
  const inputKeys = ["promotionRequestSha256", "draftSha256", "packProposalSha256", "planningAuthorizationSha256", "applicationPlanSha256"] as const;
  const inputFields = exactFields(value.inputs, inputKeys, "Pack source-change receipt inputs"); if (inputFields !== null) return failure("invalid_pack_source_change_receipt", inputFields.detail);
  for (const key of inputKeys) if (typeof value.inputs[key] !== "string" || !LOWER_SHA256.test(value.inputs[key] as string)) return failure("invalid_pack_source_change_receipt", `${key} must be a lowercase SHA-256 digest`);
  const packFields = exactFields(value.pack, ["id", "display", "channel", "assetIds"], "Pack source-change receipt pack"); if (packFields !== null) return failure("invalid_pack_source_change_receipt", packFields.detail);
  if (!isValidPackDraftId(value.pack.id) || typeof value.pack.display !== "string" || typeof value.pack.channel !== "string" || !Array.isArray(value.pack.assetIds) || value.pack.assetIds.some((assetId) => typeof assetId !== "string")) return failure("invalid_pack_source_change_receipt", "Pack source-change receipt Pack identity is invalid");
  const metadataExpected = [ ...(value.workspaceMetadata.description === undefined ? [] : ["description"]), "canonicalFields", "workspaceOnlyFields", "descriptionWrittenToCanonicalSource"];
  const metadataFields = exactFields(value.workspaceMetadata, metadataExpected, "Pack source-change receipt workspaceMetadata"); if (metadataFields !== null) return failure("invalid_pack_source_change_receipt", metadataFields.detail);
  if (value.workspaceMetadata.descriptionWrittenToCanonicalSource !== false || (value.workspaceMetadata.description !== undefined && typeof value.workspaceMetadata.description !== "string") || JSON.stringify(value.workspaceMetadata.canonicalFields) !== JSON.stringify(["id", "display", "channel", "assets"]) || JSON.stringify(value.workspaceMetadata.workspaceOnlyFields) !== JSON.stringify(["description", "draftRevision", "curatorNotes"])) return failure("invalid_pack_source_change_receipt", "Pack source-change receipt workspace metadata is invalid");
  const sourceFields = exactFields(value.sourceState, ["registry", "packs", "channels"], "Pack source-change receipt sourceState"); if (sourceFields !== null || !isRecord(value.sourceState.registry) || !isRecord(value.sourceState.packs) || !isRecord(value.sourceState.channels)) return failure("invalid_pack_source_change_receipt", sourceFields?.detail ?? "Pack source-change receipt sourceState is invalid");
  const registryFields = exactFields(value.sourceState.registry, ["path", "sha256", "changed"], "Pack source-change receipt registry source");
  const packsFields = exactFields(value.sourceState.packs, ["path", "beforeSha256", "afterSha256", "changed"], "Pack source-change receipt Pack source");
  const channelFields = exactFields(value.sourceState.channels, ["path", "sha256", "changed"], "Pack source-change receipt channel source");
  if (registryFields !== null || packsFields !== null || channelFields !== null) return failure("invalid_pack_source_change_receipt", registryFields?.detail ?? packsFields?.detail ?? channelFields?.detail ?? "Source-state fields are invalid");
  if (value.sourceState.registry.path !== "definitions/registry.json" || value.sourceState.registry.changed !== false || typeof value.sourceState.registry.sha256 !== "string" || !LOWER_SHA256.test(value.sourceState.registry.sha256) || value.sourceState.packs.path !== "definitions/packs.json" || value.sourceState.packs.changed !== true || typeof value.sourceState.packs.beforeSha256 !== "string" || !LOWER_SHA256.test(value.sourceState.packs.beforeSha256) || typeof value.sourceState.packs.afterSha256 !== "string" || !LOWER_SHA256.test(value.sourceState.packs.afterSha256) || value.sourceState.channels.path !== "config/channels.json" || value.sourceState.channels.changed !== false || typeof value.sourceState.channels.sha256 !== "string" || !LOWER_SHA256.test(value.sourceState.channels.sha256)) return failure("invalid_pack_source_change_receipt", "Pack source-change receipt source identities are invalid");
  const simulatedFields = exactFields(value.simulatedResult, ["registryAssetCount", "registryFingerprint", "packCountBefore", "packCountAfter", "packMembershipCountBefore", "packMembershipCountAfter", "targetPackMembershipCountBefore", "targetPackMembershipCountAfter"], "Pack source-change receipt simulatedResult"); if (simulatedFields !== null) return failure("invalid_pack_source_change_receipt", simulatedFields.detail);
  for (const key of ["registryAssetCount", "packCountBefore", "packCountAfter", "packMembershipCountBefore", "packMembershipCountAfter", "targetPackMembershipCountBefore", "targetPackMembershipCountAfter"] as const) if (!Number.isSafeInteger(value.simulatedResult[key]) || Number(value.simulatedResult[key]) < 0) return failure("invalid_pack_source_change_receipt", `${key} must be a nonnegative safe integer`);
  if (typeof value.simulatedResult.registryFingerprint !== "string" || !LOWER_SHA256.test(value.simulatedResult.registryFingerprint)) return failure("invalid_pack_source_change_receipt", "Registry fingerprint is invalid");
  const patchFields = exactFields(value.patch, ["format", "sha256", "bytes", "changedPaths"], "Pack source-change receipt patch"); if (patchFields !== null) return failure("invalid_pack_source_change_receipt", patchFields.detail);
  if (value.patch.format !== "unified-diff" || typeof value.patch.sha256 !== "string" || !LOWER_SHA256.test(value.patch.sha256) || !Number.isSafeInteger(value.patch.bytes) || Number(value.patch.bytes) < 1 || JSON.stringify(value.patch.changedPaths) !== JSON.stringify(["definitions/packs.json"])) return failure("invalid_pack_source_change_receipt", "Pack source-change receipt patch identity is invalid");
  return success(value as unknown as PackSourceChangeReceipt);
}

export function currentPackPromotionContext(input: {
  readonly assets: readonly Asset[];
  readonly packs: readonly Pack[];
  readonly channels: Readonly<Record<string, unknown>>;
  readonly registryBytes: Buffer;
  readonly packsBytes: Buffer;
  readonly channelsBytes: Buffer;
}): PackPromotionContext {
  return Object.freeze({
    ...input,
    registrySha256: sha256(input.registryBytes),
    packsSha256: sha256(input.packsBytes),
    channelsSha256: sha256(input.channelsBytes),
    registryFingerprint: computeAssetRegistrationRegistryFingerprint(input.assets, input.packs),
  });
}

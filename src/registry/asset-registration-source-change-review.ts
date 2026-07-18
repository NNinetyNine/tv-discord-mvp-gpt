import { createHash } from "node:crypto";

import {
  generateAssetRegistrationSourceChange,
  type AssetRegistrationSourceChangeReceipt,
} from "./asset-registration-source-change.ts";

export const ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_SCHEMA_VERSION = 1 as const;
export const ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_TYPE = "visionx.asset-registration.source-change-review" as const;

export const ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_MAX_LENGTHS = Object.freeze({
  reviewerId: 64,
  decidedAt: 40,
  referenceId: 96,
  notes: 500,
});

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u;
const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

export type AssetRegistrationSourceChangeReviewDecisionValue = "approved" | "rejected";

export interface AssetRegistrationSourceChangeReviewDecision {
  readonly schemaVersion: 1;
  readonly decision: AssetRegistrationSourceChangeReviewDecisionValue;
  readonly reviewerId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export interface AssetRegistrationSourceChangeReviewReceipt {
  readonly schemaVersion: 1;
  readonly reviewType: "visionx.asset-registration.source-change-review";
  readonly reviewStatus: "approved" | "rejected";
  readonly technicalValidation: {
    readonly ok: true;
    readonly proposalVerified: true;
    readonly planningAuthorizationVerified: true;
    readonly applicationPlanReconstructed: true;
    readonly applicationPlanBytesVerified: true;
    readonly sourceChangeReconstructed: true;
    readonly sourcePatchBytesVerified: true;
    readonly sourceChangeReceiptBytesVerified: true;
    readonly sourceStateVerified: true;
    readonly futureStateVerified: true;
    readonly patchApplyCheckVerified: true;
    readonly staleStateDetected: false;
  };
  readonly inputs: {
    readonly proposalSha256: string;
    readonly planningAuthorizationSha256: string;
    readonly applicationPlanSha256: string;
    readonly sourcePatchSha256: string;
    readonly sourceChangeReceiptSha256: string;
    readonly reviewDecisionSha256: string;
  };
  readonly proposal: {
    readonly operation: "add" | "update_identity";
    readonly assetId: string;
    readonly channel: string;
  };
  readonly reviewDecision: AssetRegistrationSourceChangeReviewDecision;
  readonly sourceState: AssetRegistrationSourceChangeReceipt["sourceState"];
  readonly simulatedResult: AssetRegistrationSourceChangeReceipt["simulatedResult"];
  readonly applicationEligible: boolean;
  readonly sourceChangesApplied: false;
}

export type AssetRegistrationSourceChangeReviewFailureReason =
  | "invalid_proposal"
  | "invalid_planning_authorization"
  | "invalid_application_plan"
  | "invalid_source_patch"
  | "invalid_source_change_receipt"
  | "invalid_review_decision"
  | "unsupported_schema_version"
  | "proposal_hash_mismatch"
  | "planning_authorization_hash_mismatch"
  | "application_plan_hash_mismatch"
  | "source_patch_hash_mismatch"
  | "source_change_receipt_hash_mismatch"
  | "plan_reconstruction_mismatch"
  | "source_change_reconstruction_mismatch"
  | "stale_registry_state"
  | "stale_pack_state"
  | "stale_asset_state"
  | "stale_channel_configuration"
  | "unsupported_operation"
  | "source_shape_unsupported"
  | "source_serialization_failed"
  | "source_reload_failed"
  | "source_result_mismatch"
  | "patch_verification_failed";

export interface AssetRegistrationSourceChangeReviewFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationSourceChangeReviewFailureReason;
  readonly detail: string;
}

export interface ReviewAssetRegistrationSourceChangeInput {
  readonly proposal: unknown;
  readonly proposalBytes: Buffer;
  readonly proposalSha256: string;
  readonly planningAuthorization: unknown;
  readonly planningAuthorizationBytes: Buffer;
  readonly planningAuthorizationSha256: string;
  readonly applicationPlan: unknown;
  readonly applicationPlanBytes: Buffer;
  readonly applicationPlanSha256: string;
  readonly sourcePatchBytes: Buffer;
  readonly sourcePatchSha256: string;
  readonly sourceChangeReceipt: unknown;
  readonly sourceChangeReceiptBytes: Buffer;
  readonly sourceChangeReceiptSha256: string;
  readonly reviewDecision: unknown;
  readonly reviewDecisionBytes: Buffer;
  readonly reviewDecisionSha256: string;
  readonly registryBytes: Buffer;
  readonly packsBytes: Buffer;
  readonly channelsBytes: Buffer;
  readonly patchApplyCheckVerified: boolean;
}

export interface AssetRegistrationSourceChangeReviewSuccess {
  readonly ok: true;
  readonly receipt: AssetRegistrationSourceChangeReviewReceipt;
  readonly receiptBytes: Buffer;
}

export type AssetRegistrationSourceChangeReviewResult =
  | AssetRegistrationSourceChangeReviewSuccess
  | AssetRegistrationSourceChangeReviewFailure;

export type AssetRegistrationSourceChangeReviewDecisionValidationResult =
  | { readonly ok: true; readonly decision: AssetRegistrationSourceChangeReviewDecision }
  | AssetRegistrationSourceChangeReviewFailure;

export type AssetRegistrationSourceChangeReviewReceiptValidationResult =
  | { readonly ok: true; readonly receipt: AssetRegistrationSourceChangeReviewReceipt }
  | AssetRegistrationSourceChangeReviewFailure;

function failure(reason: AssetRegistrationSourceChangeReviewFailureReason, detail: string): AssetRegistrationSourceChangeReviewFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Readonly<Record<string, unknown>>, expected: readonly string[], where: string): AssetRegistrationSourceChangeReviewFailure | null {
  const actual = Object.keys(value);
  const expectedSet = new Set(expected);
  const unknown = actual.filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length === 0 && missing.length === 0) return null;
  return failure("invalid_source_change_receipt", `${where} fields are invalid; missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}]`);
}

function validTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const [yearText, monthText, dayText] = (match[1] ?? "").split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function exactDecisionString(
  value: unknown,
  field: keyof typeof ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_MAX_LENGTHS,
  multiline: boolean,
): string | AssetRegistrationSourceChangeReviewFailure {
  if (typeof value !== "string") return failure("invalid_review_decision", `${field} must be a string`);
  if (value.length === 0 || value.trim().length === 0) return failure("invalid_review_decision", `${field} must not be empty`);
  if (value.trim() !== value) return failure("invalid_review_decision", `${field} must not contain outer whitespace`);
  if ((multiline ? MULTILINE_CONTROL : SINGLE_LINE_CONTROL).test(value)) {
    return failure("invalid_review_decision", `${field} contains forbidden control characters${multiline ? "" : " or newlines"}`);
  }
  if (value.length > ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_MAX_LENGTHS[field]) {
    return failure("invalid_review_decision", `${field} exceeds maximum length ${ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_MAX_LENGTHS[field]}`);
  }
  return value;
}

export function validateAssetRegistrationSourceChangeReviewDecision(value: unknown): AssetRegistrationSourceChangeReviewDecisionValidationResult {
  if (!isRecord(value)) return failure("invalid_review_decision", "review decision must be a JSON object");
  const allowed = new Set(["schemaVersion", "decision", "reviewerId", "decidedAt", "referenceId", "notes"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return failure("invalid_review_decision", `review decision contains unknown fields: ${unknown.join(", ")}`);
  for (const required of ["schemaVersion", "decision", "reviewerId", "decidedAt", "referenceId"] as const) {
    if (!(required in value)) return failure("invalid_review_decision", `review decision is missing ${required}`);
  }
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "review decision schemaVersion must equal 1");
  if (value.decision !== "approved" && value.decision !== "rejected") {
    return failure("invalid_review_decision", "review decision must be approved or rejected");
  }
  const reviewerId = exactDecisionString(value.reviewerId, "reviewerId", false);
  if (typeof reviewerId !== "string") return reviewerId;
  const decidedAt = exactDecisionString(value.decidedAt, "decidedAt", false);
  if (typeof decidedAt !== "string") return decidedAt;
  if (!validTimestamp(decidedAt)) return failure("invalid_review_decision", "decidedAt must be a valid ISO-8601 timestamp with an explicit timezone");
  const referenceId = exactDecisionString(value.referenceId, "referenceId", false);
  if (typeof referenceId !== "string") return referenceId;
  let notes: string | undefined;
  if (value.notes !== undefined) {
    const checked = exactDecisionString(value.notes, "notes", true);
    if (typeof checked !== "string") return checked;
    notes = checked;
  }
  return Object.freeze({
    ok: true,
    decision: Object.freeze({
      schemaVersion: 1,
      decision: value.decision,
      reviewerId,
      decidedAt,
      referenceId,
      ...(notes === undefined ? {} : { notes }),
    }),
  });
}

export function serializeAssetRegistrationSourceChangeReviewDecision(decision: AssetRegistrationSourceChangeReviewDecision): Buffer {
  return Buffer.from(`${JSON.stringify(decision, null, 2)}\n`, "utf8");
}

function validateSourceChangeReceipt(value: unknown): value is AssetRegistrationSourceChangeReceipt {
  if (!isRecord(value)) return false;
  const top = exactFields(value, ["schemaVersion", "changeType", "generationStatus", "technicalValidation", "inputs", "proposal", "sourceState", "simulatedResult", "patch", "sourceChangesApplied"], "source-change receipt");
  if (top !== null) return false;
  if (value.schemaVersion !== 1 || value.changeType !== "visionx.asset-registration.source-change" || value.generationStatus !== "generated_not_applied" || value.sourceChangesApplied !== false) return false;
  if (!isRecord(value.technicalValidation) || value.technicalValidation.ok !== true) return false;
  if (!isRecord(value.inputs) || !isRecord(value.proposal) || !isRecord(value.sourceState) || !isRecord(value.simulatedResult) || !isRecord(value.patch)) return false;
  if (typeof value.patch.sha256 !== "string" || !LOWER_SHA256.test(value.patch.sha256)) return false;
  return true;
}

export function validateAssetRegistrationSourceChangeReviewReceipt(value: unknown): AssetRegistrationSourceChangeReviewReceiptValidationResult {
  if (!isRecord(value)) return failure("invalid_source_change_receipt", "source-change review receipt must be a JSON object");
  const top = exactFields(value, ["schemaVersion", "reviewType", "reviewStatus", "technicalValidation", "inputs", "proposal", "reviewDecision", "sourceState", "simulatedResult", "applicationEligible", "sourceChangesApplied"], "source-change review receipt");
  if (top !== null) return top;
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "source-change review receipt schemaVersion must equal 1");
  if (value.reviewType !== ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_TYPE) return failure("invalid_source_change_receipt", "source-change review receipt type is invalid");
  if (value.reviewStatus !== "approved" && value.reviewStatus !== "rejected") return failure("invalid_source_change_receipt", "source-change review status is invalid");
  if (value.applicationEligible !== (value.reviewStatus === "approved") || value.sourceChangesApplied !== false) {
    return failure("invalid_source_change_receipt", "source-change review eligibility or applied status is inconsistent");
  }
  const decision = validateAssetRegistrationSourceChangeReviewDecision(value.reviewDecision);
  if (!decision.ok) return failure("invalid_source_change_receipt", decision.detail);
  if (decision.decision.decision !== value.reviewStatus) return failure("invalid_source_change_receipt", "embedded review decision does not match reviewStatus");
  if (!isRecord(value.technicalValidation) || !isRecord(value.inputs) || !isRecord(value.proposal) || !isRecord(value.sourceState) || !isRecord(value.simulatedResult)) {
    return failure("invalid_source_change_receipt", "source-change review receipt nested structures are invalid");
  }
  const technical = value.technicalValidation;
  const technicalFields = exactFields(technical, ["ok", "proposalVerified", "planningAuthorizationVerified", "applicationPlanReconstructed", "applicationPlanBytesVerified", "sourceChangeReconstructed", "sourcePatchBytesVerified", "sourceChangeReceiptBytesVerified", "sourceStateVerified", "futureStateVerified", "patchApplyCheckVerified", "staleStateDetected"], "source-change review technicalValidation");
  if (technicalFields !== null) return technicalFields;
  if (Object.entries(technical).some(([key, item]) => key === "staleStateDetected" ? item !== false : item !== true)) {
    return failure("invalid_source_change_receipt", "source-change review technicalValidation is inconsistent");
  }
  const inputFields = exactFields(value.inputs, ["proposalSha256", "planningAuthorizationSha256", "applicationPlanSha256", "sourcePatchSha256", "sourceChangeReceiptSha256", "reviewDecisionSha256"], "source-change review inputs");
  if (inputFields !== null) return inputFields;
  for (const key of Object.keys(value.inputs)) {
    if (typeof value.inputs[key] !== "string" || !LOWER_SHA256.test(value.inputs[key] as string)) return failure("invalid_source_change_receipt", `source-change review input ${key} is not a lowercase SHA-256`);
  }
  return Object.freeze({ ok: true, receipt: value as unknown as AssetRegistrationSourceChangeReviewReceipt });
}

export function serializeAssetRegistrationSourceChangeReviewReceipt(receipt: AssetRegistrationSourceChangeReviewReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function mapGeneratorFailure(reason: string): AssetRegistrationSourceChangeReviewFailureReason {
  const direct = new Set<AssetRegistrationSourceChangeReviewFailureReason>([
    "invalid_proposal", "invalid_application_plan", "unsupported_schema_version", "proposal_hash_mismatch",
    "application_plan_hash_mismatch", "plan_reconstruction_mismatch", "stale_registry_state", "stale_pack_state",
    "stale_asset_state", "stale_channel_configuration", "unsupported_operation", "source_shape_unsupported",
    "source_serialization_failed", "source_reload_failed", "source_result_mismatch",
  ]);
  if (reason === "invalid_authorization" || reason === "authorization_hash_mismatch") return "invalid_planning_authorization";
  return direct.has(reason as AssetRegistrationSourceChangeReviewFailureReason)
    ? reason as AssetRegistrationSourceChangeReviewFailureReason
    : "source_change_reconstruction_mismatch";
}

export function reviewAssetRegistrationSourceChange(input: ReviewAssetRegistrationSourceChangeInput): AssetRegistrationSourceChangeReviewResult {
  const hashChecks: readonly [Buffer, string, AssetRegistrationSourceChangeReviewFailureReason, string][] = [
    [input.proposalBytes, input.proposalSha256, "proposal_hash_mismatch", "proposal"],
    [input.planningAuthorizationBytes, input.planningAuthorizationSha256, "planning_authorization_hash_mismatch", "planning authorization"],
    [input.applicationPlanBytes, input.applicationPlanSha256, "application_plan_hash_mismatch", "application plan"],
    [input.sourcePatchBytes, input.sourcePatchSha256, "source_patch_hash_mismatch", "source patch"],
    [input.sourceChangeReceiptBytes, input.sourceChangeReceiptSha256, "source_change_receipt_hash_mismatch", "source-change receipt"],
    [input.reviewDecisionBytes, input.reviewDecisionSha256, "invalid_review_decision", "review decision"],
  ];
  for (const [bytes, expected, reason, label] of hashChecks) {
    if (hash(bytes) !== expected) return failure(reason, `${label} SHA-256 does not match its bytes`);
  }
  const decisionValidation = validateAssetRegistrationSourceChangeReviewDecision(input.reviewDecision);
  if (!decisionValidation.ok) return decisionValidation;
  if (!serializeAssetRegistrationSourceChangeReviewDecision(decisionValidation.decision).equals(input.reviewDecisionBytes)) {
    return failure("invalid_review_decision", "review decision bytes are not canonical deterministic JSON");
  }
  if (!validateSourceChangeReceipt(input.sourceChangeReceipt)) {
    return failure("invalid_source_change_receipt", "source-change receipt schema is invalid");
  }
  if (!input.patchApplyCheckVerified) return failure("patch_verification_failed", "source patch did not pass isolated git apply --check");

  const reconstructed = generateAssetRegistrationSourceChange({
    proposal: input.proposal,
    proposalBytes: input.proposalBytes,
    proposalSha256: input.proposalSha256,
    authorization: input.planningAuthorization,
    authorizationBytes: input.planningAuthorizationBytes,
    authorizationSha256: input.planningAuthorizationSha256,
    applicationPlan: input.applicationPlan,
    applicationPlanBytes: input.applicationPlanBytes,
    applicationPlanSha256: input.applicationPlanSha256,
    registryBytes: input.registryBytes,
    packsBytes: input.packsBytes,
    channelsBytes: input.channelsBytes,
  });
  if (!reconstructed.ok) return failure(mapGeneratorFailure(reconstructed.reason), reconstructed.detail);
  if (!reconstructed.patchBytes.equals(input.sourcePatchBytes)) {
    return failure("source_change_reconstruction_mismatch", "supplied source patch differs from canonical reconstruction");
  }
  if (!reconstructed.receiptBytes.equals(input.sourceChangeReceiptBytes)) {
    return failure("source_change_reconstruction_mismatch", "supplied source-change receipt differs from canonical reconstruction");
  }

  const reviewStatus = decisionValidation.decision.decision;
  const receipt: AssetRegistrationSourceChangeReviewReceipt = Object.freeze({
    schemaVersion: ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_SCHEMA_VERSION,
    reviewType: ASSET_REGISTRATION_SOURCE_CHANGE_REVIEW_TYPE,
    reviewStatus,
    technicalValidation: Object.freeze({
      ok: true,
      proposalVerified: true,
      planningAuthorizationVerified: true,
      applicationPlanReconstructed: true,
      applicationPlanBytesVerified: true,
      sourceChangeReconstructed: true,
      sourcePatchBytesVerified: true,
      sourceChangeReceiptBytesVerified: true,
      sourceStateVerified: true,
      futureStateVerified: true,
      patchApplyCheckVerified: true,
      staleStateDetected: false,
    }),
    inputs: Object.freeze({
      proposalSha256: input.proposalSha256,
      planningAuthorizationSha256: input.planningAuthorizationSha256,
      applicationPlanSha256: input.applicationPlanSha256,
      sourcePatchSha256: input.sourcePatchSha256,
      sourceChangeReceiptSha256: input.sourceChangeReceiptSha256,
      reviewDecisionSha256: input.reviewDecisionSha256,
    }),
    proposal: Object.freeze({ ...reconstructed.receipt.proposal }),
    reviewDecision: decisionValidation.decision,
    sourceState: reconstructed.receipt.sourceState,
    simulatedResult: reconstructed.receipt.simulatedResult,
    applicationEligible: reviewStatus === "approved",
    sourceChangesApplied: false,
  });
  return Object.freeze({ ok: true, receipt, receiptBytes: serializeAssetRegistrationSourceChangeReviewReceipt(receipt) });
}

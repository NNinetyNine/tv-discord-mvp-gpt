import {
  generatePackSourceChange,
  serializePackSourceChangeReceipt,
  sha256,
  validatePackSourceChangeReceipt,
  type PackPromotionContext,
  type PackPromotionOperation,
  type PackPromotionFailureReason,
  type PackPromotionCanonicalPack,
  type PackSourceApplicationPlan,
  type PackSourceChangeReceipt,
} from "./pack-draft-promotion.ts";

export const PACK_SOURCE_CHANGE_REVIEW_DECISION_SCHEMA_VERSION = 1 as const;
export const PACK_SOURCE_CHANGE_REVIEW_DECISION_TYPE = "visionx.pack-source-change-review-decision" as const;
export const PACK_SOURCE_CHANGE_REVIEW_SCHEMA_VERSION = 1 as const;
export const PACK_SOURCE_CHANGE_REVIEW_TYPE = "visionx.pack.source-change-review" as const;

export const PACK_SOURCE_CHANGE_REVIEW_TEXT_LIMITS = Object.freeze({
  reviewerId: 64,
  decidedAt: 40,
  referenceId: 96,
  notes: 500,
});

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u;
const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

export type PackSourceChangeReviewDecisionValue = "approved" | "rejected";

export interface PackSourceChangeReviewDecision {
  readonly schemaVersion: 1;
  readonly decisionType: typeof PACK_SOURCE_CHANGE_REVIEW_DECISION_TYPE;
  readonly decision: PackSourceChangeReviewDecisionValue;
  readonly reviewerId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export interface PackSourceChangeReviewReceipt {
  readonly schemaVersion: 1;
  readonly reviewType: typeof PACK_SOURCE_CHANGE_REVIEW_TYPE;
  readonly decision: PackSourceChangeReviewDecisionValue;
  readonly reviewStatus: "approved_not_authorized_for_application" | "rejected";
  readonly technicalValidation: {
    readonly ok: true;
    readonly promotionRequestVerified: true;
    readonly draftVerified: true;
    readonly proposalReconstructed: true;
    readonly proposalBytesVerified: true;
    readonly planningAuthorizationVerified: true;
    readonly applicationPlanReconstructed: true;
    readonly applicationPlanBytesVerified: true;
    readonly sourceChangeReconstructed: true;
    readonly sourceChangeBytesVerified: true;
    readonly patchReconstructed: true;
    readonly patchBytesVerified: true;
    readonly sourceStateVerified: true;
    readonly futureStateVerified: true;
    readonly changedPathsVerified: true;
    readonly staleStateDetected: false;
  };
  readonly inputs: {
    readonly promotionRequestSha256: string;
    readonly draftSha256: string;
    readonly packProposalSha256: string;
    readonly planningAuthorizationSha256: string;
    readonly applicationPlanSha256: string;
    readonly sourcePatchSha256: string;
    readonly sourceChangeReceiptSha256: string;
    readonly reviewDecisionSha256: string;
  };
  readonly reviewer: {
    readonly reviewerId: string;
    readonly decidedAt: string;
    readonly referenceId: string;
    readonly notes?: string;
  };
  readonly operation: PackPromotionOperation;
  readonly pack: PackPromotionCanonicalPack;
  readonly sourceState: {
    readonly packsBeforeSha256: string;
    readonly packsAfterSha256: string;
  };
  readonly simulatedResult: PackSourceApplicationPlan["simulatedResult"];
  readonly applicationAuthorized: false;
  readonly sourceChangesApplied: false;
}

export type PackSourceChangeReviewFailureReason =
  | "invalid_review_decision"
  | "invalid_pack_source_change_review"
  | "unsupported_schema_version"
  | "promotion_request_hash_mismatch"
  | "draft_hash_mismatch"
  | "proposal_hash_mismatch"
  | "planning_authorization_hash_mismatch"
  | "application_plan_hash_mismatch"
  | "source_patch_hash_mismatch"
  | "source_change_receipt_hash_mismatch"
  | "review_decision_hash_mismatch"
  | "proposal_reconstruction_mismatch"
  | "plan_reconstruction_mismatch"
  | "source_change_reconstruction_mismatch"
  | "patch_verification_failed"
  | PackPromotionFailureReason;

export interface PackSourceChangeReviewFailure {
  readonly ok: false;
  readonly reason: PackSourceChangeReviewFailureReason;
  readonly detail: string;
}

export interface PackSourceChangeReviewSuccess {
  readonly ok: true;
  readonly receipt: PackSourceChangeReviewReceipt;
  readonly receiptBytes: Buffer;
}

export type PackSourceChangeReviewResult = PackSourceChangeReviewSuccess | PackSourceChangeReviewFailure;

export interface ReviewPackSourceChangeInput {
  readonly promotionRequestValue: unknown;
  readonly promotionRequestBytes: Buffer;
  readonly promotionRequestSha256: string;
  readonly draftBytes: Buffer;
  readonly draftSha256: string;
  readonly proposalValue: unknown;
  readonly proposalBytes: Buffer;
  readonly proposalSha256: string;
  readonly planningAuthorizationValue: unknown;
  readonly planningAuthorizationBytes: Buffer;
  readonly planningAuthorizationSha256: string;
  readonly applicationPlanValue: unknown;
  readonly applicationPlanBytes: Buffer;
  readonly applicationPlanSha256: string;
  readonly sourcePatchBytes: Buffer;
  readonly sourcePatchSha256: string;
  readonly sourceChangeReceiptValue: unknown;
  readonly sourceChangeReceiptBytes: Buffer;
  readonly sourceChangeReceiptSha256: string;
  readonly reviewDecisionValue: unknown;
  readonly reviewDecisionBytes: Buffer;
  readonly reviewDecisionSha256: string;
  readonly context: PackPromotionContext;
  readonly patchApplyCheckVerified: boolean;
}

function failure(reason: PackSourceChangeReviewFailureReason, detail: string): PackSourceChangeReviewFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function success(receipt: PackSourceChangeReviewReceipt): PackSourceChangeReviewSuccess {
  return Object.freeze({ ok: true, receipt, receiptBytes: serializePackSourceChangeReviewReceipt(receipt) });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): string | null {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(wanted) ? null : `${label} fields must be exactly: ${wanted.join(", ")}`;
}

function validTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null) return false;
  if (!Number.isFinite(Date.parse(value))) return false;
  const [yearText, monthText, dayText] = (match[1] ?? "").split("-");
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function validateText(
  value: unknown,
  field: keyof typeof PACK_SOURCE_CHANGE_REVIEW_TEXT_LIMITS,
  multiline = false,
): string | PackSourceChangeReviewFailure {
  if (typeof value !== "string") return failure("invalid_review_decision", `${field} must be a string`);
  if (value.length === 0 || value.trim().length === 0 || value.trim() !== value) {
    return failure("invalid_review_decision", `${field} must be normalized nonempty text`);
  }
  if ((multiline ? MULTILINE_CONTROL : SINGLE_LINE_CONTROL).test(value)) {
    return failure("invalid_review_decision", `${field} contains forbidden control characters${multiline ? "" : " or newlines"}`);
  }
  if (value.length > PACK_SOURCE_CHANGE_REVIEW_TEXT_LIMITS[field]) {
    return failure("invalid_review_decision", `${field} exceeds maximum length ${PACK_SOURCE_CHANGE_REVIEW_TEXT_LIMITS[field]}`);
  }
  return value;
}

export function validatePackSourceChangeReviewDecision(
  value: unknown,
): { readonly ok: true; readonly value: PackSourceChangeReviewDecision } | PackSourceChangeReviewFailure {
  if (!isRecord(value)) return failure("invalid_review_decision", "Review decision must be a JSON object");
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "Review decision schemaVersion must equal 1");
  const expected = ["schemaVersion", "decisionType", "decision", "reviewerId", "decidedAt", "referenceId", ...(value.notes === undefined ? [] : ["notes"])];
  const fields = exactFields(value, expected, "Review decision");
  if (fields !== null) return failure("invalid_review_decision", fields);
  if (value.decisionType !== PACK_SOURCE_CHANGE_REVIEW_DECISION_TYPE) return failure("invalid_review_decision", "Review decision type is invalid");
  if (value.decision !== "approved" && value.decision !== "rejected") return failure("invalid_review_decision", "Review decision must be approved or rejected");
  const reviewerId = validateText(value.reviewerId, "reviewerId"); if (typeof reviewerId !== "string") return reviewerId;
  const decidedAt = validateText(value.decidedAt, "decidedAt"); if (typeof decidedAt !== "string") return decidedAt;
  if (!validTimestamp(decidedAt)) return failure("invalid_review_decision", "decidedAt must be a valid ISO-8601 timestamp with an explicit timezone");
  const referenceId = validateText(value.referenceId, "referenceId"); if (typeof referenceId !== "string") return referenceId;
  let notes: string | undefined;
  if (value.notes !== undefined) { const checked = validateText(value.notes, "notes", true); if (typeof checked !== "string") return checked; notes = checked; }
  return Object.freeze({ ok: true, value: Object.freeze({ schemaVersion: 1, decisionType: PACK_SOURCE_CHANGE_REVIEW_DECISION_TYPE, decision: value.decision, reviewerId, decidedAt, referenceId, ...(notes === undefined ? {} : { notes }) }) });
}

export function serializePackSourceChangeReviewDecision(value: PackSourceChangeReviewDecision): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function serializePackSourceChangeReviewReceipt(value: PackSourceChangeReviewReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function validatePackSourceChangeReviewReceipt(
  value: unknown,
): { readonly ok: true; readonly value: PackSourceChangeReviewReceipt } | PackSourceChangeReviewFailure {
  if (!isRecord(value)) return failure("invalid_pack_source_change_review", "Pack source-change review must be a JSON object");
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "Pack source-change review schemaVersion must equal 1");
  const top = exactFields(value, ["schemaVersion", "reviewType", "decision", "reviewStatus", "technicalValidation", "inputs", "reviewer", "operation", "pack", "sourceState", "simulatedResult", "applicationAuthorized", "sourceChangesApplied"], "Pack source-change review");
  if (top !== null) return failure("invalid_pack_source_change_review", top);
  if (value.reviewType !== PACK_SOURCE_CHANGE_REVIEW_TYPE || (value.decision !== "approved" && value.decision !== "rejected") || value.applicationAuthorized !== false || value.sourceChangesApplied !== false) return failure("invalid_pack_source_change_review", "Pack source-change review identity or state is invalid");
  const expectedStatus = value.decision === "approved" ? "approved_not_authorized_for_application" : "rejected";
  if (value.reviewStatus !== expectedStatus) return failure("invalid_pack_source_change_review", "Pack source-change review status does not match the decision");
  if (!isRecord(value.technicalValidation) || !isRecord(value.inputs) || !isRecord(value.reviewer) || !isRecord(value.pack) || !isRecord(value.sourceState) || !isRecord(value.simulatedResult)) return failure("invalid_pack_source_change_review", "Pack source-change review nested structures are invalid");
  const technicalKeys = ["ok", "promotionRequestVerified", "draftVerified", "proposalReconstructed", "proposalBytesVerified", "planningAuthorizationVerified", "applicationPlanReconstructed", "applicationPlanBytesVerified", "sourceChangeReconstructed", "sourceChangeBytesVerified", "patchReconstructed", "patchBytesVerified", "sourceStateVerified", "futureStateVerified", "changedPathsVerified", "staleStateDetected"] as const;
  const technicalFields = exactFields(value.technicalValidation, technicalKeys, "Review technicalValidation"); if (technicalFields !== null) return failure("invalid_pack_source_change_review", technicalFields);
  for (const key of technicalKeys) if (value.technicalValidation[key] !== (key === "staleStateDetected" ? false : true)) return failure("invalid_pack_source_change_review", `technicalValidation.${key} is invalid`);
  const inputKeys = ["promotionRequestSha256", "draftSha256", "packProposalSha256", "planningAuthorizationSha256", "applicationPlanSha256", "sourcePatchSha256", "sourceChangeReceiptSha256", "reviewDecisionSha256"] as const;
  const inputFields = exactFields(value.inputs, inputKeys, "Review inputs"); if (inputFields !== null) return failure("invalid_pack_source_change_review", inputFields);
  for (const key of inputKeys) if (typeof value.inputs[key] !== "string" || !LOWER_SHA256.test(value.inputs[key] as string)) return failure("invalid_pack_source_change_review", `${key} must be a lowercase SHA-256 digest`);
  const reviewerFields = exactFields(value.reviewer, ["reviewerId", "decidedAt", "referenceId", ...(value.reviewer.notes === undefined ? [] : ["notes"])], "Review reviewer"); if (reviewerFields !== null) return failure("invalid_pack_source_change_review", reviewerFields);
  const decision = validatePackSourceChangeReviewDecision({ schemaVersion: 1, decisionType: PACK_SOURCE_CHANGE_REVIEW_DECISION_TYPE, decision: value.decision, ...value.reviewer });
  if (!decision.ok) return failure("invalid_pack_source_change_review", decision.detail);
  const packFields = exactFields(value.pack, ["id", "display", "channel", "assetIds"], "Review Pack"); if (packFields !== null || typeof value.pack.id !== "string" || typeof value.pack.display !== "string" || typeof value.pack.channel !== "string" || !Array.isArray(value.pack.assetIds) || value.pack.assetIds.some((entry) => typeof entry !== "string")) return failure("invalid_pack_source_change_review", packFields ?? "Review Pack is invalid");
  const sourceFields = exactFields(value.sourceState, ["packsBeforeSha256", "packsAfterSha256"], "Review sourceState"); if (sourceFields !== null || typeof value.sourceState.packsBeforeSha256 !== "string" || !LOWER_SHA256.test(value.sourceState.packsBeforeSha256) || typeof value.sourceState.packsAfterSha256 !== "string" || !LOWER_SHA256.test(value.sourceState.packsAfterSha256)) return failure("invalid_pack_source_change_review", sourceFields ?? "Review sourceState is invalid");
  return Object.freeze({ ok: true, value: value as unknown as PackSourceChangeReviewReceipt });
}

function mapPromotionFailure(reason: PackPromotionFailureReason): PackSourceChangeReviewFailureReason {
  return reason;
}

export function reviewPackSourceChange(input: ReviewPackSourceChangeInput): PackSourceChangeReviewResult {
  const checks: readonly [Buffer, string, PackSourceChangeReviewFailureReason, string][] = [
    [input.promotionRequestBytes, input.promotionRequestSha256, "promotion_request_hash_mismatch", "promotion request"],
    [input.draftBytes, input.draftSha256, "draft_hash_mismatch", "saved draft"],
    [input.proposalBytes, input.proposalSha256, "proposal_hash_mismatch", "Pack proposal"],
    [input.planningAuthorizationBytes, input.planningAuthorizationSha256, "planning_authorization_hash_mismatch", "planning authorization"],
    [input.applicationPlanBytes, input.applicationPlanSha256, "application_plan_hash_mismatch", "Pack application plan"],
    [input.sourcePatchBytes, input.sourcePatchSha256, "source_patch_hash_mismatch", "source patch"],
    [input.sourceChangeReceiptBytes, input.sourceChangeReceiptSha256, "source_change_receipt_hash_mismatch", "source-change receipt"],
    [input.reviewDecisionBytes, input.reviewDecisionSha256, "review_decision_hash_mismatch", "review decision"],
  ];
  for (const [bytes, expected, reason, label] of checks) if (sha256(bytes) !== expected) return failure(reason, `${label} SHA-256 does not match its bytes`);

  const decisionResult = validatePackSourceChangeReviewDecision(input.reviewDecisionValue);
  if (!decisionResult.ok) return decisionResult;
  if (!serializePackSourceChangeReviewDecision(decisionResult.value).equals(input.reviewDecisionBytes)) return failure("invalid_review_decision", "Review decision bytes are not canonical deterministic JSON");
  const receiptValidation = validatePackSourceChangeReceipt(input.sourceChangeReceiptValue);
  if (!receiptValidation.ok) return failure("invalid_pack_source_change_receipt", receiptValidation.detail);
  if (!serializePackSourceChangeReceipt(receiptValidation.value).equals(input.sourceChangeReceiptBytes)) return failure("invalid_pack_source_change_receipt", "Source-change receipt bytes are not canonical deterministic JSON");
  if (!input.patchApplyCheckVerified) return failure("patch_verification_failed", "Source patch failed isolated git apply --check");

  const reconstructed = generatePackSourceChange({
    requestValue: input.promotionRequestValue,
    requestBytes: input.promotionRequestBytes,
    draftBytes: input.draftBytes,
    proposalValue: input.proposalValue,
    proposalBytes: input.proposalBytes,
    authorizationValue: input.planningAuthorizationValue,
    authorizationBytes: input.planningAuthorizationBytes,
    planValue: input.applicationPlanValue,
    planBytes: input.applicationPlanBytes,
    context: input.context,
  });
  if (!reconstructed.ok) return failure(mapPromotionFailure(reconstructed.reason), reconstructed.detail);
  if (!reconstructed.value.patch.equals(input.sourcePatchBytes)) return failure("source_change_reconstruction_mismatch", "Supplied source patch differs from canonical reconstruction");
  const reconstructedReceiptBytes = serializePackSourceChangeReceipt(reconstructed.value.receipt);
  if (!reconstructedReceiptBytes.equals(input.sourceChangeReceiptBytes)) return failure("source_change_reconstruction_mismatch", "Supplied source-change receipt differs from canonical reconstruction");
  if (JSON.stringify(reconstructed.value.receipt.patch.changedPaths) !== JSON.stringify(["definitions/packs.json"])) return failure("source_change_reconstruction_mismatch", "Source change modifies an unsupported path");

  const decision = decisionResult.value;
  const receipt: PackSourceChangeReviewReceipt = Object.freeze({
    schemaVersion: PACK_SOURCE_CHANGE_REVIEW_SCHEMA_VERSION,
    reviewType: PACK_SOURCE_CHANGE_REVIEW_TYPE,
    decision: decision.decision,
    reviewStatus: decision.decision === "approved" ? "approved_not_authorized_for_application" : "rejected",
    technicalValidation: Object.freeze({
      ok: true,
      promotionRequestVerified: true,
      draftVerified: true,
      proposalReconstructed: true,
      proposalBytesVerified: true,
      planningAuthorizationVerified: true,
      applicationPlanReconstructed: true,
      applicationPlanBytesVerified: true,
      sourceChangeReconstructed: true,
      sourceChangeBytesVerified: true,
      patchReconstructed: true,
      patchBytesVerified: true,
      sourceStateVerified: true,
      futureStateVerified: true,
      changedPathsVerified: true,
      staleStateDetected: false,
    }),
    inputs: Object.freeze({
      promotionRequestSha256: input.promotionRequestSha256,
      draftSha256: input.draftSha256,
      packProposalSha256: input.proposalSha256,
      planningAuthorizationSha256: input.planningAuthorizationSha256,
      applicationPlanSha256: input.applicationPlanSha256,
      sourcePatchSha256: input.sourcePatchSha256,
      sourceChangeReceiptSha256: input.sourceChangeReceiptSha256,
      reviewDecisionSha256: input.reviewDecisionSha256,
    }),
    reviewer: Object.freeze({ reviewerId: decision.reviewerId, decidedAt: decision.decidedAt, referenceId: decision.referenceId, ...(decision.notes === undefined ? {} : { notes: decision.notes }) }),
    operation: reconstructed.value.receipt.operation,
    pack: reconstructed.value.receipt.pack,
    sourceState: Object.freeze({ packsBeforeSha256: reconstructed.value.receipt.sourceState.packs.beforeSha256, packsAfterSha256: reconstructed.value.receipt.sourceState.packs.afterSha256 }),
    simulatedResult: reconstructed.value.receipt.simulatedResult,
    applicationAuthorized: false,
    sourceChangesApplied: false,
  });
  return success(receipt);
}

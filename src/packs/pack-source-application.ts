import {
  generatePackSourceChange,
  serializePackSourceChangeReceipt,
  sha256,
  validatePackSourceChangeReceipt,
  type PackPromotionContext,
  type PackPromotionFailureReason,
  type PackPromotionOperation,
  type PackPromotionCanonicalPack,
  type PackSourceApplicationPlan,
} from "./pack-draft-promotion.ts";
import {
  reviewPackSourceChange,
  serializePackSourceChangeReviewDecision,
  serializePackSourceChangeReviewReceipt,
  validatePackSourceChangeReviewReceipt,
  type PackSourceChangeReviewDecision,
} from "./pack-source-change-review.ts";
import {
  serializePackSourceApplicationAuthorization,
  validatePackSourceApplicationAuthorization,
  type PackSourceApplicationAuthorization,
} from "./pack-source-application-authorization.ts";

export const PACK_SOURCE_APPLICATION_SCHEMA_VERSION = 1 as const;
export const PACK_SOURCE_APPLICATION_TYPE = "visionx.pack.source-application" as const;

export type PackSourceApplicationFailureReason =
  | "invalid_pack_source_change_review"
  | "invalid_pack_application_authorization"
  | "invalid_pack_source_application_receipt"
  | "promotion_request_hash_mismatch"
  | "source_change_review_rejected"
  | "source_change_review_required"
  | "source_change_review_hash_mismatch"
  | "review_reconstruction_mismatch"
  | "application_authorization_required"
  | "application_authorization_rejected"
  | "application_authorization_hash_mismatch"
  | "application_not_authorized"
  | "source_patch_hash_mismatch"
  | "source_change_receipt_hash_mismatch"
  | "application_plan_hash_mismatch"
  | "review_decision_hash_mismatch"
  | "source_change_already_applied"
  | "source_result_mismatch"
  | PackPromotionFailureReason;

export interface PackSourceApplicationFailure {
  readonly ok: false;
  readonly reason: PackSourceApplicationFailureReason;
  readonly detail: string;
}

export interface PackSourceApplicationReceipt {
  readonly schemaVersion: 1;
  readonly applicationType: typeof PACK_SOURCE_APPLICATION_TYPE;
  readonly applicationStatus: "applied";
  readonly technicalValidation: {
    readonly ok: true;
    readonly promotionRequestVerified: true;
    readonly draftVerified: true;
    readonly proposalReconstructed: true;
    readonly planningAuthorizationVerified: true;
    readonly applicationPlanReconstructed: true;
    readonly sourceChangeReconstructed: true;
    readonly sourceChangeReviewReconstructed: true;
    readonly sourceChangeReviewApproved: true;
    readonly applicationAuthorizationVerified: true;
    readonly currentSourceStateVerified: true;
    readonly futureSourceStateVerified: true;
    readonly sourceWriteVerified: true;
    readonly receiptFinalized: true;
    readonly rollbackRequired: false;
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
    readonly sourceChangeReviewSha256: string;
    readonly applicationAuthorizationSha256: string;
  };
  readonly operation: PackPromotionOperation;
  readonly pack: PackPromotionCanonicalPack;
  readonly sourceState: {
    readonly registry: { readonly path: "definitions/registry.json"; readonly sha256: string; readonly changed: false };
    readonly packs: { readonly path: "definitions/packs.json"; readonly beforeSha256: string; readonly afterSha256: string; readonly changed: true };
    readonly channels: { readonly path: "config/channels.json"; readonly sha256: string; readonly changed: false };
  };
  readonly result: PackSourceApplicationPlan["simulatedResult"];
  readonly sourceChangesApplied: true;
}

export interface PreparePackSourceApplicationInput {
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
  readonly sourceChangeReviewValue: unknown;
  readonly sourceChangeReviewBytes: Buffer;
  readonly sourceChangeReviewSha256: string;
  readonly applicationAuthorizationValue: unknown;
  readonly applicationAuthorizationBytes: Buffer;
  readonly applicationAuthorizationSha256: string;
  readonly context: PackPromotionContext;
  readonly patchApplyCheckVerified: boolean;
}

export interface PackSourceApplicationSuccess {
  readonly ok: true;
  readonly receipt: PackSourceApplicationReceipt;
  readonly receiptBytes: Buffer;
  readonly packsAfterBytes: Buffer;
}

export type PackSourceApplicationResult = PackSourceApplicationSuccess | PackSourceApplicationFailure;

function failure(reason: PackSourceApplicationFailureReason, detail: string): PackSourceApplicationFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function success(receipt: PackSourceApplicationReceipt, packsAfterBytes: Buffer): PackSourceApplicationSuccess {
  return Object.freeze({ ok: true, receipt, receiptBytes: serializePackSourceApplicationReceipt(receipt), packsAfterBytes });
}

export function serializePackSourceApplicationReceipt(value: PackSourceApplicationReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mapPromotionFailure(reason: PackPromotionFailureReason): PackSourceApplicationFailureReason {
  return reason;
}

export function preparePackSourceApplication(input: PreparePackSourceApplicationInput): PackSourceApplicationResult {
  const checks: readonly [Buffer, string, PackSourceApplicationFailureReason, string][] = [
    [input.promotionRequestBytes, input.promotionRequestSha256, "promotion_request_hash_mismatch", "promotion request"],
    [input.draftBytes, input.draftSha256, "draft_hash_mismatch", "saved draft"],
    [input.proposalBytes, input.proposalSha256, "proposal_hash_mismatch", "Pack proposal"],
    [input.planningAuthorizationBytes, input.planningAuthorizationSha256, "planning_authorization_hash_mismatch", "planning authorization"],
    [input.applicationPlanBytes, input.applicationPlanSha256, "application_plan_hash_mismatch", "Pack application plan"],
    [input.sourcePatchBytes, input.sourcePatchSha256, "source_patch_hash_mismatch", "source patch"],
    [input.sourceChangeReceiptBytes, input.sourceChangeReceiptSha256, "source_change_receipt_hash_mismatch", "source-change receipt"],
    [input.reviewDecisionBytes, input.reviewDecisionSha256, "review_decision_hash_mismatch", "review decision"],
    [input.sourceChangeReviewBytes, input.sourceChangeReviewSha256, "source_change_review_hash_mismatch", "source-change review"],
    [input.applicationAuthorizationBytes, input.applicationAuthorizationSha256, "application_authorization_hash_mismatch", "application authorization"],
  ];
  for (const [bytes, expected, reason, label] of checks) if (sha256(bytes) !== expected) return failure(reason, `${label} SHA-256 does not match its bytes`);

  const suppliedReceiptValidation = validatePackSourceChangeReceipt(input.sourceChangeReceiptValue);
  if (!suppliedReceiptValidation.ok) return failure(suppliedReceiptValidation.reason, suppliedReceiptValidation.detail);
  const suppliedReceipt = suppliedReceiptValidation.value;
  if (input.context.packsSha256 === suppliedReceipt.sourceState.packs.afterSha256 && input.context.packsSha256 !== suppliedReceipt.sourceState.packs.beforeSha256) {
    return failure("source_change_already_applied", "Canonical Pack source already matches the reviewed post-state");
  }

  const generated = generatePackSourceChange({
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
  if (!generated.ok) return failure(mapPromotionFailure(generated.reason), generated.detail);
  if (!generated.value.patch.equals(input.sourcePatchBytes)) return failure("source_patch_hash_mismatch", "Supplied source patch differs from canonical reconstruction");
  if (!serializePackSourceChangeReceipt(generated.value.receipt).equals(input.sourceChangeReceiptBytes)) return failure("source_change_receipt_hash_mismatch", "Supplied source-change receipt differs from canonical reconstruction");
  if (!input.patchApplyCheckVerified) return failure("source_result_mismatch", "Source patch failed compatibility verification");

  const reviewValidation = validatePackSourceChangeReviewReceipt(input.sourceChangeReviewValue);
  if (!reviewValidation.ok) return failure("invalid_pack_source_change_review", reviewValidation.detail);
  const review = reviewValidation.value;
  const reconstructedReview = reviewPackSourceChange({
    promotionRequestValue: input.promotionRequestValue,
    promotionRequestBytes: input.promotionRequestBytes,
    promotionRequestSha256: input.promotionRequestSha256,
    draftBytes: input.draftBytes,
    draftSha256: input.draftSha256,
    proposalValue: input.proposalValue,
    proposalBytes: input.proposalBytes,
    proposalSha256: input.proposalSha256,
    planningAuthorizationValue: input.planningAuthorizationValue,
    planningAuthorizationBytes: input.planningAuthorizationBytes,
    planningAuthorizationSha256: input.planningAuthorizationSha256,
    applicationPlanValue: input.applicationPlanValue,
    applicationPlanBytes: input.applicationPlanBytes,
    applicationPlanSha256: input.applicationPlanSha256,
    sourcePatchBytes: input.sourcePatchBytes,
    sourcePatchSha256: input.sourcePatchSha256,
    sourceChangeReceiptValue: input.sourceChangeReceiptValue,
    sourceChangeReceiptBytes: input.sourceChangeReceiptBytes,
    sourceChangeReceiptSha256: input.sourceChangeReceiptSha256,
    reviewDecisionValue: input.reviewDecisionValue,
    reviewDecisionBytes: input.reviewDecisionBytes,
    reviewDecisionSha256: input.reviewDecisionSha256,
    context: input.context,
    patchApplyCheckVerified: true,
  });
  if (!reconstructedReview.ok) return failure("review_reconstruction_mismatch", reconstructedReview.detail);
  if (!serializePackSourceChangeReviewReceipt(reconstructedReview.receipt).equals(input.sourceChangeReviewBytes)) return failure("review_reconstruction_mismatch", "Source-change review bytes differ from canonical reconstruction");
  if (review.decision !== "approved" || review.reviewStatus !== "approved_not_authorized_for_application" || review.applicationAuthorized !== false || review.sourceChangesApplied !== false) return failure("source_change_review_rejected", "Pack source-change review is not approved");

  const authValidation = validatePackSourceApplicationAuthorization(input.applicationAuthorizationValue);
  if (!authValidation.ok) return failure(authValidation.reason, authValidation.detail);
  const authorization: PackSourceApplicationAuthorization = authValidation.value;
  if (!serializePackSourceApplicationAuthorization(authorization).equals(input.applicationAuthorizationBytes)) return failure("application_authorization_hash_mismatch", "Pack application authorization bytes are not canonical deterministic JSON");
  if (authorization.decision !== "approved") return failure("application_authorization_rejected", "Pack application authorization was rejected");
  if (authorization.packSourceChangeReviewSha256 !== input.sourceChangeReviewSha256) return failure("source_change_review_hash_mismatch", "Application authorization does not bind the supplied review");
  if (authorization.packSourceChangeReceiptSha256 !== input.sourceChangeReceiptSha256) return failure("source_change_receipt_hash_mismatch", "Application authorization does not bind the supplied source-change receipt");
  if (authorization.packApplicationPlanSha256 !== input.applicationPlanSha256) return failure("application_plan_hash_mismatch", "Application authorization does not bind the supplied Pack plan");
  if (authorization.sourcePatchSha256 !== input.sourcePatchSha256) return failure("source_patch_hash_mismatch", "Application authorization does not bind the supplied source patch");
  if (authorization.packsBeforeSha256 !== generated.value.receipt.sourceState.packs.beforeSha256 || authorization.packsAfterSha256 !== generated.value.receipt.sourceState.packs.afterSha256) return failure("application_authorization_hash_mismatch", "Application authorization does not bind the exact Pack source before/after identities");

  const receipt: PackSourceApplicationReceipt = Object.freeze({
    schemaVersion: PACK_SOURCE_APPLICATION_SCHEMA_VERSION,
    applicationType: PACK_SOURCE_APPLICATION_TYPE,
    applicationStatus: "applied",
    technicalValidation: Object.freeze({
      ok: true,
      promotionRequestVerified: true,
      draftVerified: true,
      proposalReconstructed: true,
      planningAuthorizationVerified: true,
      applicationPlanReconstructed: true,
      sourceChangeReconstructed: true,
      sourceChangeReviewReconstructed: true,
      sourceChangeReviewApproved: true,
      applicationAuthorizationVerified: true,
      currentSourceStateVerified: true,
      futureSourceStateVerified: true,
      sourceWriteVerified: true,
      receiptFinalized: true,
      rollbackRequired: false,
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
      sourceChangeReviewSha256: input.sourceChangeReviewSha256,
      applicationAuthorizationSha256: input.applicationAuthorizationSha256,
    }),
    operation: generated.value.receipt.operation,
    pack: generated.value.receipt.pack,
    sourceState: generated.value.receipt.sourceState,
    result: generated.value.receipt.simulatedResult,
    sourceChangesApplied: true,
  });
  return success(receipt, generated.value.packsAfter);
}

export function validatePackSourceApplicationReceipt(
  value: unknown,
): { readonly ok: true; readonly value: PackSourceApplicationReceipt } | PackSourceApplicationFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failure("invalid_pack_source_application_receipt", "Pack source-application receipt must be a JSON object");
  const record = value as Readonly<Record<string, unknown>>;
  if (record.schemaVersion !== 1 || record.applicationType !== PACK_SOURCE_APPLICATION_TYPE || record.applicationStatus !== "applied" || record.sourceChangesApplied !== true) return failure("invalid_pack_source_application_receipt", "Pack source-application receipt identity is invalid");
  return Object.freeze({ ok: true, value: value as PackSourceApplicationReceipt });
}

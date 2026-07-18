import { createHash } from "node:crypto";

import {
  generateAssetRegistrationSourceChange,
  type AssetRegistrationSourceChangeReceipt,
} from "./asset-registration-source-change.ts";
import {
  reviewAssetRegistrationSourceChange,
  serializeAssetRegistrationSourceChangeReviewDecision,
  serializeAssetRegistrationSourceChangeReviewReceipt,
  validateAssetRegistrationSourceChangeReviewReceipt,
  type AssetRegistrationSourceChangeReviewReceipt,
} from "./asset-registration-source-change-review.ts";
import {
  serializeAssetRegistrationSourceApplicationAuthorization,
  validateAssetRegistrationSourceApplicationAuthorization,
  type AssetRegistrationSourceApplicationAuthorization,
} from "./asset-registration-source-application-authorization.ts";

export const ASSET_REGISTRATION_SOURCE_APPLICATION_SCHEMA_VERSION = 1 as const;
export const ASSET_REGISTRATION_SOURCE_APPLICATION_TYPE = "visionx.asset-registration.source-application" as const;

export type AssetRegistrationSourceApplicationFailureReason =
  | "invalid_proposal"
  | "invalid_planning_authorization"
  | "invalid_application_plan"
  | "invalid_source_patch"
  | "invalid_source_change_receipt"
  | "invalid_source_change_review"
  | "invalid_application_authorization"
  | "unsupported_schema_version"
  | "legacy_plan_not_applicable"
  | "application_not_authorized"
  | "source_change_not_approved"
  | "application_authorization_rejected"
  | "proposal_hash_mismatch"
  | "planning_authorization_hash_mismatch"
  | "application_plan_hash_mismatch"
  | "source_patch_hash_mismatch"
  | "source_change_receipt_hash_mismatch"
  | "source_change_review_hash_mismatch"
  | "application_authorization_hash_mismatch"
  | "plan_reconstruction_mismatch"
  | "source_change_reconstruction_mismatch"
  | "review_reconstruction_mismatch"
  | "stale_registry_state"
  | "stale_pack_state"
  | "stale_asset_state"
  | "stale_channel_configuration"
  | "source_change_already_applied"
  | "unsupported_operation"
  | "source_shape_unsupported"
  | "source_serialization_failed"
  | "source_reload_failed"
  | "source_result_mismatch";

export interface AssetRegistrationSourceApplicationFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationSourceApplicationFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationSourceApplicationReceipt {
  readonly schemaVersion: 1;
  readonly applicationType: "visionx.asset-registration.source-application";
  readonly applicationStatus: "applied";
  readonly technicalValidation: {
    readonly ok: true;
    readonly proposalVerified: true;
    readonly planningAuthorizationVerified: true;
    readonly applicationPlanReconstructed: true;
    readonly sourceChangeReconstructed: true;
    readonly sourceChangeReviewVerified: true;
    readonly applicationAuthorizationVerified: true;
    readonly sourcePreStateVerified: true;
    readonly sourcePostStateVerified: true;
    readonly rollbackRequired: false;
    readonly staleStateDetected: false;
  };
  readonly inputs: {
    readonly proposalSha256: string;
    readonly planningAuthorizationSha256: string;
    readonly applicationPlanSha256: string;
    readonly sourcePatchSha256: string;
    readonly sourceChangeReceiptSha256: string;
    readonly sourceChangeReviewSha256: string;
    readonly applicationAuthorizationSha256: string;
  };
  readonly proposal: {
    readonly operation: "add" | "update_identity";
    readonly assetId: string;
    readonly channel: string;
  };
  readonly sourceState: AssetRegistrationSourceChangeReceipt["sourceState"];
  readonly appliedResult: AssetRegistrationSourceChangeReceipt["simulatedResult"];
  readonly sourceChangesApplied: true;
}

export interface PrepareAssetRegistrationSourceApplicationInput {
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
  readonly sourceChangeReview: unknown;
  readonly sourceChangeReviewBytes: Buffer;
  readonly sourceChangeReviewSha256: string;
  readonly applicationAuthorization: unknown;
  readonly applicationAuthorizationBytes: Buffer;
  readonly applicationAuthorizationSha256: string;
  readonly registryBytes: Buffer;
  readonly packsBytes: Buffer;
  readonly channelsBytes: Buffer;
  readonly patchApplyCheckVerified: boolean;
}

export interface AssetRegistrationSourceApplicationSuccess {
  readonly ok: true;
  readonly receipt: AssetRegistrationSourceApplicationReceipt;
  readonly receiptBytes: Buffer;
  readonly registryAfterBytes: Buffer;
  readonly packsAfterBytes: Buffer;
}

export type AssetRegistrationSourceApplicationResult =
  | AssetRegistrationSourceApplicationSuccess
  | AssetRegistrationSourceApplicationFailure;

function failure(reason: AssetRegistrationSourceApplicationFailureReason, detail: string): AssetRegistrationSourceApplicationFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapGeneratorFailure(reason: string): AssetRegistrationSourceApplicationFailureReason {
  if (reason === "invalid_authorization") return "invalid_planning_authorization";
  if (reason === "authorization_hash_mismatch") return "planning_authorization_hash_mismatch";
  const direct = new Set<AssetRegistrationSourceApplicationFailureReason>([
    "invalid_proposal", "invalid_application_plan", "unsupported_schema_version", "legacy_plan_not_applicable",
    "application_not_authorized", "proposal_hash_mismatch", "application_plan_hash_mismatch",
    "plan_reconstruction_mismatch", "stale_registry_state", "stale_pack_state", "stale_asset_state",
    "stale_channel_configuration", "unsupported_operation", "source_shape_unsupported",
    "source_serialization_failed", "source_reload_failed", "source_result_mismatch",
  ]);
  return direct.has(reason as AssetRegistrationSourceApplicationFailureReason)
    ? reason as AssetRegistrationSourceApplicationFailureReason
    : "source_change_reconstruction_mismatch";
}

function validateSourceChangeReceiptMinimal(value: unknown): value is AssetRegistrationSourceChangeReceipt {
  return isRecord(value) &&
    value.schemaVersion === 1 &&
    value.changeType === "visionx.asset-registration.source-change" &&
    value.generationStatus === "generated_not_applied" &&
    value.sourceChangesApplied === false &&
    isRecord(value.sourceState) &&
    isRecord(value.proposal) &&
    isRecord(value.simulatedResult);
}

export function serializeAssetRegistrationSourceApplicationReceipt(receipt: AssetRegistrationSourceApplicationReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export function prepareAssetRegistrationSourceApplication(input: PrepareAssetRegistrationSourceApplicationInput): AssetRegistrationSourceApplicationResult {
  const checks: readonly [Buffer, string, AssetRegistrationSourceApplicationFailureReason, string][] = [
    [input.proposalBytes, input.proposalSha256, "proposal_hash_mismatch", "proposal"],
    [input.planningAuthorizationBytes, input.planningAuthorizationSha256, "planning_authorization_hash_mismatch", "planning authorization"],
    [input.applicationPlanBytes, input.applicationPlanSha256, "application_plan_hash_mismatch", "application plan"],
    [input.sourcePatchBytes, input.sourcePatchSha256, "source_patch_hash_mismatch", "source patch"],
    [input.sourceChangeReceiptBytes, input.sourceChangeReceiptSha256, "source_change_receipt_hash_mismatch", "source-change receipt"],
    [input.sourceChangeReviewBytes, input.sourceChangeReviewSha256, "source_change_review_hash_mismatch", "source-change review"],
    [input.applicationAuthorizationBytes, input.applicationAuthorizationSha256, "application_authorization_hash_mismatch", "application authorization"],
  ];
  for (const [bytes, expected, reason, label] of checks) {
    if (sha256(bytes) !== expected) return failure(reason, `${label} SHA-256 does not match its bytes`);
  }

  if (!validateSourceChangeReceiptMinimal(input.sourceChangeReceipt)) return failure("invalid_source_change_receipt", "source-change receipt schema is invalid");
  const currentRegistryHash = sha256(input.registryBytes);
  const currentPacksHash = sha256(input.packsBytes);
  const registryState = input.sourceChangeReceipt.sourceState.registry;
  const packsState = input.sourceChangeReceipt.sourceState.packs;
  if (
    isRecord(registryState) && isRecord(packsState) &&
    currentRegistryHash === registryState.afterSha256 && currentPacksHash === packsState.afterSha256 &&
    (currentRegistryHash !== registryState.beforeSha256 || currentPacksHash !== packsState.beforeSha256)
  ) {
    return failure("source_change_already_applied", "canonical source files already match the source-change post-state");
  }

  const generated = generateAssetRegistrationSourceChange({
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
  if (!generated.ok) return failure(mapGeneratorFailure(generated.reason), generated.detail);
  if (!generated.patchBytes.equals(input.sourcePatchBytes) || !generated.receiptBytes.equals(input.sourceChangeReceiptBytes)) {
    return failure("source_change_reconstruction_mismatch", "source patch or source-change receipt differs from canonical reconstruction");
  }
  if (!input.patchApplyCheckVerified) return failure("source_change_reconstruction_mismatch", "source patch failed compatibility preflight");

  const reviewValidation = validateAssetRegistrationSourceChangeReviewReceipt(input.sourceChangeReview);
  if (!reviewValidation.ok) return failure("invalid_source_change_review", reviewValidation.detail);
  const review = reviewValidation.receipt;
  const decisionBytes = serializeAssetRegistrationSourceChangeReviewDecision(review.reviewDecision);
  const reconstructedReview = reviewAssetRegistrationSourceChange({
    proposal: input.proposal, proposalBytes: input.proposalBytes, proposalSha256: input.proposalSha256,
    planningAuthorization: input.planningAuthorization, planningAuthorizationBytes: input.planningAuthorizationBytes, planningAuthorizationSha256: input.planningAuthorizationSha256,
    applicationPlan: input.applicationPlan, applicationPlanBytes: input.applicationPlanBytes, applicationPlanSha256: input.applicationPlanSha256,
    sourcePatchBytes: input.sourcePatchBytes, sourcePatchSha256: input.sourcePatchSha256,
    sourceChangeReceipt: input.sourceChangeReceipt, sourceChangeReceiptBytes: input.sourceChangeReceiptBytes, sourceChangeReceiptSha256: input.sourceChangeReceiptSha256,
    reviewDecision: review.reviewDecision, reviewDecisionBytes: decisionBytes, reviewDecisionSha256: sha256(decisionBytes),
    registryBytes: input.registryBytes, packsBytes: input.packsBytes, channelsBytes: input.channelsBytes,
    patchApplyCheckVerified: true,
  });
  if (!reconstructedReview.ok) return failure("review_reconstruction_mismatch", reconstructedReview.detail);
  if (!serializeAssetRegistrationSourceChangeReviewReceipt(reconstructedReview.receipt).equals(input.sourceChangeReviewBytes)) {
    return failure("review_reconstruction_mismatch", "source-change review bytes differ from canonical reconstruction");
  }
  if (review.reviewStatus !== "approved" || review.applicationEligible !== true || review.sourceChangesApplied !== false) {
    return failure("source_change_not_approved", "source-change review is not approved for application");
  }

  const authorizationValidation = validateAssetRegistrationSourceApplicationAuthorization(input.applicationAuthorization);
  if (!authorizationValidation.ok) return failure(authorizationValidation.reason, authorizationValidation.detail);
  const applicationAuthorization: AssetRegistrationSourceApplicationAuthorization = authorizationValidation.authorization;
  if (!serializeAssetRegistrationSourceApplicationAuthorization(applicationAuthorization).equals(input.applicationAuthorizationBytes)) {
    return failure("application_authorization_hash_mismatch", "application authorization bytes are not canonical deterministic JSON");
  }
  if (applicationAuthorization.decision !== "approved") return failure("application_authorization_rejected", "application authorization decision is rejected");
  if (applicationAuthorization.sourceChangeReviewSha256 !== input.sourceChangeReviewSha256) return failure("source_change_review_hash_mismatch", "application authorization does not bind the supplied review receipt");
  if (applicationAuthorization.sourcePatchSha256 !== input.sourcePatchSha256) return failure("source_patch_hash_mismatch", "application authorization does not bind the supplied patch");
  if (applicationAuthorization.sourceChangeReceiptSha256 !== input.sourceChangeReceiptSha256) return failure("source_change_receipt_hash_mismatch", "application authorization does not bind the supplied source-change receipt");

  const receipt: AssetRegistrationSourceApplicationReceipt = Object.freeze({
    schemaVersion: ASSET_REGISTRATION_SOURCE_APPLICATION_SCHEMA_VERSION,
    applicationType: ASSET_REGISTRATION_SOURCE_APPLICATION_TYPE,
    applicationStatus: "applied",
    technicalValidation: Object.freeze({
      ok: true,
      proposalVerified: true,
      planningAuthorizationVerified: true,
      applicationPlanReconstructed: true,
      sourceChangeReconstructed: true,
      sourceChangeReviewVerified: true,
      applicationAuthorizationVerified: true,
      sourcePreStateVerified: true,
      sourcePostStateVerified: true,
      rollbackRequired: false,
      staleStateDetected: false,
    }),
    inputs: Object.freeze({
      proposalSha256: input.proposalSha256,
      planningAuthorizationSha256: input.planningAuthorizationSha256,
      applicationPlanSha256: input.applicationPlanSha256,
      sourcePatchSha256: input.sourcePatchSha256,
      sourceChangeReceiptSha256: input.sourceChangeReceiptSha256,
      sourceChangeReviewSha256: input.sourceChangeReviewSha256,
      applicationAuthorizationSha256: input.applicationAuthorizationSha256,
    }),
    proposal: Object.freeze({ ...generated.receipt.proposal }),
    sourceState: generated.receipt.sourceState,
    appliedResult: generated.receipt.simulatedResult,
    sourceChangesApplied: true,
  });
  return Object.freeze({
    ok: true,
    receipt,
    receiptBytes: serializeAssetRegistrationSourceApplicationReceipt(receipt),
    registryAfterBytes: generated.registryAfterBytes,
    packsAfterBytes: generated.packsAfterBytes,
  });
}

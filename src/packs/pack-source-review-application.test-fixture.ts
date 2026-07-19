import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serializePackDraft, type PackDraft } from "../admin/admin-types.ts";
import {
  currentPackPromotionContext,
  generatePackSourceChange,
  planPackSourceChange,
  proposePackDraftPromotion,
  serializePackDraftPromotionRequest,
  serializePackSourceApplicationPlan,
  serializePackSourceChangeReceipt,
  serializePackSourcePlanningAuthorization,
  serializePackSourceProposal,
  sha256,
  type PackDraftPromotionRequest,
  type PackSourcePlanningAuthorization,
} from "./pack-draft-promotion.ts";
import {
  reviewPackSourceChange,
  serializePackSourceChangeReviewDecision,
  type PackSourceChangeReviewDecision,
} from "./pack-source-change-review.ts";
import {
  serializePackSourceApplicationAuthorization,
  type PackSourceApplicationAuthorization,
} from "./pack-source-application-authorization.ts";
import { buildRegistry } from "../registry/registry.ts";
import { buildPacks } from "./packs.ts";

export function makePackSourceReviewApplicationFixture(
  reviewDecision: "approved" | "rejected" = "approved",
  authorizationDecision: "approved" | "rejected" = "approved",
) {
  const registryBytes = readFileSync(resolve("definitions/registry.json"));
  const packsBytes = readFileSync(resolve("definitions/packs.json"));
  const channelsBytes = readFileSync(resolve("config/channels.json"));
  const channels = JSON.parse(channelsBytes.toString("utf8")) as Record<string, unknown>;
  const registry = buildRegistry(JSON.parse(registryBytes.toString("utf8")), channels);
  const assets = registry.all();
  const packs = buildPacks(JSON.parse(packsBytes.toString("utf8")), new Set(assets.map((asset) => asset.id)), new Set(Object.keys(channels)));
  const context = currentPackPromotionContext({ assets, packs, channels, registryBytes, packsBytes, channelsBytes });
  const draft: PackDraft = Object.freeze({
    schemaVersion: 1,
    draftType: "visionx.pack-draft",
    id: "qa-pack",
    displayName: "QA Pack",
    description: "A non-live Pack draft used for administration verification.",
    assetIds: Object.freeze(["gold", "aapl", "btc"]),
    revision: 2,
  });
  const draftBytes = serializePackDraft(draft);
  const request: PackDraftPromotionRequest = Object.freeze({
    schemaVersion: 1,
    requestType: "visionx.pack-draft-promotion-request",
    operation: "create_pack",
    draftId: "qa-pack",
    expectedRevision: 2,
    channel: "stocks",
    curatorId: "visionx-curator",
    decidedAt: "2026-07-19T01:00:00Z",
    referenceId: "visionx.pack-draft-promotion.qa-pack-v1",
    notes: "Prepare the exact saved draft as a reviewable Pack source proposal.",
  });
  const requestBytes = serializePackDraftPromotionRequest(request);
  const proposed = proposePackDraftPromotion({ requestValue: request, requestBytes, draftBytes, context });
  if (!proposed.ok) throw new Error(`${proposed.reason}: ${proposed.detail}`);
  const proposal = proposed.value;
  const proposalBytes = serializePackSourceProposal(proposal);
  const planningAuthorization: PackSourcePlanningAuthorization = Object.freeze({
    schemaVersion: 1,
    decision: "approved",
    packProposalSha256: sha256(proposalBytes),
    draftSha256: sha256(draftBytes),
    promotionRequestSha256: sha256(requestBytes),
    curatorId: "visionx-curator",
    decidedAt: "2026-07-19T01:15:00Z",
    referenceId: "visionx.pack-source-planning.qa-pack-v1",
    notes: "Authorize deterministic planning only.",
  });
  const planningAuthorizationBytes = serializePackSourcePlanningAuthorization(planningAuthorization);
  const planned = planPackSourceChange({ requestValue: request, requestBytes, draftBytes, proposalValue: proposal, proposalBytes, authorizationValue: planningAuthorization, authorizationBytes: planningAuthorizationBytes, context });
  if (!planned.ok) throw new Error(`${planned.reason}: ${planned.detail}`);
  const plan = planned.value;
  const planBytes = serializePackSourceApplicationPlan(plan);
  const generated = generatePackSourceChange({ requestValue: request, requestBytes, draftBytes, proposalValue: proposal, proposalBytes, authorizationValue: planningAuthorization, authorizationBytes: planningAuthorizationBytes, planValue: plan, planBytes, context });
  if (!generated.ok) throw new Error(`${generated.reason}: ${generated.detail}`);
  const sourceChangeReceiptBytes = serializePackSourceChangeReceipt(generated.value.receipt);
  const decision: PackSourceChangeReviewDecision = Object.freeze({
    schemaVersion: 1,
    decisionType: "visionx.pack-source-change-review-decision",
    decision: reviewDecision,
    reviewerId: "visionx-pack-reviewer",
    decidedAt: "2026-07-19T02:00:00Z",
    referenceId: `visionx.pack-source-review.qa-pack-${reviewDecision}-v1`,
    notes: reviewDecision === "approved"
      ? "Approve the exact generated Pack source change for a later, separately authorized application."
      : "Reject the exact generated Pack source change for review-path verification.",
  });
  const decisionBytes = serializePackSourceChangeReviewDecision(decision);
  const reviewed = reviewPackSourceChange({
    promotionRequestValue: request, promotionRequestBytes: requestBytes, promotionRequestSha256: sha256(requestBytes),
    draftBytes, draftSha256: sha256(draftBytes),
    proposalValue: proposal, proposalBytes, proposalSha256: sha256(proposalBytes),
    planningAuthorizationValue: planningAuthorization, planningAuthorizationBytes, planningAuthorizationSha256: sha256(planningAuthorizationBytes),
    applicationPlanValue: plan, applicationPlanBytes: planBytes, applicationPlanSha256: sha256(planBytes),
    sourcePatchBytes: generated.value.patch, sourcePatchSha256: sha256(generated.value.patch),
    sourceChangeReceiptValue: generated.value.receipt, sourceChangeReceiptBytes, sourceChangeReceiptSha256: sha256(sourceChangeReceiptBytes),
    reviewDecisionValue: decision, reviewDecisionBytes: decisionBytes, reviewDecisionSha256: sha256(decisionBytes),
    context, patchApplyCheckVerified: true,
  });
  if (!reviewed.ok) throw new Error(`${reviewed.reason}: ${reviewed.detail}`);
  const authorization: PackSourceApplicationAuthorization = Object.freeze({
    schemaVersion: 1,
    authorizationType: "visionx.pack-source-application-authorization",
    decision: authorizationDecision,
    packSourceChangeReviewSha256: sha256(reviewed.receiptBytes),
    packSourceChangeReceiptSha256: sha256(sourceChangeReceiptBytes),
    packApplicationPlanSha256: sha256(planBytes),
    sourcePatchSha256: sha256(generated.value.patch),
    packsBeforeSha256: generated.value.receipt.sourceState.packs.beforeSha256,
    packsAfterSha256: generated.value.receipt.sourceState.packs.afterSha256,
    authorizerId: "visionx-pack-application-authorizer",
    decidedAt: "2026-07-19T02:15:00Z",
    referenceId: `visionx.pack-source-application.qa-pack-${authorizationDecision}-v1`,
    notes: authorizationDecision === "approved"
      ? "Authorize one exact atomic application of the reviewed Pack source change."
      : "Reject atomic application for authorization-path verification.",
  });
  const authorizationBytes = serializePackSourceApplicationAuthorization(authorization);
  return Object.freeze({
    registryBytes, packsBytes, channelsBytes, channels, registry, packs, context,
    draft, draftBytes, request, requestBytes, proposal, proposalBytes,
    planningAuthorization, planningAuthorizationBytes, plan, planBytes,
    generated: generated.value, sourceChangeReceiptBytes,
    reviewDecision: decision, reviewDecisionBytes: decisionBytes,
    review: reviewed.receipt, reviewBytes: reviewed.receiptBytes,
    applicationAuthorization: authorization, applicationAuthorizationBytes: authorizationBytes,
  });
}

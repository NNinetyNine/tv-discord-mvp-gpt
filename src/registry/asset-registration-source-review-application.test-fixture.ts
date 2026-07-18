import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildPacks } from "../packs/packs.ts";
import { buildRegistry } from "./registry.ts";
import { planAssetRegistrationApplication, serializeAssetRegistrationApplicationPlan } from "./asset-registration-application-plan.ts";
import { serializeAssetRegistrationApplicationAuthorization, type AssetRegistrationApplicationAuthorization } from "./asset-registration-application-authorization.ts";
import { proposeAssetRegistration, serializeAssetRegistrationProposal } from "./asset-registration-proposal.ts";
import { generateAssetRegistrationSourceChange } from "./asset-registration-source-change.ts";
import { reviewAssetRegistrationSourceChange, serializeAssetRegistrationSourceChangeReviewDecision, type AssetRegistrationSourceChangeReviewDecision } from "./asset-registration-source-change-review.ts";
import { serializeAssetRegistrationSourceApplicationAuthorization, type AssetRegistrationSourceApplicationAuthorization } from "./asset-registration-source-application-authorization.ts";

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function makeSourceReviewApplicationFixture(decision: "approved" | "rejected" = "approved") {
  const registryBytes = readFileSync(resolve("definitions/registry.json"));
  const packsBytes = readFileSync(resolve("definitions/packs.json"));
  const channelsBytes = readFileSync(resolve("config/channels.json"));
  const channels = JSON.parse(channelsBytes.toString("utf8")) as Record<string, unknown>;
  const registry = buildRegistry(JSON.parse(registryBytes.toString("utf8")) as Parameters<typeof buildRegistry>[0], channels);
  const packs = buildPacks(JSON.parse(packsBytes.toString("utf8")) as unknown, new Set(registry.all().map((asset) => asset.id)), new Set(Object.keys(channels)));
  const proposed = proposeAssetRegistration({
    schemaVersion: 2,
    operation: "add",
    asset: {
      id: "source_review_application_test_asset",
      displayName: "Source Review Application Test Asset",
      symbol: "SRATEST",
      market: "NASDAQ",
      tradingViewSymbol: "NASDAQ:SRATEST",
      currency: "USD",
      channel: "stocks",
    },
    targetPackIds: [],
    decision: {
      reviewerId: "visionx-curator",
      decidedAt: "2026-07-17T22:30:00Z",
      referenceId: "visionx.asset-registration.source-review-application-test-v2",
    },
  }, registry.all(), packs, channels);
  if (!proposed.ok) throw new Error(proposed.detail);
  const proposal = proposed.proposal;
  const proposalBytes = serializeAssetRegistrationProposal(proposal);
  const planningAuthorization: AssetRegistrationApplicationAuthorization = Object.freeze({
    schemaVersion: 1,
    decision: "approved",
    proposalSha256: sha256(proposalBytes),
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-18T00:30:00Z",
    referenceId: "visionx.asset-application.source-review-application-test-v2",
    packPlacements: Object.freeze([]),
  });
  const planningAuthorizationBytes = serializeAssetRegistrationApplicationAuthorization(planningAuthorization);
  const planned = planAssetRegistrationApplication({
    proposal,
    proposalSha256: sha256(proposalBytes),
    authorization: planningAuthorization,
    authorizationSha256: sha256(planningAuthorizationBytes),
    assets: registry.all(), packs, channels,
  });
  if (!planned.ok) throw new Error(planned.detail);
  const plan = planned.plan;
  const planBytes = serializeAssetRegistrationApplicationPlan(plan);
  const sourceChange = generateAssetRegistrationSourceChange({
    proposal, proposalBytes, proposalSha256: sha256(proposalBytes),
    authorization: planningAuthorization, authorizationBytes: planningAuthorizationBytes, authorizationSha256: sha256(planningAuthorizationBytes),
    applicationPlan: plan, applicationPlanBytes: planBytes, applicationPlanSha256: sha256(planBytes),
    registryBytes, packsBytes, channelsBytes,
  });
  if (!sourceChange.ok) throw new Error(sourceChange.detail);
  const reviewDecision: AssetRegistrationSourceChangeReviewDecision = Object.freeze({
    schemaVersion: 1,
    decision,
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-18T01:00:00Z",
    referenceId: `visionx.asset-source-change-review.source-review-application-test-${decision}-v1`,
    notes: `${decision} source-change review test.`,
  });
  const reviewDecisionBytes = serializeAssetRegistrationSourceChangeReviewDecision(reviewDecision);
  const reviewed = reviewAssetRegistrationSourceChange({
    proposal, proposalBytes, proposalSha256: sha256(proposalBytes),
    planningAuthorization, planningAuthorizationBytes, planningAuthorizationSha256: sha256(planningAuthorizationBytes),
    applicationPlan: plan, applicationPlanBytes: planBytes, applicationPlanSha256: sha256(planBytes),
    sourcePatchBytes: sourceChange.patchBytes, sourcePatchSha256: sha256(sourceChange.patchBytes),
    sourceChangeReceipt: sourceChange.receipt, sourceChangeReceiptBytes: sourceChange.receiptBytes, sourceChangeReceiptSha256: sha256(sourceChange.receiptBytes),
    reviewDecision, reviewDecisionBytes, reviewDecisionSha256: sha256(reviewDecisionBytes),
    registryBytes, packsBytes, channelsBytes,
    patchApplyCheckVerified: true,
  });
  if (!reviewed.ok) throw new Error(reviewed.detail);
  const applicationAuthorization: AssetRegistrationSourceApplicationAuthorization = Object.freeze({
    schemaVersion: 1,
    decision: "approved",
    sourceChangeReviewSha256: sha256(reviewed.receiptBytes),
    sourcePatchSha256: sha256(sourceChange.patchBytes),
    sourceChangeReceiptSha256: sha256(sourceChange.receiptBytes),
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-18T01:15:00Z",
    referenceId: "visionx.asset-source-application.source-review-application-test-v1",
  });
  const applicationAuthorizationBytes = serializeAssetRegistrationSourceApplicationAuthorization(applicationAuthorization);
  return Object.freeze({
    registryBytes, packsBytes, channelsBytes, channels, registry, packs,
    proposal, proposalBytes,
    planningAuthorization, planningAuthorizationBytes,
    plan, planBytes,
    sourceChange,
    reviewDecision, reviewDecisionBytes,
    review: reviewed.receipt, reviewBytes: reviewed.receiptBytes,
    applicationAuthorization, applicationAuthorizationBytes,
  });
}

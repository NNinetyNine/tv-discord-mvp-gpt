import { describe, expect, test } from "vitest";

import {
  reviewAssetRegistrationSourceChange,
  serializeAssetRegistrationSourceChangeReviewDecision,
  serializeAssetRegistrationSourceChangeReviewReceipt,
  validateAssetRegistrationSourceChangeReviewDecision,
  validateAssetRegistrationSourceChangeReviewReceipt,
} from "./asset-registration-source-change-review.ts";
import { makeSourceReviewApplicationFixture, sha256 } from "./asset-registration-source-review-application.test-fixture.ts";

function reviewInput(fixture = makeSourceReviewApplicationFixture()) {
  return {
    proposal: fixture.proposal,
    proposalBytes: fixture.proposalBytes,
    proposalSha256: sha256(fixture.proposalBytes),
    planningAuthorization: fixture.planningAuthorization,
    planningAuthorizationBytes: fixture.planningAuthorizationBytes,
    planningAuthorizationSha256: sha256(fixture.planningAuthorizationBytes),
    applicationPlan: fixture.plan,
    applicationPlanBytes: fixture.planBytes,
    applicationPlanSha256: sha256(fixture.planBytes),
    sourcePatchBytes: fixture.sourceChange.patchBytes,
    sourcePatchSha256: sha256(fixture.sourceChange.patchBytes),
    sourceChangeReceipt: fixture.sourceChange.receipt,
    sourceChangeReceiptBytes: fixture.sourceChange.receiptBytes,
    sourceChangeReceiptSha256: sha256(fixture.sourceChange.receiptBytes),
    reviewDecision: fixture.reviewDecision,
    reviewDecisionBytes: fixture.reviewDecisionBytes,
    reviewDecisionSha256: sha256(fixture.reviewDecisionBytes),
    registryBytes: fixture.registryBytes,
    packsBytes: fixture.packsBytes,
    channelsBytes: fixture.channelsBytes,
    patchApplyCheckVerified: true,
  };
}

describe("Asset registration source-change review", () => {
  test("approved and rejected decisions produce technically valid deterministic receipts", () => {
    const approvedFixture = makeSourceReviewApplicationFixture("approved");
    const approved = reviewAssetRegistrationSourceChange(reviewInput(approvedFixture));
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.receipt).toMatchObject({ reviewStatus: "approved", applicationEligible: true, sourceChangesApplied: false });
    expect(approved.receipt.technicalValidation).toMatchObject({ sourceChangeReconstructed: true, sourcePatchBytesVerified: true, futureStateVerified: true });
    expect(serializeAssetRegistrationSourceChangeReviewReceipt(approved.receipt).equals(approved.receiptBytes)).toBe(true);

    const rejectedFixture = makeSourceReviewApplicationFixture("rejected");
    const rejected = reviewAssetRegistrationSourceChange(reviewInput(rejectedFixture));
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.receipt).toMatchObject({ reviewStatus: "rejected", applicationEligible: false, sourceChangesApplied: false });
  });

  test("identical inputs produce identical receipt bytes", () => {
    const fixture = makeSourceReviewApplicationFixture();
    const first = reviewAssetRegistrationSourceChange(reviewInput(fixture));
    const second = reviewAssetRegistrationSourceChange(reviewInput(fixture));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.receiptBytes.equals(second.receiptBytes)).toBe(true);
  });

  test.each([
    ["proposalBytes", "proposal_hash_mismatch"],
    ["planningAuthorizationBytes", "planning_authorization_hash_mismatch"],
    ["applicationPlanBytes", "application_plan_hash_mismatch"],
    ["sourcePatchBytes", "source_patch_hash_mismatch"],
    ["sourceChangeReceiptBytes", "source_change_receipt_hash_mismatch"],
  ] as const)("altered %s fails", (field, reason) => {
    const input = reviewInput();
    const result = reviewAssetRegistrationSourceChange({ ...input, [field]: Buffer.concat([input[field], Buffer.from(" ")]) });
    expect(result).toMatchObject({ ok: false, reason });
  });

  test("canonical reconstruction rejects altered patch and receipt even with matching hashes", () => {
    const input = reviewInput();
    const patch = Buffer.concat([input.sourcePatchBytes, Buffer.from("\n")]);
    const patchResult = reviewAssetRegistrationSourceChange({ ...input, sourcePatchBytes: patch, sourcePatchSha256: sha256(patch) });
    expect(patchResult).toMatchObject({ ok: false, reason: "source_change_reconstruction_mismatch" });

    const receipt = Buffer.from(input.sourceChangeReceiptBytes.toString("utf8").replace('"generated_not_applied"', '"altered"'));
    const receiptResult = reviewAssetRegistrationSourceChange({
      ...input,
      sourceChangeReceipt: JSON.parse(receipt.toString("utf8")) as unknown,
      sourceChangeReceiptBytes: receipt,
      sourceChangeReceiptSha256: sha256(receipt),
    });
    expect(receiptResult).toMatchObject({ ok: false, reason: "invalid_source_change_receipt" });
  });

  test("patch preflight is required", () => {
    expect(reviewAssetRegistrationSourceChange({ ...reviewInput(), patchApplyCheckVerified: false })).toMatchObject({ ok: false, reason: "patch_verification_failed" });
  });

  test.each([
    [{}, "invalid_review_decision"],
    [{ schemaVersion: 2, decision: "approved", reviewerId: "x", decidedAt: "2026-07-18T01:00:00Z", referenceId: "r" }, "unsupported_schema_version"],
    [{ schemaVersion: 1, decision: "approved", reviewerId: " x", decidedAt: "2026-07-18T01:00:00Z", referenceId: "r" }, "invalid_review_decision"],
    [{ schemaVersion: 1, decision: "approved", reviewerId: "x", decidedAt: "2026-07-18T01:00:00", referenceId: "r" }, "invalid_review_decision"],
  ] as const)("strict review-decision validation", (value, reason) => {
    expect(validateAssetRegistrationSourceChangeReviewDecision(value)).toMatchObject({ ok: false, reason });
  });

  test("receipt validator accepts only canonical decision/status agreement", () => {
    const fixture = makeSourceReviewApplicationFixture();
    expect(validateAssetRegistrationSourceChangeReviewReceipt(fixture.review)).toMatchObject({ ok: true });
    expect(validateAssetRegistrationSourceChangeReviewReceipt({ ...fixture.review, applicationEligible: false })).toMatchObject({ ok: false });
    expect(serializeAssetRegistrationSourceChangeReviewDecision(fixture.reviewDecision).equals(fixture.reviewDecisionBytes)).toBe(true);
  });

  test("receipt contains no absolute paths or numeric Discord destination", () => {
    const fixture = makeSourceReviewApplicationFixture();
    const text = fixture.reviewBytes.toString("utf8");
    expect(text).not.toContain(process.cwd());
    expect(text).not.toContain("1527846988270534827");
  });
});

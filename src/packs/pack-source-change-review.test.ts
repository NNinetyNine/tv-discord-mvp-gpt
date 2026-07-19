import { describe, expect, it } from "vitest";

import { sha256 } from "./pack-draft-promotion.ts";
import {
  reviewPackSourceChange,
  serializePackSourceChangeReviewDecision,
  serializePackSourceChangeReviewReceipt,
  validatePackSourceChangeReviewDecision,
  validatePackSourceChangeReviewReceipt,
} from "./pack-source-change-review.ts";
import { makePackSourceReviewApplicationFixture } from "./pack-source-review-application.test-fixture.ts";

function reviewInput(decision: "approved" | "rejected" = "approved") {
  const f = makePackSourceReviewApplicationFixture(decision);
  return {
    fixture: f,
    input: {
      promotionRequestValue: f.request, promotionRequestBytes: f.requestBytes, promotionRequestSha256: sha256(f.requestBytes),
      draftBytes: f.draftBytes, draftSha256: sha256(f.draftBytes),
      proposalValue: f.proposal, proposalBytes: f.proposalBytes, proposalSha256: sha256(f.proposalBytes),
      planningAuthorizationValue: f.planningAuthorization, planningAuthorizationBytes: f.planningAuthorizationBytes, planningAuthorizationSha256: sha256(f.planningAuthorizationBytes),
      applicationPlanValue: f.plan, applicationPlanBytes: f.planBytes, applicationPlanSha256: sha256(f.planBytes),
      sourcePatchBytes: f.generated.patch, sourcePatchSha256: sha256(f.generated.patch),
      sourceChangeReceiptValue: f.generated.receipt, sourceChangeReceiptBytes: f.sourceChangeReceiptBytes, sourceChangeReceiptSha256: sha256(f.sourceChangeReceiptBytes),
      reviewDecisionValue: f.reviewDecision, reviewDecisionBytes: f.reviewDecisionBytes, reviewDecisionSha256: sha256(f.reviewDecisionBytes),
      context: f.context, patchApplyCheckVerified: true,
    },
  };
}

describe("Pack source-change review", () => {
  it("strictly validates review decisions", () => {
    const { fixture } = reviewInput();
    expect(validatePackSourceChangeReviewDecision(fixture.reviewDecision)).toMatchObject({ ok: true });
    expect(validatePackSourceChangeReviewDecision({ ...fixture.reviewDecision, unexpected: true })).toMatchObject({ ok: false, reason: "invalid_review_decision" });
    expect(validatePackSourceChangeReviewDecision({ ...fixture.reviewDecision, schemaVersion: 2 })).toMatchObject({ ok: false, reason: "unsupported_schema_version" });
    expect(validatePackSourceChangeReviewDecision({ ...fixture.reviewDecision, decidedAt: "2026-07-19T02:00:00" })).toMatchObject({ ok: false, reason: "invalid_review_decision" });
  });

  it("produces an approved review without application authority", () => {
    const { input } = reviewInput("approved");
    const result = reviewPackSourceChange(input);
    expect(result).toMatchObject({ ok: true, receipt: { decision: "approved", reviewStatus: "approved_not_authorized_for_application", applicationAuthorized: false, sourceChangesApplied: false } });
    if (result.ok) expect(validatePackSourceChangeReviewReceipt(result.receipt)).toMatchObject({ ok: true });
  });

  it("produces a technically valid rejected review", () => {
    const { input } = reviewInput("rejected");
    expect(reviewPackSourceChange(input)).toMatchObject({ ok: true, receipt: { decision: "rejected", reviewStatus: "rejected", applicationAuthorized: false } });
  });

  it("binds every exact upstream artifact hash", () => {
    const { fixture, input } = reviewInput();
    const result = reviewPackSourceChange(input);
    expect(result).toMatchObject({ ok: true, receipt: { inputs: {
      promotionRequestSha256: sha256(fixture.requestBytes), draftSha256: sha256(fixture.draftBytes), packProposalSha256: sha256(fixture.proposalBytes),
      planningAuthorizationSha256: sha256(fixture.planningAuthorizationBytes), applicationPlanSha256: sha256(fixture.planBytes), sourcePatchSha256: sha256(fixture.generated.patch),
      sourceChangeReceiptSha256: sha256(fixture.sourceChangeReceiptBytes), reviewDecisionSha256: sha256(fixture.reviewDecisionBytes),
    } } });
  });

  it.each([
    ["promotion request", "promotionRequestBytes", "promotion_request_hash_mismatch"],
    ["draft", "draftBytes", "draft_hash_mismatch"],
    ["proposal", "proposalBytes", "proposal_hash_mismatch"],
    ["planning authorization", "planningAuthorizationBytes", "planning_authorization_hash_mismatch"],
    ["plan", "applicationPlanBytes", "application_plan_hash_mismatch"],
    ["patch", "sourcePatchBytes", "source_patch_hash_mismatch"],
    ["source-change receipt", "sourceChangeReceiptBytes", "source_change_receipt_hash_mismatch"],
    ["review decision", "reviewDecisionBytes", "review_decision_hash_mismatch"],
  ] as const)("rejects altered %s bytes", (_label, key, reason) => {
    const { input } = reviewInput();
    const altered = { ...input, [key]: Buffer.concat([input[key], Buffer.from("x")]) };
    expect(reviewPackSourceChange(altered)).toMatchObject({ ok: false, reason });
  });

  it("requires patch compatibility verification", () => {
    const { input } = reviewInput();
    expect(reviewPackSourceChange({ ...input, patchApplyCheckVerified: false })).toMatchObject({ ok: false, reason: "patch_verification_failed" });
  });

  it("is deterministic and path neutral at the domain boundary", () => {
    const first = reviewInput().input; const second = reviewInput().input;
    const a = reviewPackSourceChange(first); const b = reviewPackSourceChange(second);
    expect(a.ok && b.ok && a.receiptBytes.equals(b.receiptBytes)).toBe(true);
    if (a.ok) {
      expect(a.receiptBytes.at(-1)).toBe(10);
      expect(serializePackSourceChangeReviewReceipt(a.receipt).equals(a.receiptBytes)).toBe(true);
      expect(serializePackSourceChangeReviewDecision(first.reviewDecisionValue as never).at(-1)).toBe(10);
    }
  });
});

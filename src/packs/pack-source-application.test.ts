import { describe, expect, it } from "vitest";

import { sha256 } from "./pack-draft-promotion.ts";
import { preparePackSourceApplication, serializePackSourceApplicationReceipt } from "./pack-source-application.ts";
import { validatePackSourceApplicationAuthorization } from "./pack-source-application-authorization.ts";
import { makePackSourceReviewApplicationFixture } from "./pack-source-review-application.test-fixture.ts";

function applicationInput(reviewDecision: "approved" | "rejected" = "approved", authorizationDecision: "approved" | "rejected" = "approved") {
  const f = makePackSourceReviewApplicationFixture(reviewDecision, authorizationDecision);
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
      sourceChangeReviewValue: f.review, sourceChangeReviewBytes: f.reviewBytes, sourceChangeReviewSha256: sha256(f.reviewBytes),
      applicationAuthorizationValue: f.applicationAuthorization, applicationAuthorizationBytes: f.applicationAuthorizationBytes, applicationAuthorizationSha256: sha256(f.applicationAuthorizationBytes),
      context: f.context, patchApplyCheckVerified: true,
    },
  };
}

describe("Pack source application domain", () => {
  it("strictly validates the separate application authorization", () => {
    const { fixture } = applicationInput();
    expect(validatePackSourceApplicationAuthorization(fixture.applicationAuthorization)).toMatchObject({ ok: true });
    expect(validatePackSourceApplicationAuthorization({ ...fixture.applicationAuthorization, unexpected: true })).toMatchObject({ ok: false, reason: "invalid_pack_application_authorization" });
    expect(validatePackSourceApplicationAuthorization({ ...fixture.applicationAuthorization, schemaVersion: 2 })).toMatchObject({ ok: false, reason: "unsupported_schema_version" });
  });

  it("requires an approved review and approved authorization", () => {
    expect(preparePackSourceApplication(applicationInput("rejected", "approved").input)).toMatchObject({ ok: false, reason: "source_change_review_rejected" });
    expect(preparePackSourceApplication(applicationInput("approved", "rejected").input)).toMatchObject({ ok: false, reason: "application_authorization_rejected" });
  });

  it("reconstructs the chain and derives exact future Pack bytes", () => {
    const { fixture, input } = applicationInput();
    const result = preparePackSourceApplication(input);
    expect(result).toMatchObject({ ok: true, receipt: { applicationStatus: "applied", sourceChangesApplied: true, operation: "create_pack", pack: { id: "qa-pack", display: "QA Pack", channel: "stocks", assetIds: ["gold", "aapl", "btc"] } } });
    if (result.ok) {
      expect(result.packsAfterBytes.equals(fixture.generated.packsAfter)).toBe(true);
      expect(serializePackSourceApplicationReceipt(result.receipt).equals(result.receiptBytes)).toBe(true);
    }
  });

  it("binds review, receipt, plan, patch, and before/after Pack hashes", () => {
    const { input } = applicationInput();
    const altered = { ...input, applicationAuthorizationValue: { ...(input.applicationAuthorizationValue as unknown as Record<string, unknown>), sourcePatchSha256: "0".repeat(64) } };
    expect(preparePackSourceApplication(altered)).toMatchObject({ ok: false, reason: "application_authorization_hash_mismatch" });
  });

  it("rejects arbitrary patch or review bytes", () => {
    const { input } = applicationInput();
    expect(preparePackSourceApplication({ ...input, sourcePatchBytes: Buffer.concat([input.sourcePatchBytes, Buffer.from("x")]) })).toMatchObject({ ok: false, reason: "source_patch_hash_mismatch" });
    expect(preparePackSourceApplication({ ...input, sourceChangeReviewBytes: Buffer.concat([input.sourceChangeReviewBytes, Buffer.from("x")]) })).toMatchObject({ ok: false, reason: "source_change_review_hash_mismatch" });
  });

  it("fails closed on replay when current Packs equal the expected post-state", () => {
    const { fixture, input } = applicationInput();
    const postContext = { ...input.context, packsBytes: fixture.generated.packsAfter, packsSha256: sha256(fixture.generated.packsAfter) };
    expect(preparePackSourceApplication({ ...input, context: postContext })).toMatchObject({ ok: false, reason: "source_change_already_applied" });
  });

  it("produces deterministic path-neutral receipt bytes", () => {
    const a = preparePackSourceApplication(applicationInput().input); const b = preparePackSourceApplication(applicationInput().input);
    expect(a.ok && b.ok && a.receiptBytes.equals(b.receiptBytes)).toBe(true);
    if (a.ok) expect(a.receiptBytes.at(-1)).toBe(10);
  });
});

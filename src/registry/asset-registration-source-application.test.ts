import { describe, expect, test } from "vitest";

import {
  prepareAssetRegistrationSourceApplication,
  serializeAssetRegistrationSourceApplicationReceipt,
} from "./asset-registration-source-application.ts";
import {
  serializeAssetRegistrationSourceApplicationAuthorization,
  validateAssetRegistrationSourceApplicationAuthorization,
} from "./asset-registration-source-application-authorization.ts";
import { makeSourceReviewApplicationFixture, sha256 } from "./asset-registration-source-review-application.test-fixture.ts";

function applicationInput(fixture = makeSourceReviewApplicationFixture()) {
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
    sourceChangeReview: fixture.review,
    sourceChangeReviewBytes: fixture.reviewBytes,
    sourceChangeReviewSha256: sha256(fixture.reviewBytes),
    applicationAuthorization: fixture.applicationAuthorization,
    applicationAuthorizationBytes: fixture.applicationAuthorizationBytes,
    applicationAuthorizationSha256: sha256(fixture.applicationAuthorizationBytes),
    registryBytes: fixture.registryBytes,
    packsBytes: fixture.packsBytes,
    channelsBytes: fixture.channelsBytes,
    patchApplyCheckVerified: true,
  };
}

describe("Asset registration source application", () => {
  test("approved review plus separate approved authorization prepares exact future bytes", () => {
    const fixture = makeSourceReviewApplicationFixture();
    const result = prepareAssetRegistrationSourceApplication(applicationInput(fixture));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({ applicationStatus: "applied", sourceChangesApplied: true });
    expect(result.receipt.technicalValidation).toMatchObject({ sourceChangeReviewVerified: true, applicationAuthorizationVerified: true, sourcePostStateVerified: true });
    expect(result.registryAfterBytes.equals(fixture.sourceChange.registryAfterBytes)).toBe(true);
    expect(result.packsAfterBytes.equals(fixture.packsBytes)).toBe(true);
    expect(serializeAssetRegistrationSourceApplicationReceipt(result.receipt).equals(result.receiptBytes)).toBe(true);
  });

  test("review approval alone is insufficient", () => {
    const input = applicationInput();
    const rejected = { ...input.applicationAuthorization, decision: "rejected" as const };
    const bytes = serializeAssetRegistrationSourceApplicationAuthorization(rejected);
    expect(prepareAssetRegistrationSourceApplication({
      ...input,
      applicationAuthorization: rejected,
      applicationAuthorizationBytes: bytes,
      applicationAuthorizationSha256: sha256(bytes),
    })).toMatchObject({ ok: false, reason: "application_authorization_rejected" });
  });

  test("rejected source-change review cannot be applied", () => {
    const fixture = makeSourceReviewApplicationFixture("rejected");
    const authorization = {
      ...fixture.applicationAuthorization,
      sourceChangeReviewSha256: sha256(fixture.reviewBytes),
    };
    const bytes = serializeAssetRegistrationSourceApplicationAuthorization(authorization);
    expect(prepareAssetRegistrationSourceApplication({
      ...applicationInput(fixture),
      applicationAuthorization: authorization,
      applicationAuthorizationBytes: bytes,
      applicationAuthorizationSha256: sha256(bytes),
    })).toMatchObject({ ok: false, reason: "source_change_not_approved" });
  });

  test.each([
    ["sourceChangeReviewSha256", "source_change_review_hash_mismatch"],
    ["sourcePatchSha256", "source_patch_hash_mismatch"],
    ["sourceChangeReceiptSha256", "source_change_receipt_hash_mismatch"],
  ] as const)("application authorization binds exact %s", (field, reason) => {
    const input = applicationInput();
    const altered = { ...input.applicationAuthorization, [field]: "0".repeat(64) };
    const bytes = serializeAssetRegistrationSourceApplicationAuthorization(altered);
    expect(prepareAssetRegistrationSourceApplication({
      ...input,
      applicationAuthorization: altered,
      applicationAuthorizationBytes: bytes,
      applicationAuthorizationSha256: sha256(bytes),
    })).toMatchObject({ ok: false, reason });
  });

  test("altered review bytes fail canonical review reconstruction", () => {
    const input = applicationInput();
    const alteredObject = { ...input.sourceChangeReview, reviewStatus: "rejected", applicationEligible: false };
    const bytes = Buffer.from(`${JSON.stringify(alteredObject, null, 2)}\n`);
    expect(prepareAssetRegistrationSourceApplication({
      ...input,
      sourceChangeReview: alteredObject,
      sourceChangeReviewBytes: bytes,
      sourceChangeReviewSha256: sha256(bytes),
    })).toMatchObject({ ok: false });
  });

  test("post-state replay fails with source_change_already_applied", () => {
    const fixture = makeSourceReviewApplicationFixture();
    expect(prepareAssetRegistrationSourceApplication({
      ...applicationInput(fixture),
      registryBytes: fixture.sourceChange.registryAfterBytes,
      packsBytes: fixture.sourceChange.packsAfterBytes,
    })).toMatchObject({ ok: false, reason: "source_change_already_applied" });
  });

  test("identical approved inputs produce identical receipt bytes", () => {
    const input = applicationInput();
    const first = prepareAssetRegistrationSourceApplication(input);
    const second = prepareAssetRegistrationSourceApplication(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.receiptBytes.equals(second.receiptBytes)).toBe(true);
  });

  test("strict application-authorization validation", () => {
    const fixture = makeSourceReviewApplicationFixture();
    expect(validateAssetRegistrationSourceApplicationAuthorization(fixture.applicationAuthorization)).toMatchObject({ ok: true });
    expect(validateAssetRegistrationSourceApplicationAuthorization({ ...fixture.applicationAuthorization, extra: true })).toMatchObject({ ok: false });
    expect(validateAssetRegistrationSourceApplicationAuthorization({ ...fixture.applicationAuthorization, decidedAt: "2026-07-18T01:15:00" })).toMatchObject({ ok: false });
    expect(validateAssetRegistrationSourceApplicationAuthorization({ ...fixture.applicationAuthorization, sourcePatchSha256: "ABC" })).toMatchObject({ ok: false });
  });

  test("application receipt excludes absolute paths and numeric Discord IDs", () => {
    const result = prepareAssetRegistrationSourceApplication(applicationInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.receiptBytes.toString("utf8");
    expect(text).not.toContain(process.cwd());
    expect(text).not.toContain("1527846988270534827");
  });
});

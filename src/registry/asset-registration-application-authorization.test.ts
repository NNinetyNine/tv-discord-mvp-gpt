import { describe, expect, it } from "vitest";

import { validateAssetRegistrationApplicationAuthorization } from "./asset-registration-application-authorization.ts";

const AUTHORIZATION = Object.freeze({
  schemaVersion: 1,
  decision: "approved",
  proposalSha256: "a".repeat(64),
  reviewerId: "visionx-curator",
  decidedAt: "2026-07-18T00:30:00Z",
  referenceId: "visionx.asset-application.example-v1",
  packPlacements: Object.freeze([]),
  notes: "Authorize planning only.",
});

describe("Asset registration application authorization", () => {
  it("validates explicit approved and rejected decisions", () => {
    expect(validateAssetRegistrationApplicationAuthorization(AUTHORIZATION)).toMatchObject({
      ok: true,
      authorization: { decision: "approved", packPlacements: [] },
    });
    expect(validateAssetRegistrationApplicationAuthorization({ ...AUTHORIZATION, decision: "rejected" })).toMatchObject({
      ok: true,
      authorization: { decision: "rejected" },
    });
  });

  it("rejects malformed, unknown, and unsupported authorization values", () => {
    expect(validateAssetRegistrationApplicationAuthorization(null)).toMatchObject({ ok: false, reason: "invalid_authorization" });
    expect(validateAssetRegistrationApplicationAuthorization({ ...AUTHORIZATION, surprise: true })).toMatchObject({ ok: false, reason: "invalid_authorization" });
    expect(validateAssetRegistrationApplicationAuthorization({ ...AUTHORIZATION, decision: "pending" })).toMatchObject({ ok: false, reason: "unsupported_decision" });
    expect(validateAssetRegistrationApplicationAuthorization({ ...AUTHORIZATION, proposalSha256: "A".repeat(64) })).toMatchObject({ ok: false, reason: "invalid_authorization" });
  });

  it("requires exact bounded reviewer metadata and timezone-aware timestamps", () => {
    expect(validateAssetRegistrationApplicationAuthorization({ ...AUTHORIZATION, reviewerId: " curator" })).toMatchObject({ ok: false, reason: "invalid_authorization" });
    expect(validateAssetRegistrationApplicationAuthorization({ ...AUTHORIZATION, decidedAt: "2026-07-18T00:30:00" })).toMatchObject({ ok: false, reason: "invalid_authorization" });
    expect(validateAssetRegistrationApplicationAuthorization({ ...AUTHORIZATION, decidedAt: "2026-02-30T00:30:00Z" })).toMatchObject({ ok: false, reason: "invalid_authorization" });
    expect(validateAssetRegistrationApplicationAuthorization({ ...AUTHORIZATION, referenceId: "x".repeat(97) })).toMatchObject({ ok: false, reason: "invalid_authorization" });
  });

  it("validates explicit append, before, and after placements", () => {
    const result = validateAssetRegistrationApplicationAuthorization({
      ...AUTHORIZATION,
      packPlacements: [
        { packId: "stocks", placement: { mode: "append" } },
        { packId: "etfs", placement: { mode: "before", anchorAssetId: "voo" } },
        { packId: "crypto", placement: { mode: "after", anchorAssetId: "btc" } },
      ],
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects duplicate and implicit or malformed placements", () => {
    expect(validateAssetRegistrationApplicationAuthorization({
      ...AUTHORIZATION,
      packPlacements: [
        { packId: "stocks", placement: { mode: "append" } },
        { packId: "stocks", placement: { mode: "append" } },
      ],
    })).toMatchObject({ ok: false, reason: "duplicate_pack_placement" });
    expect(validateAssetRegistrationApplicationAuthorization({
      ...AUTHORIZATION,
      packPlacements: [{ packId: "stocks", placement: {} }],
    })).toMatchObject({ ok: false, reason: "invalid_pack_placement" });
    expect(validateAssetRegistrationApplicationAuthorization({
      ...AUTHORIZATION,
      packPlacements: [{ packId: "stocks", placement: { mode: "before" } }],
    })).toMatchObject({ ok: false, reason: "invalid_pack_placement" });
  });
});

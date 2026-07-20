import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import {
  computeAssetRegistrationRegistryFingerprint,
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
  type AssetRegistrationProposalV1,
  type AssetRegistrationProposalV2,
} from "./asset-registration-proposal.ts";
import {
  computeAssetRegistrationPackFingerprint,
  planAssetRegistrationApplication,
  serializeAssetRegistrationApplicationPlan,
  validateAssetRegistrationApplicationPlanReceipt,
} from "./asset-registration-application-plan.ts";

const CHANNELS = Object.freeze({
  crypto: "1527846955668078663",
  stocks: "1527846988270534827",
  indices: "1527847099394162688",
  commodities: "1527847314889244893",
  etfs: "1527847370807705852",
});
const ASSETS: readonly Asset[] = Object.freeze([
  Object.freeze({ id: "aem", tradingView: "AEM", display: "Agnico Eagle Mines", channel: "stocks" }),
  Object.freeze({ id: "btc", tradingView: "BTC", display: "Bitcoin", channel: "crypto" }),
  Object.freeze({ id: "voo", tradingView: "VOO", display: "Vanguard S&P 500 ETF", channel: "etfs" }),
]);
const PACKS: readonly Pack[] = Object.freeze([
  Object.freeze({ id: "stocks", display: "Stocks", channel: "stocks", assets: Object.freeze(["aem"]) }),
  Object.freeze({ id: "crypto", display: "Crypto", channel: "crypto", assets: Object.freeze(["btc"]) }),
  Object.freeze({ id: "etfs", display: "ETFs", channel: "etfs", assets: Object.freeze(["voo"]) }),
]);

const ADD_INPUT = Object.freeze({
  schemaVersion: 2,
  operation: "add",
  asset: Object.freeze({
    id: "example_asset",
    displayName: "Example Asset",
    symbol: "EXAMPLE",
    market: "NASDAQ",
    tradingViewSymbol: "NASDAQ:EXAMPLE",
    currency: "USD",
    channel: "stocks",
  }),
  targetPackIds: Object.freeze([]),
  decision: Object.freeze({
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-17T22:30:00Z",
    referenceId: "visionx.asset-registration.example-channel-v2",
    notes: "Proposal only.",
  }),
});

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function proposalFor(
  input: unknown = ADD_INPUT,
  assets: readonly Asset[] = ASSETS,
  packs: readonly Pack[] = PACKS,
  channels: Readonly<Record<string, unknown>> = CHANNELS,
): AssetRegistrationProposalV2 {
  const result = proposeAssetRegistration(input, assets, packs, channels);
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.proposal;
}

function authorization(
  proposalSha256: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    decision: "approved",
    proposalSha256,
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-18T00:30:00Z",
    referenceId: "visionx.asset-application.example-channel-v2",
    packPlacements: Object.freeze([]),
    notes: "Authorize planning only.",
    ...overrides,
  });
}

function planFor(
  proposal: AssetRegistrationProposalV2 | AssetRegistrationProposalV1,
  authOverrides: Readonly<Record<string, unknown>> = {},
  assets: readonly Asset[] = ASSETS,
  packs: readonly Pack[] = PACKS,
  channels: Readonly<Record<string, unknown>> = CHANNELS,
) {
  const proposalBytes = serializeAssetRegistrationProposal(proposal);
  const auth = authorization(sha(proposalBytes), authOverrides);
  const authBytes = Buffer.from(`${JSON.stringify(auth, null, 2)}\n`);
  return planAssetRegistrationApplication({
    proposal,
    proposalSha256: sha(proposalBytes),
    authorization: auth,
    authorizationSha256: sha(authBytes),
    assets,
    packs,
    channels,
  });
}

describe("Asset registration application planning schemaVersion 2", () => {
  it("creates an authorized add plan carrying explicit channel", () => {
    const result = planFor(proposalFor());
    expect(result).toMatchObject({
      ok: true,
      plan: {
        schemaVersion: 2,
        applicationAuthorized: true,
        applicationStatus: "planned_not_applied",
        technicalValidation: {
          ok: true,
          registryFingerprintVerified: true,
          channelConfigurationVerified: true,
          staleStateDetected: false,
        },
        proposal: { assetId: "example_asset", channel: "stocks" },
        operations: [{ type: "add_asset", asset: { id: "example_asset", currency: "USD", channel: "stocks" } }],
        simulatedResult: {
          registryAssetCountBefore: 3,
          registryAssetCountAfter: 4,
          packMembershipCountBefore: 3,
          packMembershipCountAfter: 3,
          packs: [],
        },
        sourceChangesApplied: false,
      },
    });
  });

  it("creates a successful rejected v2 plan with channel summary and no operations", () => {
    const result = planFor(proposalFor(), { decision: "rejected", referenceId: "visionx.asset-application.example-channel-rejected-v2" });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        schemaVersion: 2,
        applicationAuthorized: false,
        applicationStatus: "rejected_not_applied",
        proposal: { channel: "stocks" },
        operations: [],
        sourceChangesApplied: false,
      },
    });
    if (result.ok) {
      expect(result.plan.simulatedResult.registryFingerprintAfter).toBe(result.plan.simulatedResult.registryFingerprintBefore);
    }
  });

  it("computes the canonical fingerprint of the fully simulated Registry", () => {
    const result = planFor(proposalFor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const futureAsset: Asset = Object.freeze({
      id: "example_asset",
      tradingView: "NASDAQ:EXAMPLE",
      display: "Example Asset",
      currency: "USD",
      channel: "stocks",
    });
    expect(result.plan.simulatedResult.registryFingerprintAfter).toBe(
      computeAssetRegistrationRegistryFingerprint([...ASSETS, futureAsset], PACKS),
    );
  });

  it("revalidates current channel configuration and fails closed", () => {
    const proposal = proposalFor();
    expect(planFor(proposal, {}, ASSETS, PACKS, { ...CHANNELS, stocks: undefined })).toMatchObject({ ok: false, reason: "unresolved_channel" });
    expect(planFor(proposal, {}, ASSETS, PACKS, { ...CHANNELS, stocks: "" })).toMatchObject({ ok: false, reason: "unresolved_channel" });
    expect(planFor(proposal, {}, ASSETS, PACKS, { ...CHANNELS, stocks: "bad" })).toMatchObject({ ok: false, reason: "unresolved_channel" });
    expect(planFor(proposal, {}, ASSETS, PACKS, { ...CHANNELS, stocks: "1999999999999999999" })).toMatchObject({ ok: true });
  });

  it("keeps the logical channel decision stable when its configured snowflake changes", () => {
    const proposal = proposalFor();
    const first = planFor(proposal);
    const second = planFor(proposal, {}, ASSETS, PACKS, {
      ...CHANNELS,
      stocks: "1999999999999999999",
    });
    expect(second).toEqual(first);
  });

  it("rejects a legacy v1 proposal for new source-applicable planning", () => {
    const legacy: AssetRegistrationProposalV1 = Object.freeze({
      schemaVersion: 1,
      proposalType: "visionx.asset-registration",
      operation: "add",
      valid: true,
      registryState: Object.freeze({
        assetCount: ASSETS.length,
        registryFingerprint: computeAssetRegistrationRegistryFingerprint(ASSETS, PACKS),
      }),
      asset: Object.freeze({
        id: "example_asset",
        displayName: "Example Asset",
        symbol: "EXAMPLE",
        market: "NASDAQ",
        tradingViewSymbol: "NASDAQ:EXAMPLE",
        currency: "USD",
      }),
      targetPacks: Object.freeze([]),
      publicationMetadataPreview: Object.freeze({ title: "EXAMPLE ASSET", symbol: "EXAMPLE", market: "NASDAQ", currency: "USD" }),
      decision: Object.freeze({ reviewerId: "visionx-curator", decidedAt: "2026-07-17T22:30:00Z", referenceId: "visionx.asset-registration.example-v1" }),
      applicationStatus: "not_applied",
    });
    expect(planFor(legacy)).toMatchObject({ ok: false, reason: "legacy_proposal_not_applicable" });
  });

  it("rejects hash mismatch and never infers authorization", () => {
    const proposal = proposalFor();
    const bytes = serializeAssetRegistrationProposal(proposal);
    expect(planAssetRegistrationApplication({
      proposal,
      proposalSha256: sha(bytes),
      authorization: null,
      authorizationSha256: "b".repeat(64),
      assets: ASSETS,
      packs: PACKS,
      channels: CHANNELS,
    })).toMatchObject({ ok: false, reason: "invalid_authorization" });
    expect(planFor(proposal, { proposalSha256: "f".repeat(64) })).toMatchObject({ ok: false, reason: "proposal_hash_mismatch" });
  });

  it("strictly validates proposal hashes and metadata", () => {
    const proposal = proposalFor();
    const originalBytes = serializeAssetRegistrationProposal(proposal);
    const altered = { ...proposal, asset: { ...proposal.asset, channel: "crypto" } } as AssetRegistrationProposalV2;
    const auth = authorization(sha(originalBytes));
    const authBytes = Buffer.from(`${JSON.stringify(auth, null, 2)}\n`);
    expect(planAssetRegistrationApplication({
      proposal: altered,
      proposalSha256: sha(originalBytes),
      authorization: auth,
      authorizationSha256: sha(authBytes),
      assets: ASSETS,
      packs: PACKS,
      channels: CHANNELS,
    })).toMatchObject({ ok: false, reason: "proposal_hash_mismatch" });
    expect(planFor({ ...proposal, publicationMetadataPreview: { ...proposal.publicationMetadataPreview, currency: "EUR" } } as AssetRegistrationProposalV2)).toMatchObject({ ok: false, reason: "invalid_proposal" });
  });

  it("supports explicit Pack placements and preserves canonical ordering", () => {
    const proposal = proposalFor({ ...ADD_INPUT, targetPackIds: ["etfs", "stocks"] });
    const first = planFor(proposal, {
      packPlacements: [
        { packId: "etfs", placement: { mode: "after", anchorAssetId: "voo" } },
        { packId: "stocks", placement: { mode: "before", anchorAssetId: "aem" } },
      ],
    });
    const second = planFor(proposal, {
      packPlacements: [
        { packId: "stocks", placement: { mode: "before", anchorAssetId: "aem" } },
        { packId: "etfs", placement: { mode: "after", anchorAssetId: "voo" } },
      ],
    });
    expect(first).toEqual(second);
    if (first.ok) {
      expect(first.plan.simulatedResult.packs.map((pack) => pack.packId)).toEqual(["stocks", "etfs"]);
      expect(first.plan.operations.filter((operation) => operation.type === "insert_pack_asset").map((operation) => operation.packId)).toEqual(["stocks", "etfs"]);
      expect(first.plan.simulatedResult.packs[0]?.fingerprintBefore).toBe(computeAssetRegistrationPackFingerprint(PACKS[0]!));
    }
  });

  it("preserves ambiguity and placement failures", () => {
    const proposal = proposalFor({ ...ADD_INPUT, targetPackIds: ["stocks"] });
    expect(planFor(proposal)).toMatchObject({ ok: false, reason: "missing_pack_placement" });
    expect(planFor(proposal, { packPlacements: [{ packId: "stocks", placement: { mode: "before", anchorAssetId: "btc" } }] })).toMatchObject({ ok: false, reason: "unknown_pack_anchor" });
    expect(planFor(proposal, { packPlacements: [{ packId: "crypto", placement: { mode: "append" } }] })).toMatchObject({ ok: false, reason: "unexpected_pack_placement" });
  });

  it("plans update_identity only when channel remains unchanged", () => {
    const updateInput = {
      ...ADD_INPUT,
      operation: "update_identity",
      asset: { ...ADD_INPUT.asset, id: "aem", displayName: "Agnico Eagle Mines", symbol: "AEM", market: "NYSE", tradingViewSymbol: "NYSE:AEM", channel: "stocks" },
      expectedCurrent: { display: "Agnico Eagle Mines", tradingView: "AEM", channel: "stocks" },
    };
    expect(planFor(proposalFor(updateInput))).toMatchObject({
      ok: true,
      plan: { operations: [{ type: "update_asset_identity", asset: { id: "aem", channel: "stocks" } }] },
    });
    expect(() => proposalFor({ ...updateInput, asset: { ...updateInput.asset, channel: "crypto" } })).toThrow("channel_change_not_authorized");
  });

  it("returns deterministic immutable results without mutating current state", () => {
    const proposal = proposalFor({ ...ADD_INPUT, targetPackIds: ["stocks"] });
    const beforeAssets = JSON.stringify(ASSETS);
    const beforePacks = JSON.stringify(PACKS);
    const first = planFor(proposal, { packPlacements: [{ packId: "stocks", placement: { mode: "append" } }] });
    const second = planFor(proposal, { packPlacements: [{ packId: "stocks", placement: { mode: "append" } }] });
    expect(first).toEqual(second);
    expect(JSON.stringify(ASSETS)).toBe(beforeAssets);
    expect(JSON.stringify(PACKS)).toBe(beforePacks);
    if (first.ok) {
      expect(Object.isFrozen(first.plan)).toBe(true);
      expect(serializeAssetRegistrationApplicationPlan(first.plan).equals(serializeAssetRegistrationApplicationPlan(second.ok ? second.plan : first.plan))).toBe(true);
    }
  });
});

describe("Application plan receipt version validation", () => {
  it("accepts strict v2 plan and rejects altered channel", () => {
    const result = planFor(proposalFor());
    if (!result.ok) throw new Error(result.detail);
    expect(validateAssetRegistrationApplicationPlanReceipt(result.plan, CHANNELS)).toMatchObject({ ok: true });
    const altered = {
      ...result.plan,
      operations: [{ ...result.plan.operations[0], asset: { ...(result.plan.operations[0] as { asset: object }).asset, channel: "crypto" } }],
    };
    expect(validateAssetRegistrationApplicationPlanReceipt(altered, CHANNELS)).toMatchObject({ ok: false, reason: "invalid_plan" });
  });

  it("recognizes historical v1 plan shape without adding channel", () => {
    const legacy = {
      schemaVersion: 1,
      planType: "visionx.asset-registration.application-plan",
      applicationAuthorized: false,
      applicationStatus: "rejected_not_applied",
      technicalValidation: {
        ok: true,
        proposalSha256: "a".repeat(64),
        authorizationSha256: "b".repeat(64),
        registryFingerprintVerified: true,
        staleStateDetected: false,
      },
      proposal: { operation: "add", assetId: "example_asset", registryFingerprint: "c".repeat(64) },
      authorization: authorization("a".repeat(64), { decision: "rejected" }),
      operations: [],
      simulatedResult: {
        registryAssetCountBefore: 3,
        registryAssetCountAfter: 3,
        packMembershipCountBefore: 3,
        packMembershipCountAfter: 3,
        registryFingerprintBefore: "c".repeat(64),
        registryFingerprintAfter: "c".repeat(64),
        packs: [],
      },
      publicationMetadataPreview: { title: "EXAMPLE ASSET", symbol: "EXAMPLE", market: "NASDAQ", currency: "USD" },
      sourceChangesApplied: false,
    };
    expect(validateAssetRegistrationApplicationPlanReceipt(legacy, CHANNELS)).toMatchObject({ ok: true, plan: { schemaVersion: 1 } });
    expect(JSON.stringify(legacy)).not.toContain('"channel"');
  });

  it("rejects unknown plan schema versions", () => {
    expect(validateAssetRegistrationApplicationPlanReceipt({ schemaVersion: 3 }, CHANNELS)).toMatchObject({ ok: false, reason: "unsupported_schema_version" });
  });
});

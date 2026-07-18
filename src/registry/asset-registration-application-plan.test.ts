import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import {
  computeAssetRegistrationRegistryFingerprint,
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
  type AssetRegistrationProposal,
} from "./asset-registration-proposal.ts";
import {
  computeAssetRegistrationPackFingerprint,
  planAssetRegistrationApplication,
  serializeAssetRegistrationApplicationPlan,
} from "./asset-registration-application-plan.ts";

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
  schemaVersion: 1,
  operation: "add",
  asset: Object.freeze({
    id: "example_asset",
    displayName: "Example Asset",
    symbol: "EXAMPLE",
    market: "NASDAQ",
    tradingViewSymbol: "NASDAQ:EXAMPLE",
    currency: "USD",
  }),
  targetPackIds: Object.freeze([]),
  decision: Object.freeze({
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-17T22:30:00Z",
    referenceId: "visionx.asset-registration.example-v1",
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
): AssetRegistrationProposal {
  const result = proposeAssetRegistration(input, assets, packs);
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
    referenceId: "visionx.asset-application.example-v1",
    packPlacements: Object.freeze([]),
    notes: "Authorize planning only.",
    ...overrides,
  });
}

function planFor(
  proposal: AssetRegistrationProposal,
  authOverrides: Readonly<Record<string, unknown>> = {},
  assets: readonly Asset[] = ASSETS,
  packs: readonly Pack[] = PACKS,
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
  });
}

describe("Asset registration application planning", () => {
  it("creates an authorized add plan without applying it", () => {
    const result = planFor(proposalFor());
    expect(result).toMatchObject({
      ok: true,
      plan: {
        applicationAuthorized: true,
        applicationStatus: "planned_not_applied",
        technicalValidation: { ok: true, registryFingerprintVerified: true, staleStateDetected: false },
        operations: [{ type: "add_asset", asset: { id: "example_asset", currency: "USD" } }],
        simulatedResult: {
          registryAssetCountBefore: 3,
          registryAssetCountAfter: 4,
          packMembershipCountBefore: 3,
          packMembershipCountAfter: 3,
        },
        sourceChangesApplied: false,
      },
    });
  });

  it("creates a successful rejected plan with no executable operations", () => {
    const result = planFor(proposalFor(), { decision: "rejected", referenceId: "visionx.asset-application.example-rejected-v1" });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        applicationAuthorized: false,
        applicationStatus: "rejected_not_applied",
        operations: [],
        sourceChangesApplied: false,
      },
    });
    if (result.ok) {
      expect(result.plan.simulatedResult.registryFingerprintAfter).toBe(result.plan.simulatedResult.registryFingerprintBefore);
    }
  });

  it("never infers authorization and rejects hash mismatch", () => {
    const proposal = proposalFor();
    const bytes = serializeAssetRegistrationProposal(proposal);
    expect(planAssetRegistrationApplication({
      proposal,
      proposalSha256: sha(bytes),
      authorization: null,
      authorizationSha256: "b".repeat(64),
      assets: ASSETS,
      packs: PACKS,
    })).toMatchObject({ ok: false, reason: "invalid_authorization" });
    expect(planFor(proposal, { proposalSha256: "f".repeat(64) })).toMatchObject({ ok: false, reason: "proposal_hash_mismatch" });
  });

  it("strictly validates the complete proposal receipt", () => {
    const proposal = proposalFor();
    expect(planFor({ ...proposal, surprise: true } as unknown as AssetRegistrationProposal)).toMatchObject({ ok: false, reason: "invalid_proposal" });
    expect(planFor({ ...proposal, publicationMetadataPreview: { ...proposal.publicationMetadataPreview, currency: "EUR" } } as AssetRegistrationProposal)).toMatchObject({ ok: false, reason: "invalid_proposal" });
  });

  it("recomputes and rejects stale Registry state", () => {
    const proposal = proposalFor();
    expect(planFor(proposal, {}, [...ASSETS, Object.freeze({ id: "new", tradingView: "NEW", display: "New", channel: "stocks" })], PACKS)).toMatchObject({
      ok: false,
      reason: "stale_registry_state",
    });
  });

  it("rejects stale add and update_identity state", () => {
    const add = proposalFor();
    const duplicateAssets = [...ASSETS, Object.freeze({ id: "example_asset", tradingView: "EXAMPLE", display: "Example", channel: "stocks" })];
    const addAgainstDuplicateState: AssetRegistrationProposal = Object.freeze({
      ...add,
      registryState: Object.freeze({
        assetCount: duplicateAssets.length,
        registryFingerprint: computeAssetRegistrationRegistryFingerprint(duplicateAssets, PACKS),
      }),
    });
    expect(planFor(addAgainstDuplicateState, {}, duplicateAssets, PACKS)).toMatchObject({ ok: false, reason: "asset_already_exists" });

    const updateInput = {
      ...ADD_INPUT,
      operation: "update_identity",
      asset: { ...ADD_INPUT.asset, id: "aem", displayName: "Agnico Eagle Mines", symbol: "AEM", market: "NYSE", tradingViewSymbol: "NYSE:AEM" },
      expectedCurrent: { display: "Agnico Eagle Mines", tradingView: "AEM" },
    };
    const update = proposalFor(updateInput);
    const changedAssets = ASSETS.map((asset) => asset.id === "aem" ? Object.freeze({ ...asset, display: "Changed" }) : asset);
    const updateAgainstChangedState: AssetRegistrationProposal = Object.freeze({
      ...update,
      registryState: Object.freeze({
        assetCount: changedAssets.length,
        registryFingerprint: computeAssetRegistrationRegistryFingerprint(changedAssets, PACKS),
      }),
    });
    expect(planFor(updateAgainstChangedState, {}, changedAssets, PACKS)).toMatchObject({ ok: false, reason: "stale_asset_state" });
  });

  it("requires exactly one explicit placement for every target Pack", () => {
    const proposal = proposalFor({ ...ADD_INPUT, targetPackIds: ["stocks"] });
    expect(planFor(proposal)).toMatchObject({ ok: false, reason: "missing_pack_placement" });
    expect(planFor(proposal, {
      packPlacements: [
        { packId: "stocks", placement: { mode: "append" } },
        { packId: "crypto", placement: { mode: "append" } },
      ],
    })).toMatchObject({ ok: false, reason: "unexpected_pack_placement" });
  });

  it("supports explicit append, before, and after placements", () => {
    for (const placement of [
      { mode: "append" },
      { mode: "before", anchorAssetId: "aem" },
      { mode: "after", anchorAssetId: "aem" },
    ]) {
      const proposal = proposalFor({ ...ADD_INPUT, targetPackIds: ["stocks"] });
      const result = planFor(proposal, { packPlacements: [{ packId: "stocks", placement }] });
      expect(result).toMatchObject({ ok: true, plan: { operations: expect.arrayContaining([expect.objectContaining({ type: "insert_pack_asset", packId: "stocks" })]) } });
    }
  });

  it("rejects unknown or out-of-Pack anchors and existing membership", () => {
    const proposal = proposalFor({ ...ADD_INPUT, targetPackIds: ["stocks"] });
    expect(planFor(proposal, { packPlacements: [{ packId: "stocks", placement: { mode: "before", anchorAssetId: "btc" } }] })).toMatchObject({
      ok: false,
      reason: "unknown_pack_anchor",
    });
    const currentPacks = PACKS.map((pack) => pack.id === "stocks" ? Object.freeze({ ...pack, assets: Object.freeze([...pack.assets, "example_asset"]) }) : pack);
    expect(planFor(proposal, { packPlacements: [{ packId: "stocks", placement: { mode: "append" } }] }, ASSETS, currentPacks)).toMatchObject({
      ok: false,
      reason: "stale_registry_state",
    });
  });

  it("rejects Pack placements for update_identity", () => {
    const updateInput = {
      ...ADD_INPUT,
      operation: "update_identity",
      asset: { ...ADD_INPUT.asset, id: "aem", displayName: "Agnico Eagle Mines", symbol: "AEM", market: "NYSE", tradingViewSymbol: "NYSE:AEM" },
      expectedCurrent: { display: "Agnico Eagle Mines", tradingView: "AEM" },
    };
    const proposal = proposalFor(updateInput);
    expect(planFor(proposal, { packPlacements: [{ packId: "stocks", placement: { mode: "append" } }] })).toMatchObject({
      ok: false,
      reason: "unexpected_pack_placement",
    });
  });


  it("rejects unknown target Packs and memberships that appeared after proposal", () => {
    const base = proposalFor({ ...ADD_INPUT, targetPackIds: ["stocks"] });
    const missingTarget: AssetRegistrationProposal = Object.freeze({
      ...base,
      targetPacks: Object.freeze([{ packId: "missing", membershipAlreadyExists: false as const }]),
    });
    expect(planFor(missingTarget, { packPlacements: [{ packId: "missing", placement: { mode: "append" } }] })).toMatchObject({
      ok: false,
      reason: "unknown_target_pack",
    });

    const packsWithMembership = PACKS.map((pack) => pack.id === "stocks"
      ? Object.freeze({ ...pack, assets: Object.freeze([...pack.assets, "example_asset"]) })
      : pack);
    const proposalAgainstCurrentPack: AssetRegistrationProposal = Object.freeze({
      ...base,
      registryState: Object.freeze({
        assetCount: ASSETS.length,
        registryFingerprint: computeAssetRegistrationRegistryFingerprint(ASSETS, packsWithMembership),
      }),
    });
    expect(planFor(
      proposalAgainstCurrentPack,
      { packPlacements: [{ packId: "stocks", placement: { mode: "append" } }] },
      ASSETS,
      packsWithMembership,
    )).toMatchObject({ ok: false, reason: "pack_membership_already_exists" });
  });

  it("plans a valid update_identity without changing Pack membership", () => {
    const updateInput = {
      ...ADD_INPUT,
      operation: "update_identity",
      asset: { ...ADD_INPUT.asset, id: "aem", displayName: "Agnico Eagle Mines", symbol: "AEM", market: "NYSE", tradingViewSymbol: "NYSE:AEM" },
      expectedCurrent: { display: "Agnico Eagle Mines", tradingView: "AEM" },
    };
    const result = planFor(proposalFor(updateInput));
    expect(result).toMatchObject({
      ok: true,
      plan: {
        operations: [{ type: "update_asset_identity", asset: { id: "aem", currency: "USD" } }],
        simulatedResult: {
          registryAssetCountBefore: 3,
          registryAssetCountAfter: 3,
          packMembershipCountBefore: 3,
          packMembershipCountAfter: 3,
          packs: [],
        },
      },
    });
  });

  it("canonicalizes caller Pack-placement ordering and preserves one Asset-owned currency", () => {
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
    if (first.ok && second.ok) {
      expect(serializeAssetRegistrationApplicationPlan(first.plan).equals(serializeAssetRegistrationApplicationPlan(second.plan))).toBe(true);
      expect(first.plan.simulatedResult.packs.map((pack) => pack.packId)).toEqual(["stocks", "etfs"]);
      expect(first.plan.operations.filter((operation) => operation.type === "insert_pack_asset").map((operation) => operation.packId)).toEqual(["stocks", "etfs"]);
      expect(JSON.stringify(first.plan.simulatedResult.packs)).not.toContain("currency");
    }
  });

  it("preserves existing relative Pack order and computes deterministic fingerprints", () => {
    const proposal = proposalFor({ ...ADD_INPUT, targetPackIds: ["stocks"] });
    const result = planFor(proposal, { packPlacements: [{ packId: "stocks", placement: { mode: "before", anchorAssetId: "aem" } }] });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        simulatedResult: {
          packs: [{ packId: "stocks", resultingIndex: 0, existingRelativeOrderPreserved: true }],
        },
      },
    });
    if (result.ok) {
      const pack = result.plan.simulatedResult.packs[0];
      expect(pack?.fingerprintBefore).toBe(computeAssetRegistrationPackFingerprint(PACKS[0]!));
      expect(pack?.fingerprintAfter).not.toBe(pack?.fingerprintBefore);
      expect(result.plan.simulatedResult.registryFingerprintAfter).not.toBe(result.plan.simulatedResult.registryFingerprintBefore);
    }
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
      expect(JSON.stringify(first.plan)).not.toMatch(/\/tmp\/|Users|createdAt|currentTime/u);
    }
  });
});

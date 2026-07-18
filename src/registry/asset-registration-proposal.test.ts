import { describe, expect, it } from "vitest";

import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import {
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
  validateAssetRegistrationInput,
  validateAssetRegistrationProposalReceipt,
} from "./asset-registration-proposal.ts";

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
]);
const PACKS: readonly Pack[] = Object.freeze([
  Object.freeze({ id: "stocks", display: "Stocks", channel: "stocks", assets: Object.freeze(["aem"]) }),
  Object.freeze({ id: "crypto", display: "Crypto", channel: "crypto", assets: Object.freeze(["btc"]) }),
]);

const ADD_V2 = Object.freeze({
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
    notes: "Schema demonstration only.",
  }),
});

const LEGACY_V1_PROPOSAL = Object.freeze({
  schemaVersion: 1,
  proposalType: "visionx.asset-registration",
  operation: "add",
  valid: true,
  registryState: Object.freeze({ assetCount: 2, registryFingerprint: "a".repeat(64) }),
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
  decision: Object.freeze({
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-17T22:30:00Z",
    referenceId: "visionx.asset-registration.example-v1",
    notes: "Historical artifact.",
  }),
  applicationStatus: "not_applied",
});

describe("Asset registration proposals schemaVersion 2", () => {
  it("builds deterministic v2 bytes with explicit logical channel", () => {
    const first = proposeAssetRegistration(ADD_V2, ASSETS, PACKS, CHANNELS);
    const second = proposeAssetRegistration(ADD_V2, ASSETS, PACKS, CHANNELS);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      proposal: {
        schemaVersion: 2,
        asset: { channel: "stocks" },
        targetPacks: [],
        applicationStatus: "not_applied",
        publicationMetadataPreview: { title: "EXAMPLE ASSET", symbol: "EXAMPLE", market: "NASDAQ", currency: "USD" },
      },
    });
    if (first.ok && second.ok) {
      const bytes = serializeAssetRegistrationProposal(first.proposal);
      expect(bytes.equals(serializeAssetRegistrationProposal(second.proposal))).toBe(true);
      expect(bytes.toString("utf8")).not.toContain("1527846988270534827");
    }
  });

  it("requires explicit channel and never infers it from market, currency, or Pack", () => {
    for (const input of [
      { ...ADD_V2, asset: { ...ADD_V2.asset, channel: undefined } },
      { ...ADD_V2, asset: { ...ADD_V2.asset, channel: undefined }, targetPackIds: ["stocks"] },
    ]) {
      expect(proposeAssetRegistration(input, ASSETS, PACKS, CHANNELS)).toMatchObject({
        ok: false,
        reason: "proposal_channel_required",
      });
    }
  });

  it("validates current channel configuration without serializing the Discord id", () => {
    expect(proposeAssetRegistration(ADD_V2, ASSETS, PACKS, CHANNELS)).toMatchObject({ ok: true });
    expect(proposeAssetRegistration(ADD_V2, ASSETS, PACKS, { ...CHANNELS, stocks: "" })).toMatchObject({ ok: false, reason: "unresolved_channel" });
    expect(proposeAssetRegistration(ADD_V2, ASSETS, PACKS, { ...CHANNELS, stocks: "bad" })).toMatchObject({ ok: false, reason: "unresolved_channel" });
  });

  it("builds update_identity only with exact current channel and prohibits migration", () => {
    const input = {
      ...ADD_V2,
      operation: "update_identity",
      asset: { ...ADD_V2.asset, id: "aem", displayName: "Agnico Eagle Mines", symbol: "AEM", market: "NYSE", tradingViewSymbol: "NYSE:AEM", channel: "stocks" },
      expectedCurrent: { display: "Agnico Eagle Mines", tradingView: "AEM", channel: "stocks" },
    };
    expect(proposeAssetRegistration(input, ASSETS, PACKS, CHANNELS)).toMatchObject({ ok: true });
    expect(proposeAssetRegistration({ ...input, expectedCurrent: { ...input.expectedCurrent, channel: "crypto" } }, ASSETS, PACKS, CHANNELS)).toMatchObject({ ok: false, reason: "stale_asset_state" });
    expect(proposeAssetRegistration({ ...input, asset: { ...input.asset, channel: "crypto" } }, ASSETS, PACKS, CHANNELS)).toMatchObject({ ok: false, reason: "channel_change_not_authorized" });
  });

  it("requires expectedCurrent.channel for v2 update_identity", () => {
    expect(proposeAssetRegistration({
      ...ADD_V2,
      operation: "update_identity",
      asset: { ...ADD_V2.asset, id: "aem", channel: "stocks" },
      expectedCurrent: { display: "Agnico Eagle Mines", tradingView: "AEM" },
    }, ASSETS, PACKS, CHANNELS)).toMatchObject({ ok: false });
  });

  it("validates target Packs without implying membership from channel", () => {
    expect(proposeAssetRegistration({ ...ADD_V2, targetPackIds: ["missing"] }, ASSETS, PACKS, CHANNELS)).toMatchObject({ ok: false, reason: "unknown_target_pack" });
    expect(validateAssetRegistrationInput({ ...ADD_V2, targetPackIds: ["stocks", "stocks"] }, CHANNELS)).toMatchObject({ ok: false, reason: "duplicate_target_pack" });
    const result = proposeAssetRegistration(ADD_V2, ASSETS, PACKS, CHANNELS);
    expect(result).toMatchObject({ ok: true, proposal: { asset: { channel: "stocks" }, targetPacks: [] } });
  });

  it("permits multiple target Packs while keeping one Asset-owned channel", () => {
    const result = proposeAssetRegistration({ ...ADD_V2, targetPackIds: ["crypto", "stocks"] }, ASSETS, PACKS, CHANNELS);
    expect(result).toMatchObject({
      ok: true,
      proposal: {
        asset: { currency: "USD", channel: "stocks" },
        targetPacks: [{ packId: "stocks" }, { packId: "crypto" }],
      },
    });
    if (result.ok) {
      for (const target of result.proposal.targetPacks) {
        expect(target).not.toHaveProperty("currency");
        expect(target).not.toHaveProperty("channel");
      }
    }
  });

  it("rejects unsupported schema versions and operations", () => {
    expect(validateAssetRegistrationInput({ ...ADD_V2, schemaVersion: 3 }, CHANNELS)).toMatchObject({ ok: false, reason: "unsupported_schema_version" });
    expect(validateAssetRegistrationInput({ ...ADD_V2, operation: "remove" }, CHANNELS)).toMatchObject({ ok: false, reason: "unsupported_operation" });
  });
});

describe("Asset registration proposal v1 compatibility", () => {
  it("recognizes the exact historical v1 receipt without adding channel", () => {
    const validated = validateAssetRegistrationProposalReceipt(LEGACY_V1_PROPOSAL, CHANNELS);
    expect(validated).toMatchObject({ ok: true, proposal: { schemaVersion: 1, asset: { currency: "USD" } } });
    if (validated.ok) {
      expect(validated.proposal.asset).not.toHaveProperty("channel");
      expect(serializeAssetRegistrationProposal(validated.proposal).toString("utf8")).not.toContain('"channel"');
    }
  });

  it("does not silently upgrade a v1 input into a new proposal", () => {
    const v1Input = {
      schemaVersion: 1,
      operation: "add",
      asset: LEGACY_V1_PROPOSAL.asset,
      targetPackIds: [],
      decision: LEGACY_V1_PROPOSAL.decision,
    };
    expect(proposeAssetRegistration(v1Input, ASSETS, PACKS, CHANNELS)).toMatchObject({
      ok: false,
      reason: "legacy_proposal_not_applicable",
    });
  });
});

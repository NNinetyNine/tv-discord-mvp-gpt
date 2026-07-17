import { describe, expect, it } from "vitest";

import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import {
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
  validateAssetRegistrationInput,
} from "./asset-registration-proposal.ts";

const ASSETS: readonly Asset[] = Object.freeze([
  Object.freeze({ id: "aem", tradingView: "AEM", display: "Agnico Eagle Mines", channel: "stocks" }),
  Object.freeze({ id: "btc", tradingView: "BTC", display: "Bitcoin", channel: "crypto" }),
]);
const PACKS: readonly Pack[] = Object.freeze([
  Object.freeze({ id: "stocks", display: "Stocks", channel: "stocks", assets: Object.freeze(["aem"]) }),
  Object.freeze({ id: "crypto", display: "Crypto", channel: "crypto", assets: Object.freeze(["btc"]) }),
]);

const ADD = Object.freeze({
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
    notes: "Schema demonstration only.",
  }),
});

describe("Asset registration proposals", () => {
  it("builds a deterministic add proposal without applying it", () => {
    const first = proposeAssetRegistration(ADD, ASSETS, PACKS);
    const second = proposeAssetRegistration(ADD, ASSETS, PACKS);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      proposal: {
        operation: "add",
        valid: true,
        applicationStatus: "not_applied",
        publicationMetadataPreview: { title: "EXAMPLE ASSET", symbol: "EXAMPLE", market: "NASDAQ", currency: "USD" },
      },
    });
    if (first.ok && second.ok) {
      expect(serializeAssetRegistrationProposal(first.proposal).equals(serializeAssetRegistrationProposal(second.proposal))).toBe(true);
    }
  });

  it("builds update_identity only with exact expected current state", () => {
    const input = {
      ...ADD,
      operation: "update_identity",
      asset: { ...ADD.asset, id: "aem", displayName: "Agnico Eagle Mines", symbol: "AEM", market: "NYSE", tradingViewSymbol: "NYSE:AEM" },
      expectedCurrent: { display: "Agnico Eagle Mines", tradingView: "AEM" },
    };
    expect(proposeAssetRegistration(input, ASSETS, PACKS)).toMatchObject({ ok: true });
    expect(proposeAssetRegistration({ ...input, expectedCurrent: { display: "Changed", tradingView: "AEM" } }, ASSETS, PACKS)).toMatchObject({ ok: false, reason: "stale_asset_state" });
  });

  it("requires expectedCurrent for update_identity", () => {
    expect(proposeAssetRegistration({ ...ADD, operation: "update_identity", asset: { ...ADD.asset, id: "aem" } }, ASSETS, PACKS)).toMatchObject({
      ok: false,
      reason: "invalid_registration_input",
    });
  });

  it("rejects add for an existing Asset and update for an unknown Asset", () => {
    expect(proposeAssetRegistration({ ...ADD, asset: { ...ADD.asset, id: "aem" } }, ASSETS, PACKS)).toMatchObject({ ok: false, reason: "asset_already_exists" });
    expect(proposeAssetRegistration({
      ...ADD,
      operation: "update_identity",
      expectedCurrent: { display: "No", tradingView: "NO" },
    }, ASSETS, PACKS)).toMatchObject({ ok: false, reason: "unknown_asset" });
  });

  it("validates target Packs and rejects duplicate membership", () => {
    expect(proposeAssetRegistration({ ...ADD, targetPackIds: ["missing"] }, ASSETS, PACKS)).toMatchObject({ ok: false, reason: "unknown_target_pack" });
    expect(validateAssetRegistrationInput({ ...ADD, targetPackIds: ["stocks", "stocks"] })).toMatchObject({ ok: false, reason: "duplicate_target_pack" });
    const update = {
      ...ADD,
      operation: "update_identity",
      asset: { ...ADD.asset, id: "aem", displayName: "Agnico Eagle Mines", symbol: "AEM", market: "NYSE", tradingViewSymbol: "NYSE:AEM" },
      expectedCurrent: { display: "Agnico Eagle Mines", tradingView: "AEM" },
      targetPackIds: ["stocks"],
    };
    expect(proposeAssetRegistration(update, ASSETS, PACKS)).toMatchObject({ ok: false, reason: "pack_membership_already_exists" });
  });

  it("permits one proposed Asset to target multiple Packs with one Asset currency", () => {
    const result = proposeAssetRegistration({ ...ADD, targetPackIds: ["crypto", "stocks"] }, ASSETS, PACKS);
    expect(result).toMatchObject({
      ok: true,
      proposal: {
        asset: { currency: "USD" },
        targetPacks: [{ packId: "stocks" }, { packId: "crypto" }],
      },
    });
    const json = JSON.stringify(result);
    expect((json.match(/"currency"/gu) ?? []).length).toBe(2); // Asset plus preview, never Pack membership.
    if (result.ok) {
      for (const target of result.proposal.targetPacks) expect(target).not.toHaveProperty("currency");
    }
  });

  it("rejects unsupported operation, unknown fields, and timezone-free decisions", () => {
    expect(validateAssetRegistrationInput({ ...ADD, operation: "remove" })).toMatchObject({ ok: false, reason: "unsupported_operation" });
    expect(validateAssetRegistrationInput({ ...ADD, surprise: true })).toMatchObject({ ok: false, reason: "invalid_registration_input" });
    expect(validateAssetRegistrationInput({ ...ADD, decision: { ...ADD.decision, decidedAt: "2026-07-17T22:30:00" } })).toMatchObject({ ok: false, reason: "invalid_registration_input" });
  });
});

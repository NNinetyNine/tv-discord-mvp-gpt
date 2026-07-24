import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { serializePackDraft, type PackDraft } from "../admin/admin-types.ts";
import { ADMIN_CANONICAL_FIXTURE_ROOT } from "../test-support/admin-canonical-fixture.ts";
import { buildRegistry } from "../registry/registry.ts";
import { buildPacks } from "./packs.ts";
import {
  currentPackPromotionContext,
  generatePackSourceChange,
  planPackSourceChange,
  proposePackDraftPromotion,
  serializePackDraftPromotionRequest,
  serializePackSourceApplicationPlan,
  serializePackSourcePlanningAuthorization,
  serializePackSourceProposal,
  sha256,
  transformCanonicalPacksSource,
  validatePackDraftPromotionRequest,
  validatePackSourceApplicationPlan,
  validatePackSourceChangeReceipt,
  type PackDraftPromotionRequest,
  type PackSourcePlanningAuthorization,
} from "./pack-draft-promotion.ts";

function fixture() {
  const registryBytes = readFileSync(resolve(ADMIN_CANONICAL_FIXTURE_ROOT, "definitions/registry.json"));
  const packsBytes = readFileSync(resolve(ADMIN_CANONICAL_FIXTURE_ROOT, "definitions/packs.json"));
  const channelsBytes = readFileSync(resolve(ADMIN_CANONICAL_FIXTURE_ROOT, "config/channels.json"));
  const channels = JSON.parse(channelsBytes.toString("utf8")) as Record<string, unknown>;
  const registry = buildRegistry(JSON.parse(registryBytes.toString("utf8")), channels);
  const assets = registry.all();
  const packs = buildPacks(JSON.parse(packsBytes.toString("utf8")), new Set(assets.map((asset) => asset.id)), new Set(Object.keys(channels)));
  return currentPackPromotionContext({ assets, packs, channels, registryBytes, packsBytes, channelsBytes });
}
const draft: PackDraft = Object.freeze({
  schemaVersion: 1,
  draftType: "visionx.pack-draft",
  id: "qa-pack",
  displayName: "QA Pack",
  description: "A non-live Pack draft used for administration verification.",
  assetIds: Object.freeze(["gold", "aapl", "btc"]),
  revision: 2,
});
function request(overrides: Partial<PackDraftPromotionRequest> = {}): PackDraftPromotionRequest {
  return Object.freeze({
    schemaVersion: 1,
    requestType: "visionx.pack-draft-promotion-request",
    operation: "create_pack",
    draftId: "qa-pack",
    expectedRevision: 2,
    channel: "stocks",
    curatorId: "visionx-curator",
    decidedAt: "2026-07-19T01:00:00Z",
    referenceId: "visionx.pack-draft-promotion.qa-pack-v1",
    notes: "Prepare the exact saved draft as a reviewable Pack source proposal.",
    ...overrides,
  });
}
function chain(options: { decision?: "approved" | "rejected"; request?: PackDraftPromotionRequest; context?: ReturnType<typeof fixture>; draft?: PackDraft } = {}) {
  const context = options.context ?? fixture();
  const requestValue = options.request ?? request();
  const requestBytes = serializePackDraftPromotionRequest(requestValue);
  const draftBytes = serializePackDraft(options.draft ?? draft);
  const proposed = proposePackDraftPromotion({ requestValue, requestBytes, draftBytes, context });
  if (!proposed.ok) throw new Error(`${proposed.reason}: ${proposed.detail}`);
  const proposalBytes = serializePackSourceProposal(proposed.value);
  const authorization: PackSourcePlanningAuthorization = Object.freeze({
    schemaVersion: 1,
    decision: options.decision ?? "approved",
    packProposalSha256: sha256(proposalBytes),
    draftSha256: sha256(draftBytes),
    promotionRequestSha256: sha256(requestBytes),
    curatorId: "visionx-curator",
    decidedAt: "2026-07-19T01:15:00Z",
    referenceId: "visionx.pack-source-planning.qa-pack-v1",
    notes: "Authorize deterministic planning only.",
  });
  const authorizationBytes = serializePackSourcePlanningAuthorization(authorization);
  const planned = planPackSourceChange({ requestValue, requestBytes, draftBytes, proposalValue: proposed.value, proposalBytes, authorizationValue: authorization, authorizationBytes, context });
  return { context, requestValue, requestBytes, draftBytes, proposal: proposed.value, proposalBytes, authorization, authorizationBytes, planned };
}

describe("Pack draft promotion domain", () => {
  it("requires an explicit create_pack channel", () => {
    const value = { ...request(), channel: undefined };
    delete (value as { channel?: unknown }).channel;
    expect(validatePackDraftPromotionRequest(value, fixture().channels)).toMatchObject({ ok: false, reason: "pack_channel_required" });
  });
  it("accepts a configured logical channel", () => expect(validatePackDraftPromotionRequest(request(), fixture().channels)).toMatchObject({ ok: true, value: { channel: "stocks" } }));
  it.each([
    ["", "pack_channel_invalid"],
    ["Stocks", "pack_channel_not_configured"],
    ["futures", "pack_channel_not_configured"],
    ["1527846988270534827", "numeric_channel_id_not_allowed"],
  ])("rejects invalid channel %s", (channel, reason) => expect(validatePackDraftPromotionRequest(request({ channel }), fixture().channels)).toMatchObject({ ok: false, reason }));
  it("does not infer channel from first or majority Asset membership", () => {
    const result = chain();
    expect(result.proposal.pack.channel).toBe("stocks");
    expect(result.proposal.pack.assetIds).toEqual(["gold", "aapl", "btc"]);
    expect(result.context.assets.find((asset) => asset.id === "gold")?.channel).toBe("commodities");
    expect(result.context.assets.find((asset) => asset.id === "btc")?.channel).toBe("crypto");
  });
  it("rejects unknown promotion fields", () => expect(validatePackDraftPromotionRequest({ ...request(), unexpected: true }, fixture().channels)).toMatchObject({ ok: false, reason: "invalid_promotion_request" }));
  it("rejects malformed timestamps", () => expect(validatePackDraftPromotionRequest(request({ decidedAt: "2026-07-19T01:00:00" }), fixture().channels)).toMatchObject({ ok: false, reason: "invalid_promotion_request" }));
  it("binds exact request, draft, source, channel, ordering, and workspace-only metadata", () => {
    const value = chain();
    expect(value.proposal).toMatchObject({ operation: "create_pack", pack: { id: "qa-pack", display: "QA Pack", channel: "stocks", assetIds: ["gold", "aapl", "btc"] }, draft: { revision: 2, sha256: sha256(value.draftBytes) }, promotionRequest: { sha256: sha256(value.requestBytes) }, sourceState: { registrySha256: value.context.registrySha256, packsSha256: value.context.packsSha256, channelsSha256: value.context.channelsSha256 } });
    expect(value.proposal.workspaceMetadata).toMatchObject({ description: draft.description, canonicalFields: ["id", "display", "channel", "assets"] });
  });
  it("rejects duplicate and missing draft Assets", () => {
    const duplicate = { ...draft, assetIds: ["gold", "gold"] };
    const unknown = { ...draft, assetIds: ["missing"] };
    for (const [candidate, reason] of [[duplicate, "duplicate_draft_asset"], [unknown, "draft_asset_not_found"]] as const) {
      const context = fixture(); const req = request(); const requestBytes = serializePackDraftPromotionRequest(req);
      expect(proposePackDraftPromotion({ requestValue: req, requestBytes, draftBytes: serializePackDraft(candidate), context })).toMatchObject({ ok: false, reason });
    }
  });
  it("reports empty membership as not promotable", () => {
    const context = fixture(); const req = request(); const requestBytes = serializePackDraftPromotionRequest(req);
    expect(proposePackDraftPromotion({ requestValue: req, requestBytes, draftBytes: serializePackDraft({ ...draft, assetIds: [] }), context })).toMatchObject({ ok: false, reason: "invalid_pack_proposal" });
  });
  it("rejects create_pack when the Pack exists and replace when it is missing", () => {
    const context = fixture();
    const existingDraft = { ...draft, id: "stocks", displayName: "Stocks", assetIds: ["aapl"] };
    const createRequest = request({ draftId: "stocks" });
    expect(proposePackDraftPromotion({ requestValue: createRequest, requestBytes: serializePackDraftPromotionRequest(createRequest), draftBytes: serializePackDraft(existingDraft), context })).toMatchObject({ ok: false, reason: "pack_already_exists" });
    const replaceRequest = request({ operation: "replace_pack_assets", channel: undefined });
    const raw = { ...replaceRequest } as Record<string, unknown>; delete raw.channel;
    expect(proposePackDraftPromotion({ requestValue: raw, requestBytes: Buffer.from(`${JSON.stringify(raw, null, 2)}\n`), draftBytes: serializePackDraft(draft), context })).toMatchObject({ ok: false, reason: "pack_not_found" });
  });
  it("rejects a channel field for replace_pack_assets", () => expect(validatePackDraftPromotionRequest({ ...request(), operation: "replace_pack_assets", channel: "stocks" }, fixture().channels)).toMatchObject({ ok: false, reason: "pack_channel_change_not_supported" }));
  it("preserves existing channel for replace_pack_assets", () => {
    const context = fixture();
    const replacementDraft = Object.freeze({ ...draft, id: "stocks", displayName: "Stocks", assetIds: Object.freeze(["aapl", "msft"]) });
    const reqRaw = { ...request({ operation: "replace_pack_assets", draftId: "stocks" }) } as Record<string, unknown>; delete reqRaw.channel;
    const requestBytes = Buffer.from(`${JSON.stringify(reqRaw, null, 2)}\n`);
    const proposed = proposePackDraftPromotion({ requestValue: reqRaw, requestBytes, draftBytes: serializePackDraft(replacementDraft), context });
    expect(proposed).toMatchObject({ ok: true, value: { pack: { channel: "stocks" } } });
  });
  it("requires approved planning authorization", () => expect(chain({ decision: "rejected" }).planned).toMatchObject({ ok: false, reason: "planning_authorization_rejected" }));
  it("produces exact deterministic create plan counts, channel and future hash", () => {
    const first = chain(); const second = chain();
    expect(first.planned.ok).toBe(true); expect(second.planned.ok).toBe(true);
    if (!first.planned.ok || !second.planned.ok) return;
    expect(first.planned.value.operation).toEqual({ type: "create_pack", packId: "qa-pack", display: "QA Pack", channel: "stocks", assetIds: ["gold", "aapl", "btc"] });
    expect(first.planned.value.simulatedResult).toMatchObject({ packCountBefore: 5, packCountAfter: 6, packMembershipCountBefore: 131, packMembershipCountAfter: 134, targetPackMembershipCountBefore: 0, targetPackMembershipCountAfter: 3 });
    expect(serializePackSourceApplicationPlan(first.planned.value)).toEqual(serializePackSourceApplicationPlan(second.planned.value));
  });
  it("detects altered proposal channel during reconstruction", () => {
    const value = chain();
    const altered = { ...value.proposal, pack: { ...value.proposal.pack, channel: "crypto" } };
    expect(planPackSourceChange({ requestValue: value.requestValue, requestBytes: value.requestBytes, draftBytes: value.draftBytes, proposalValue: altered, proposalBytes: Buffer.from(`${JSON.stringify(altered, null, 2)}\n`), authorizationValue: value.authorization, authorizationBytes: value.authorizationBytes, context: value.context })).toMatchObject({ ok: false });
  });
  it("generates a deterministic Packs-only patch and receipt", () => {
    const value = chain(); if (!value.planned.ok) throw new Error("plan failed");
    const planBytes = serializePackSourceApplicationPlan(value.planned.value);
    const generated = generatePackSourceChange({
      requestValue: value.requestValue, requestBytes: value.requestBytes, draftBytes: value.draftBytes,
      proposalValue: value.proposal, proposalBytes: value.proposalBytes,
      authorizationValue: value.authorization, authorizationBytes: value.authorizationBytes,
      planValue: value.planned.value, planBytes, context: value.context,
    });
    expect(generated.ok).toBe(true); if (!generated.ok) return;
    expect(generated.value.patch.toString("utf8")).toContain("definitions/packs.json");
    expect(generated.value.patch.toString("utf8")).not.toContain("definitions/registry.json");
    expect(generated.value.receipt).toMatchObject({ generationStatus: "generated_not_applied", operation: "create_pack", pack: { channel: "stocks", assetIds: ["gold", "aapl", "btc"] }, workspaceMetadata: { descriptionWrittenToCanonicalSource: false }, numericDiscordDestinationStored: false, sourceChangesApplied: false });
    expect(generated.value.packsAfter.toString("utf8")).not.toContain(draft.description ?? "");
    expect(generated.value.packsAfter.toString("utf8")).not.toContain("1527846988270534827");
    const parsed = JSON.parse(generated.value.packsAfter.toString("utf8"));
    expect(parsed.at(-1)).toEqual({ id: "qa-pack", display: "QA Pack", channel: "stocks", assets: ["gold", "aapl", "btc"] });
  });
  it("reconstructs future Packs through the canonical builder", () => {
    const context = fixture();
    const result = transformCanonicalPacksSource(context.packsBytes, { type: "create_pack", packId: "qa-pack", display: "QA Pack", channel: "stocks", assetIds: ["gold", "aapl", "btc"] }, new Set(context.assets.map((asset) => asset.id)), new Set(Object.keys(context.channels)));
    expect(result).toMatchObject({ ok: true, value: { packs: expect.any(Array) } });
    if (result.ok) expect(result.value.packs.map((pack) => pack.id)).toEqual(["crypto", "stocks", "indices", "commodities", "etfs", "qa-pack"]);
  });
  it("fails closed on stale Registry or Pack source identity", () => {
    const value = chain();
    const staleContext = { ...value.context, packsSha256: "0".repeat(64) };
    expect(planPackSourceChange({ requestValue: value.requestValue, requestBytes: value.requestBytes, draftBytes: value.draftBytes, proposalValue: value.proposal, proposalBytes: value.proposalBytes, authorizationValue: value.authorization, authorizationBytes: value.authorizationBytes, context: staleContext })).toMatchObject({ ok: false, reason: "stale_pack_state" });
  });
  it("rejects unsupported request schema versions and non-string channels", () => {
    expect(validatePackDraftPromotionRequest({ ...request(), schemaVersion: 2 }, fixture().channels)).toMatchObject({ ok: false, reason: "unsupported_schema_version" });
    expect(validatePackDraftPromotionRequest({ ...request(), channel: null }, fixture().channels)).toMatchObject({ ok: false, reason: "pack_channel_invalid" });
    expect(validatePackDraftPromotionRequest({ ...request(), channel: {} }, fixture().channels)).toMatchObject({ ok: false, reason: "pack_channel_invalid" });
    expect(validatePackDraftPromotionRequest({ ...request(), channel: " stocks " }, fixture().channels)).toMatchObject({ ok: false, reason: "pack_channel_invalid" });
  });
  it("planning authorization binds proposal, draft, and request hashes", () => {
    const value = chain();
    const fields = ["packProposalSha256", "draftSha256", "promotionRequestSha256"] as const;
    for (const field of fields) {
      const altered = { ...value.authorization, [field]: "0".repeat(64) };
      expect(planPackSourceChange({ requestValue: value.requestValue, requestBytes: value.requestBytes, draftBytes: value.draftBytes, proposalValue: value.proposal, proposalBytes: value.proposalBytes, authorizationValue: altered, authorizationBytes: serializePackSourcePlanningAuthorization(altered), context: value.context })).toMatchObject({ ok: false });
    }
  });
  it("strictly validates application-plan and source-change-receipt schemas", () => {
    const value = chain(); if (!value.planned.ok) throw new Error("plan failed");
    expect(validatePackSourceApplicationPlan(value.planned.value)).toMatchObject({ ok: true });
    expect(validatePackSourceApplicationPlan({ ...value.planned.value, unexpected: true })).toMatchObject({ ok: false, reason: "invalid_pack_application_plan" });
    const planBytes = serializePackSourceApplicationPlan(value.planned.value);
    const generated = generatePackSourceChange({ requestValue: value.requestValue, requestBytes: value.requestBytes, draftBytes: value.draftBytes, proposalValue: value.proposal, proposalBytes: value.proposalBytes, authorizationValue: value.authorization, authorizationBytes: value.authorizationBytes, planValue: value.planned.value, planBytes, context: value.context });
    if (!generated.ok) throw new Error("generation failed");
    expect(validatePackSourceChangeReceipt(generated.value.receipt)).toMatchObject({ ok: true });
    expect(validatePackSourceChangeReceipt({ ...generated.value.receipt, numericDiscordDestinationStored: true })).toMatchObject({ ok: false, reason: "invalid_pack_source_change_receipt" });
  });
  it("replace_pack_assets plans and transforms only ordered membership while preserving channel", () => {
    const context = fixture();
    const replacementDraft = Object.freeze({ ...draft, id: "stocks", displayName: "Stocks workspace label", description: "Workspace only", assetIds: Object.freeze(["aapl", "msft", "nvda"]) });
    const raw = { ...request({ operation: "replace_pack_assets", draftId: "stocks" }) } as Record<string, unknown>; delete raw.channel;
    const requestBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`); const draftBytes = serializePackDraft(replacementDraft);
    const proposed = proposePackDraftPromotion({ requestValue: raw, requestBytes, draftBytes, context }); if (!proposed.ok) throw new Error("proposal failed");
    const proposalBytes = serializePackSourceProposal(proposed.value);
    const authorization = Object.freeze({ schemaVersion: 1 as const, decision: "approved" as const, packProposalSha256: sha256(proposalBytes), draftSha256: sha256(draftBytes), promotionRequestSha256: sha256(requestBytes), curatorId: "visionx-curator", decidedAt: "2026-07-19T01:15:00Z", referenceId: "visionx.pack-source-planning.stocks-v1" });
    const authorizationBytes = serializePackSourcePlanningAuthorization(authorization);
    const planned = planPackSourceChange({ requestValue: raw, requestBytes, draftBytes, proposalValue: proposed.value, proposalBytes, authorizationValue: authorization, authorizationBytes, context });
    expect(planned).toMatchObject({ ok: true, value: { operation: { type: "replace_pack_assets", packId: "stocks", channel: "stocks", afterAssetIds: ["aapl", "msft", "nvda"], channelChanged: false }, simulatedResult: { packCountBefore: 5, packCountAfter: 5 } } });
    if (!planned.ok) return;
    const source = transformCanonicalPacksSource(context.packsBytes, planned.value.operation, new Set(context.assets.map((asset) => asset.id)), new Set(Object.keys(context.channels)));
    expect(source).toMatchObject({ ok: true });
    if (source.ok) { const parsed = JSON.parse(source.value.bytes.toString("utf8")); const stocks = parsed.find((pack: any) => pack.id === "stocks"); expect(stocks).toEqual({ id: "stocks", display: "Stocks", channel: "stocks", assets: ["aapl", "msft", "nvda"] }); expect(parsed.filter((pack: any) => pack.id !== "stocks")).toEqual(JSON.parse(context.packsBytes.toString("utf8")).filter((pack: any) => pack.id !== "stocks")); }
  });
});

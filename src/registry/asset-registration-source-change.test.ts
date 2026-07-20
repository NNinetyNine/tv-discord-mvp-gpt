import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import { buildPacks, type Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import { buildRegistry } from "./registry.ts";
import {
  planAssetRegistrationApplication,
  serializeAssetRegistrationApplicationPlan,
  type AssetRegistrationApplicationPlanV2,
} from "./asset-registration-application-plan.ts";
import {
  serializeAssetRegistrationApplicationAuthorization,
  type AssetRegistrationApplicationAuthorization,
} from "./asset-registration-application-authorization.ts";
import {
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
  type AssetRegistrationProposalV2,
} from "./asset-registration-proposal.ts";
import {
  generateAssetRegistrationSourceChange,
  serializeAssetRegistrationSourceChangeReceipt,
} from "./asset-registration-source-change.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface SourceFixture {
  readonly registryBytes: Buffer;
  readonly packsBytes: Buffer;
  readonly channelsBytes: Buffer;
  readonly channels: Readonly<Record<string, unknown>>;
  readonly assets: readonly Asset[];
  readonly packs: readonly Pack[];
}

function sourceFixture(channelsOverride?: Readonly<Record<string, unknown>>): SourceFixture {
  const registryBytes = readFileSync(resolve("definitions/registry.json"));
  const packsBytes = readFileSync(resolve("definitions/packs.json"));
  const baseChannels = JSON.parse(readFileSync(resolve("config/channels.json"), "utf8")) as Record<string, unknown>;
  const channels = Object.freeze({ ...baseChannels, ...(channelsOverride ?? {}) });
  const channelsBytes = Buffer.from(`${JSON.stringify(channels, null, 2)}\n`, "utf8");
  const registryRaw = JSON.parse(registryBytes.toString("utf8")) as Parameters<typeof buildRegistry>[0];
  const packsRaw = JSON.parse(packsBytes.toString("utf8")) as unknown;
  const registry = buildRegistry(registryRaw, channels as Record<string, unknown>);
  const packs = buildPacks(
    packsRaw,
    new Set(registry.all().map((asset) => asset.id)),
    new Set(Object.keys(channels)),
  );
  return Object.freeze({ registryBytes, packsBytes, channelsBytes, channels, assets: registry.all(), packs });
}

interface ArtifactOptions {
  readonly operation?: "add" | "update_identity";
  readonly assetId?: string;
  readonly targetPackIds?: readonly string[];
  readonly decision?: "approved" | "rejected";
  readonly placements?: AssetRegistrationApplicationAuthorization["packPlacements"];
  readonly fixture?: SourceFixture;
}

function artifacts(options: ArtifactOptions = {}) {
  const fixture = options.fixture ?? sourceFixture();
  const operation = options.operation ?? "add";
  const assetId = options.assetId ?? "source_change_test_asset";
  const current = fixture.assets.find((asset) => asset.id === assetId);
  const addSymbol = assetId.replace(/[^a-z0-9]/giu, "").toUpperCase().slice(0, 24);
  const proposalInput = operation === "add"
    ? {
      schemaVersion: 2,
      operation,
      asset: {
        id: assetId,
        displayName: "Example Asset",
        symbol: addSymbol,
        market: "NASDAQ",
        tradingViewSymbol: `NASDAQ:${addSymbol}`,
        currency: "USD",
        channel: "stocks",
      },
      targetPackIds: [...(options.targetPackIds ?? [])],
      decision: {
        reviewerId: "visionx-curator",
        decidedAt: "2026-07-17T22:30:00Z",
        referenceId: `visionx.asset-registration.${assetId}-v2`,
        notes: "Test proposal.",
      },
    }
    : {
      schemaVersion: 2,
      operation,
      asset: {
        id: assetId,
        displayName: `${current?.display ?? "Unknown"} Updated`,
        symbol: "AAPL",
        market: "NASDAQ",
        tradingViewSymbol: "NASDAQ:AAPL",
        currency: "USD",
        channel: current?.channel ?? "stocks",
      },
      targetPackIds: [],
      decision: {
        reviewerId: "visionx-curator",
        decidedAt: "2026-07-17T22:30:00Z",
        referenceId: `visionx.asset-registration.${assetId}-identity-v2`,
      },
      expectedCurrent: {
        display: current?.display ?? "",
        tradingView: current?.tradingView ?? "",
        channel: current?.channel ?? "stocks",
      },
    };
  const proposed = proposeAssetRegistration(proposalInput, fixture.assets, fixture.packs, fixture.channels);
  if (!proposed.ok) throw new Error(`${proposed.reason}: ${proposed.detail}`);
  const proposal = proposed.proposal;
  const proposalBytes = serializeAssetRegistrationProposal(proposal);
  const proposalSha256 = sha256(proposalBytes);
  const authorization: AssetRegistrationApplicationAuthorization = Object.freeze({
    schemaVersion: 1,
    decision: options.decision ?? "approved",
    proposalSha256,
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-18T00:30:00Z",
    referenceId: `visionx.asset-application.${assetId}-v2`,
    packPlacements: Object.freeze([...(options.placements ?? [])]),
    notes: "Test authorization.",
  });
  const authorizationBytes = serializeAssetRegistrationApplicationAuthorization(authorization);
  const authorizationSha256 = sha256(authorizationBytes);
  const planned = planAssetRegistrationApplication({
    proposal,
    proposalSha256,
    authorization,
    authorizationSha256,
    assets: fixture.assets,
    packs: fixture.packs,
    channels: fixture.channels,
  });
  if (!planned.ok) throw new Error(`${planned.reason}: ${planned.detail}`);
  const plan = planned.plan;
  const planBytes = serializeAssetRegistrationApplicationPlan(plan);
  return Object.freeze({
    fixture,
    proposal,
    proposalBytes,
    proposalSha256,
    authorization,
    authorizationBytes,
    authorizationSha256,
    plan,
    planBytes,
    planSha256: sha256(planBytes),
  });
}

function generate(value = artifacts()) {
  return generateAssetRegistrationSourceChange({
    proposal: value.proposal,
    proposalBytes: value.proposalBytes,
    proposalSha256: value.proposalSha256,
    authorization: value.authorization,
    authorizationBytes: value.authorizationBytes,
    authorizationSha256: value.authorizationSha256,
    applicationPlan: value.plan,
    applicationPlanBytes: value.planBytes,
    applicationPlanSha256: value.planSha256,
    registryBytes: value.fixture.registryBytes,
    packsBytes: value.fixture.packsBytes,
    channelsBytes: value.fixture.channelsBytes,
  });
}

describe("Asset registration source-change generation", () => {
  test("approved v2 add produces one deterministic Registry patch and receipt", () => {
    const result = generate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.generationStatus).toBe("generated_not_applied");
    expect(result.receipt.technicalValidation.planReconstructed).toBe(true);
    expect(result.receipt.patch.changedPaths).toEqual(["definitions/registry.json"]);
    expect(result.receipt.simulatedResult.registryAssetCountAfter).toBe(
      result.receipt.simulatedResult.registryAssetCountBefore + 1,
    );
    expect(result.receipt.simulatedResult.packMembershipCountAfter).toBe(
      result.receipt.simulatedResult.packMembershipCountBefore,
    );
    const registry = JSON.parse(result.registryAfterBytes.toString("utf8")) as Record<string, Record<string, unknown>>;
    expect(registry.source_change_test_asset).toEqual({
      tradingView: "NASDAQ:SOURCECHANGETESTASSET",
      display: "Example Asset",
      currency: "USD",
      channel: "stocks",
    });
    expect(result.packsAfterBytes.equals(readFileSync(resolve("definitions/packs.json")))).toBe(true);
    expect(result.patchBytes.toString("utf8")).not.toContain("1527846988270534827");
    expect(result.patchBytes.toString("utf8")).toContain('"currency": "USD"');
    expect(result.patchBytes.toString("utf8").endsWith("\n")).toBe(true);
    expect(result.receiptBytes.toString("utf8").endsWith("\n")).toBe(true);
  });

  test("identical inputs produce identical patch and receipt bytes", () => {
    const value = artifacts();
    const first = generate(value);
    const second = generate(value);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.patchBytes.equals(second.patchBytes)).toBe(true);
    expect(first.receiptBytes.equals(second.receiptBytes)).toBe(true);
    expect(serializeAssetRegistrationSourceChangeReceipt(first.receipt).equals(first.receiptBytes)).toBe(true);
  });

  test("fresh canonical plan bytes are required", () => {
    const value = artifacts();
    const nonCanonicalPlanBytes = Buffer.concat([value.planBytes, Buffer.from(" ")]);
    const result = generateAssetRegistrationSourceChange({
      proposal: value.proposal,
      proposalBytes: value.proposalBytes,
      proposalSha256: value.proposalSha256,
      authorization: value.authorization,
      authorizationBytes: value.authorizationBytes,
      authorizationSha256: value.authorizationSha256,
      applicationPlan: value.plan,
      applicationPlanBytes: nonCanonicalPlanBytes,
      applicationPlanSha256: sha256(nonCanonicalPlanBytes),
      registryBytes: value.fixture.registryBytes,
      packsBytes: value.fixture.packsBytes,
      channelsBytes: value.fixture.channelsBytes,
    });
    expect(result).toMatchObject({ ok: false, reason: "plan_reconstruction_mismatch" });
  });

  test("altered plan operations fail closed", () => {
    const value = artifacts();
    const altered = {
      ...value.plan,
      operations: [{ ...value.plan.operations[0], asset: { ...(value.plan.operations[0] as { asset: object }).asset, channel: "crypto" } }],
    };
    const alteredBytes = Buffer.from(`${JSON.stringify(altered, null, 2)}\n`);
    const result = generateAssetRegistrationSourceChange({
      proposal: value.proposal,
      proposalBytes: value.proposalBytes,
      proposalSha256: value.proposalSha256,
      authorization: value.authorization,
      authorizationBytes: value.authorizationBytes,
      authorizationSha256: value.authorizationSha256,
      applicationPlan: altered,
      applicationPlanBytes: alteredBytes,
      applicationPlanSha256: sha256(alteredBytes),
      registryBytes: value.fixture.registryBytes,
      packsBytes: value.fixture.packsBytes,
      channelsBytes: value.fixture.channelsBytes,
    });
    expect(result.ok).toBe(false);
  });

  test("rejected plans are historical artifacts but not source-change authority", () => {
    const result = generate(artifacts({ decision: "rejected" }));
    expect(result).toMatchObject({ ok: false, reason: "application_not_authorized" });
  });

  test("schema-v1 plans are not applicable", () => {
    const value = artifacts();
    const v1Plan = {
      ...value.plan,
      schemaVersion: 1,
      technicalValidation: {
        ok: true,
        proposalSha256: value.plan.technicalValidation.proposalSha256,
        authorizationSha256: value.plan.technicalValidation.authorizationSha256,
        registryFingerprintVerified: true,
        staleStateDetected: false,
      },
      proposal: {
        operation: value.plan.proposal.operation,
        assetId: value.plan.proposal.assetId,
        registryFingerprint: value.plan.proposal.registryFingerprint,
      },
      operations: [],
    };
    const bytes = Buffer.from(`${JSON.stringify(v1Plan, null, 2)}\n`);
    const result = generateAssetRegistrationSourceChange({
      proposal: value.proposal,
      proposalBytes: value.proposalBytes,
      proposalSha256: value.proposalSha256,
      authorization: value.authorization,
      authorizationBytes: value.authorizationBytes,
      authorizationSha256: value.authorizationSha256,
      applicationPlan: v1Plan,
      applicationPlanBytes: bytes,
      applicationPlanSha256: sha256(bytes),
      registryBytes: value.fixture.registryBytes,
      packsBytes: value.fixture.packsBytes,
      channelsBytes: value.fixture.channelsBytes,
    });
    expect(result).toMatchObject({ ok: false, reason: "legacy_plan_not_applicable" });
  });

  test("proposal and authorization artifact identities are verified", () => {
    const value = artifacts();
    const proposalResult = generateAssetRegistrationSourceChange({
      proposal: value.proposal,
      proposalBytes: value.proposalBytes,
      proposalSha256: "0".repeat(64),
      authorization: value.authorization,
      authorizationBytes: value.authorizationBytes,
      authorizationSha256: value.authorizationSha256,
      applicationPlan: value.plan,
      applicationPlanBytes: value.planBytes,
      applicationPlanSha256: value.planSha256,
      registryBytes: value.fixture.registryBytes,
      packsBytes: value.fixture.packsBytes,
      channelsBytes: value.fixture.channelsBytes,
    });
    expect(proposalResult).toMatchObject({ ok: false, reason: "proposal_hash_mismatch" });

    const authorizationResult = generateAssetRegistrationSourceChange({
      proposal: value.proposal,
      proposalBytes: value.proposalBytes,
      proposalSha256: value.proposalSha256,
      authorization: value.authorization,
      authorizationBytes: value.authorizationBytes,
      authorizationSha256: "0".repeat(64),
      applicationPlan: value.plan,
      applicationPlanBytes: value.planBytes,
      applicationPlanSha256: value.planSha256,
      registryBytes: value.fixture.registryBytes,
      packsBytes: value.fixture.packsBytes,
      channelsBytes: value.fixture.channelsBytes,
    });
    expect(authorizationResult).toMatchObject({ ok: false, reason: "authorization_hash_mismatch" });
  });

  test("valid same-key Discord destination rotation preserves logical plan applicability", () => {
    const rotated = sourceFixture({ stocks: "1999999999999999999" });
    const base = artifacts();
    const result = generateAssetRegistrationSourceChange({
      proposal: base.proposal,
      proposalBytes: base.proposalBytes,
      proposalSha256: base.proposalSha256,
      authorization: base.authorization,
      authorizationBytes: base.authorizationBytes,
      authorizationSha256: base.authorizationSha256,
      applicationPlan: base.plan,
      applicationPlanBytes: base.planBytes,
      applicationPlanSha256: base.planSha256,
      registryBytes: rotated.registryBytes,
      packsBytes: rotated.packsBytes,
      channelsBytes: rotated.channelsBytes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.sourceState.channels.sha256).toBe(sha256(rotated.channelsBytes));
    expect(result.patchBytes.toString("utf8")).not.toContain("1999999999999999999");
  });

  test("unresolved channel configuration fails closed", () => {
    const base = artifacts();
    const unresolved = sourceFixture({ stocks: "" });
    const result = generateAssetRegistrationSourceChange({
      proposal: base.proposal,
      proposalBytes: base.proposalBytes,
      proposalSha256: base.proposalSha256,
      authorization: base.authorization,
      authorizationBytes: base.authorizationBytes,
      authorizationSha256: base.authorizationSha256,
      applicationPlan: base.plan,
      applicationPlanBytes: base.planBytes,
      applicationPlanSha256: base.planSha256,
      registryBytes: unresolved.registryBytes,
      packsBytes: unresolved.packsBytes,
      channelsBytes: unresolved.channelsBytes,
    });
    expect(result).toMatchObject({ ok: false, reason: "unresolved_channel" });
  });

  test.each([
    ["append", { mode: "append" }],
    ["before", { mode: "before", anchorAssetId: "aapl" }],
    ["after", { mode: "after", anchorAssetId: "aapl" }],
  ] as const)("explicit %s Pack placement changes only planned membership", (_name, placement) => {
    const value = artifacts({
      assetId: `example_${placement.mode}`,
      targetPackIds: ["stocks"],
      placements: [{ packId: "stocks", placement }],
    });
    const result = generate(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.patch.changedPaths).toEqual(["definitions/packs.json", "definitions/registry.json"]);
    const packs = JSON.parse(result.packsAfterBytes.toString("utf8")) as Array<{ id: string; assets: string[] }>;
    const stocks = packs.find((pack) => pack.id === "stocks");
    expect(stocks?.assets).toContain(`example_${placement.mode}`);
    expect(result.receipt.simulatedResult.packMembershipCountAfter).toBe(
      result.receipt.simulatedResult.packMembershipCountBefore + 1,
    );
  });

  test("update_identity changes only canonical Registry identity fields and preserves Pack bytes", () => {
    const value = artifacts({ operation: "update_identity", assetId: "aapl" });
    const result = generate(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const registry = JSON.parse(result.registryAfterBytes.toString("utf8")) as Record<string, Record<string, unknown>>;
    expect(registry.aapl).toEqual({ tradingView: "NASDAQ:AAPL", display: "Apple Updated", channel: "stocks" });
    expect(result.packsAfterBytes.equals(value.fixture.packsBytes)).toBe(true);
    expect(result.patchBytes.toString("utf8")).not.toContain('"market"');
    expect(result.patchBytes.toString("utf8")).not.toContain('"currency"');
  });

  test("duplicate Registry source entries fail closed", () => {
    const value = artifacts();
    const text = value.fixture.registryBytes.toString("utf8");
    const duplicate = Buffer.from(text.replace(
      '  "aapl": {',
      '  "aapl": { "tradingView": "DUPLICATE", "display": "Duplicate", "channel": "stocks" },\n  "aapl": {',
    ));
    const result = generateAssetRegistrationSourceChange({
      proposal: value.proposal,
      proposalBytes: value.proposalBytes,
      proposalSha256: value.proposalSha256,
      authorization: value.authorization,
      authorizationBytes: value.authorizationBytes,
      authorizationSha256: value.authorizationSha256,
      applicationPlan: value.plan,
      applicationPlanBytes: value.planBytes,
      applicationPlanSha256: value.planSha256,
      registryBytes: duplicate,
      packsBytes: value.fixture.packsBytes,
      channelsBytes: value.fixture.channelsBytes,
    });
    expect(result).toMatchObject({ ok: false, reason: "source_shape_unsupported" });
  });

  test("generated patch is repo-relative, timestamp-free, and accepted by git apply --check", () => {
    const result = generate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.patchBytes.toString("utf8");
    expect(text).toContain("a/definitions/registry.json");
    expect(text).not.toContain(resolve("."));
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    const directory = mkdtempSync(join(tmpdir(), "visionx-source-patch-"));
    const patchPath = join(directory, "change.patch");
    writeFileSync(patchPath, result.patchBytes);
    const checked = spawnSync("git", ["apply", "--check", "--whitespace=nowarn", patchPath], { cwd: resolve(".") });
    rmSync(directory, { recursive: true, force: true });
    expect(checked.status).toBe(0);
  });
});

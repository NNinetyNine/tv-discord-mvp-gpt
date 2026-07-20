import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildRegistry } from "../registry/registry.ts";
import { AdminService } from "./admin-service.ts";
import { startAdminHttpServer, type RunningAdminHttpServer } from "./admin-http-server.ts";

const cleanup: string[] = [];
const servers: RunningAdminHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "visionx-asset-admin-repository-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-asset-admin-workspace-"));
  cleanup.push(repositoryRoot, workspaceRoot);
  await mkdir(join(repositoryRoot, "definitions"));
  await mkdir(join(repositoryRoot, "config"));
  for (const path of ["definitions/registry.json", "definitions/packs.json", "config/channels.json"] as const) {
    await cp(resolve(path), join(repositoryRoot, path));
  }
  const before = {
    registry: await readFile(join(repositoryRoot, "definitions/registry.json")),
    packs: await readFile(join(repositoryRoot, "definitions/packs.json")),
    channels: await readFile(join(repositoryRoot, "config/channels.json")),
  };
  return { repositoryRoot, workspaceRoot, before, service: await AdminService.create({ repositoryRoot, workspaceRoot }) };
}

function input(id = "ui-smoke-asset") {
  return {
    schemaVersion: 2, operation: "add",
    asset: { id, displayName: "UI Smoke Asset", symbol: "UISMOKE", market: "NASDAQ", tradingViewSymbol: "NASDAQ:UISMOKE", currency: "USD", channel: "stocks" },
    targetPackIds: [],
    decision: { reviewerId: "visionx-curator", decidedAt: "2026-07-19T12:00:00Z", referenceId: "visionx.ui-smoke-asset" },
  };
}

async function throughSourceChange(service: AdminService, id = "ui-smoke-asset") {
  await service.createAssetRegistrationProposal(id, input(id));
  const proposal = await service.readAssetRegistrationArtifact(id, "asset-proposal.json");
  await service.storeAssetRegistrationPlanningAuthorization(id, {
    schemaVersion: 1, decision: "approved", proposalSha256: sha256(proposal), reviewerId: "visionx-planner",
    decidedAt: "2026-07-19T12:10:00Z", referenceId: "visionx.ui-smoke-asset.plan", packPlacements: [],
  });
  await service.generateAssetRegistrationPlan(id);
  return service.generateAssetRegistrationSourceChange(id);
}

async function approveReview(service: AdminService, id = "ui-smoke-asset") {
  await service.reviewAssetRegistration(id, {
    schemaVersion: 1, decision: "approved", reviewerId: "visionx-reviewer",
    decidedAt: "2026-07-19T12:20:00Z", referenceId: "visionx.ui-smoke-asset.review",
  });
  const [review, patch, receipt] = await Promise.all([
    service.readAssetRegistrationArtifact(id, "asset-source-review.json"),
    service.readAssetRegistrationArtifact(id, "asset-source.patch"),
    service.readAssetRegistrationArtifact(id, "asset-source-change.json"),
  ]);
  return service.storeAssetRegistrationApplicationAuthorization(id, {
    schemaVersion: 1, decision: "approved", sourceChangeReviewSha256: sha256(review), sourcePatchSha256: sha256(patch), sourceChangeReceiptSha256: sha256(receipt),
    reviewerId: "visionx-authorizer", decidedAt: "2026-07-19T12:30:00Z", referenceId: "visionx.ui-smoke-asset.apply",
  });
}

describe("Administration Asset registration custody chain", () => {
  it("uses separate proposal, planning, plan, source-change, review, authorization, and explicit Apply gates", async () => {
    const { service, repositoryRoot, before } = await fixture();
    await throughSourceChange(service);
    let status = await approveReview(service);
    expect(status.gates).toMatchObject({ reviewApproved: true, applicationAuthorizationApproved: true, applyEnabled: true, applied: false });
    expect(await readFile(join(repositoryRoot, "definitions/registry.json"))).toEqual(before.registry);
    await expect(service.applyAssetRegistration("ui-smoke-asset", "apply asset source change")).rejects.toMatchObject({ code: "application_confirmation_invalid" });
    await expect(service.applyAssetRegistration("ui-smoke-asset", " APPLY ASSET SOURCE CHANGE ")).rejects.toMatchObject({ code: "application_confirmation_invalid" });
    await expect(service.applyAssetRegistration("ui-smoke-asset", "")).rejects.toMatchObject({ code: "application_confirmation_required" });

    const applied = await service.applyAssetRegistration("ui-smoke-asset", "APPLY ASSET SOURCE CHANGE");
    status = applied.status as typeof status;
    expect(status.gates).toMatchObject({ applied: true, applyEnabled: false });
    expect(status.currentCanonicalState).toMatchObject({ registryAssetCount: 132 });
    expect(await readFile(join(repositoryRoot, "definitions/packs.json"))).toEqual(before.packs);
    expect(await readFile(join(repositoryRoot, "config/channels.json"))).toEqual(before.channels);
    const channels = JSON.parse(before.channels.toString("utf8")) as Record<string, unknown>;
    const registry = buildRegistry(JSON.parse((await readFile(join(repositoryRoot, "definitions/registry.json"))).toString("utf8")), channels);
    expect(registry.all().find((asset) => asset.id === "ui-smoke-asset")).toMatchObject({ id: "ui-smoke-asset", display: "UI Smoke Asset", tradingView: "NASDAQ:UISMOKE", channel: "stocks" });
    await expect(service.applyAssetRegistration("ui-smoke-asset", "APPLY ASSET SOURCE CHANGE")).rejects.toMatchObject({ code: expect.stringMatching(/application_already_completed|stale_registry_state/) });
  });

  it("stores rejected gates durably while blocking all downstream application", async () => {
    const first = await fixture();
    await first.service.createAssetRegistrationProposal("ui-smoke-asset", input());
    const proposal = await first.service.readAssetRegistrationArtifact("ui-smoke-asset", "asset-proposal.json");
    await first.service.storeAssetRegistrationPlanningAuthorization("ui-smoke-asset", {
      schemaVersion: 1, decision: "rejected", proposalSha256: sha256(proposal), reviewerId: "visionx-planner",
      decidedAt: "2026-07-19T12:10:00Z", referenceId: "visionx.reject.plan", packPlacements: [],
    });
    await expect(first.service.generateAssetRegistrationPlan("ui-smoke-asset")).rejects.toMatchObject({ code: "planning_authorization_rejected" });
    expect((await first.service.assetRegistrationStatus("ui-smoke-asset")).gates).toMatchObject({ planningAuthorizationStored: true, planCreated: false });
    expect(await readFile(join(first.repositoryRoot, "definitions/registry.json"))).toEqual(first.before.registry);

    const second = await fixture();
    await throughSourceChange(second.service);
    const rejectedReview = await second.service.reviewAssetRegistration("ui-smoke-asset", {
      schemaVersion: 1, decision: "rejected", reviewerId: "visionx-reviewer", decidedAt: "2026-07-19T12:20:00Z", referenceId: "visionx.reject.review",
    });
    expect(rejectedReview.gates).toMatchObject({ reviewCreated: true, reviewApproved: false, applyEnabled: false });
    expect((await second.service.readAssetRegistrationArtifact("ui-smoke-asset", "asset-source-review.json")).toString("utf8")).toContain('"reviewStatus": "rejected"');
    expect(await readFile(join(second.repositoryRoot, "definitions/registry.json"))).toEqual(second.before.registry);

    const third = await fixture();
    await throughSourceChange(third.service);
    await third.service.reviewAssetRegistration("ui-smoke-asset", { schemaVersion: 1, decision: "approved", reviewerId: "visionx-reviewer", decidedAt: "2026-07-19T12:20:00Z", referenceId: "visionx.approve.review" });
    const [review, patch, receipt] = await Promise.all([
      third.service.readAssetRegistrationArtifact("ui-smoke-asset", "asset-source-review.json"),
      third.service.readAssetRegistrationArtifact("ui-smoke-asset", "asset-source.patch"),
      third.service.readAssetRegistrationArtifact("ui-smoke-asset", "asset-source-change.json"),
    ]);
    const rejectedAuthorization = await third.service.storeAssetRegistrationApplicationAuthorization("ui-smoke-asset", {
      schemaVersion: 1, decision: "rejected", sourceChangeReviewSha256: sha256(review), sourcePatchSha256: sha256(patch), sourceChangeReceiptSha256: sha256(receipt),
      reviewerId: "visionx-authorizer", decidedAt: "2026-07-19T12:30:00Z", referenceId: "visionx.reject.apply",
    });
    expect(rejectedAuthorization.gates).toMatchObject({ reviewApproved: true, applicationAuthorizationStored: true, applicationAuthorizationApproved: false, applyEnabled: false });
    await expect(third.service.applyAssetRegistration("ui-smoke-asset", "APPLY ASSET SOURCE CHANGE")).rejects.toMatchObject({ code: "application_authorization_rejected" });
    expect(await readFile(join(third.repositoryRoot, "definitions/registry.json"))).toEqual(third.before.registry);
  });

  it("fails closed when stored registration input no longer reconstructs the exact proposal", async () => {
    const { service } = await fixture();
    await service.createAssetRegistrationProposal("ui-smoke-asset", input());
    const inputPath = await service.assetRegistrations.artifactPath("ui-smoke-asset", "registration-input.json");
    const changed = JSON.parse((await readFile(inputPath)).toString("utf8")) as ReturnType<typeof input>;
    changed.asset.displayName = "Changed after proposal";
    await writeFile(inputPath, `${JSON.stringify(changed, null, 2)}\n`);
    const proposal = await service.readAssetRegistrationArtifact("ui-smoke-asset", "asset-proposal.json");
    await expect(service.storeAssetRegistrationPlanningAuthorization("ui-smoke-asset", {
      schemaVersion: 1, decision: "approved", proposalSha256: sha256(proposal), reviewerId: "visionx-planner",
      decidedAt: "2026-07-19T12:10:00Z", referenceId: "visionx.changed-input.plan", packPlacements: [],
    })).rejects.toMatchObject({ code: "proposal_reconstruction_mismatch" });
    expect((await service.assetRegistrationStatus("ui-smoke-asset")).gates).toMatchObject({ inputMatchesProposal: false, proposalCreated: false });
  });

  it("rejects unknown fields, unsupported channels, no-overwrite outputs, and stale Registry state", async () => {
    const { service, repositoryRoot } = await fixture();
    await expect(service.createAssetRegistrationProposal("ui-smoke-asset", { ...input(), unexpected: true })).rejects.toMatchObject({ code: "invalid_asset_registration_input" });
    await expect(service.createAssetRegistrationProposal("ui-smoke-asset", { ...input(), asset: { ...input().asset, channel: "unsupported" } })).rejects.toMatchObject({ code: "unknown_channel" });
    await throughSourceChange(service);
    await expect(service.generateAssetRegistrationSourceChange("ui-smoke-asset")).rejects.toMatchObject({ code: "output_already_exists" });
    const registryPath = join(repositoryRoot, "definitions/registry.json");
    const value = JSON.parse((await readFile(registryPath)).toString("utf8")) as Record<string, unknown>;
    value.unrelated_stale_asset = { tradingView: "NASDAQ:STALE", display: "Stale", channel: "stocks" };
    await writeFile(registryPath, `${JSON.stringify(value, null, 2)}\n`);
    await expect(service.reviewAssetRegistration("ui-smoke-asset", { schemaVersion: 1, decision: "approved", reviewerId: "visionx-reviewer", decidedAt: "2026-07-19T12:20:00Z", referenceId: "visionx.stale.review" })).rejects.toMatchObject({ code: "stale_registry_state" });
  });

  it("exposes the complete chain through real loopback HTTP with strict origin and content-type handling", async () => {
    const { service } = await fixture();
    const server = await startAdminHttpServer({ service, host: "127.0.0.1", port: 0 }); servers.push(server);
    const request = async (path: string, value: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${server.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
      return { response, body: await response.json() as any };
    };
    const foreign = await request("/api/v1/asset-registrations/ui-smoke-asset/apply", { confirmation: "APPLY ASSET SOURCE CHANGE" }, { Origin: "https://example.invalid" });
    expect(foreign).toMatchObject({ response: { status: 403 }, body: { error: { code: "origin_rejected" } } });
    const wrongType = await fetch(`${server.url}/api/v1/asset-registrations/ui-smoke-asset/proposal`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(wrongType.status).toBe(415);
    expect(((await wrongType.json()) as any).error.code).toBe("invalid_content_type");

    const proposal = await request("/api/v1/asset-registrations/ui-smoke-asset/proposal", { input: input() });
    expect(proposal.response.status).toBe(201);
    const statusResponse = await fetch(`${server.url}/api/v1/asset-registrations/ui-smoke-asset/status`);
    expect((await statusResponse.json() as any).data).toMatchObject({ workspaceState: "noncanonical", gates: { proposalCreated: true, planningAuthorized: false } });
    const download = await fetch(`${server.url}/api/v1/asset-registrations/ui-smoke-asset/artifacts/asset-proposal.json`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("asset-proposal.json");
  });
});

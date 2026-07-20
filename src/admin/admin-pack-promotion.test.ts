import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AdminService } from "./admin-service.ts";
import { startAdminHttpServer } from "./admin-http-server.ts";
import { sha256 } from "../packs/pack-draft-promotion.ts";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function serviceWithDraft() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-promotion-")); cleanup.push(workspaceRoot);
  const service = await AdminService.create({ repositoryRoot: resolve("."), workspaceRoot });
  const created = await service.createDraft({ schemaVersion: 1, draftType: "visionx.pack-draft", id: "qa-pack", displayName: "QA Pack", description: "Workspace-only description.", assetIds: ["gold", "aapl", "btc"], revision: 1 });
  await service.updateDraft("qa-pack", 1, created.draft);
  return { service, workspaceRoot };
}
function promotionRequest() {
  return { schemaVersion: 1, requestType: "visionx.pack-draft-promotion-request", operation: "create_pack", draftId: "qa-pack", expectedRevision: 2, channel: "stocks", curatorId: "visionx-curator", decidedAt: "2026-07-19T01:00:00Z", referenceId: "visionx.pack-draft-promotion.qa-pack-v1", notes: "Prepare exact source artifacts." };
}

describe("Administration Pack promotion integration", () => {
  it("exposes configured logical channels without numeric Discord destinations", async () => {
    const { service } = await serviceWithDraft();
    expect(service.logicalChannels()).toEqual(["commodities", "crypto", "etfs", "forex", "indices", "stocks"]);
    expect(JSON.stringify(service.logicalChannels())).not.toContain("152784");
    expect(JSON.stringify(service.logicalChannels())).not.toContain("1528609079822516305");
  });
  it("creates proposal, plan, and source-change artifacts only beneath the workspace", async () => {
    const { service, workspaceRoot } = await serviceWithDraft();
    const proposal = await service.createPackPromotionProposal("qa-pack", promotionRequest());
    const proposalBytes = await service.readPackPromotionArtifact("qa-pack", proposal.promotionId, "pack-proposal.json");
    const requestBytes = await service.readPackPromotionArtifact("qa-pack", proposal.promotionId, "promotion-request.json");
    const draftBytes = await service.exportDraft("qa-pack");
    const authorization = { schemaVersion: 1, decision: "approved", packProposalSha256: sha256(proposalBytes), draftSha256: sha256(draftBytes), promotionRequestSha256: sha256(requestBytes), curatorId: "visionx-curator", decidedAt: "2026-07-19T01:15:00Z", referenceId: "visionx.pack-source-planning.qa-pack-v1", notes: "Authorize deterministic planning only." };
    await service.planPackPromotion("qa-pack", proposal.promotionId, authorization);
    await service.generatePackPromotionSourceChange("qa-pack", proposal.promotionId);
    const artifacts = await service.listPackPromotionArtifacts("qa-pack", proposal.promotionId);
    expect(artifacts.map((entry: any) => entry.name)).toEqual(["promotion-request.json", "pack-proposal.json", "planning-authorization.json", "pack-application-plan.json", "pack-source.patch", "pack-source-change.json", "packs-after.json"]);
    expect((await service.readPackPromotionArtifact("qa-pack", proposal.promotionId, "pack-source.patch")).toString("utf8")).toContain("definitions/packs.json");
    expect((await readFile(resolve("definitions/packs.json")))).toEqual(service.promotionContext().packsBytes);
    expect(workspaceRoot).not.toBe(resolve("definitions"));
  });
  it("rejects manually supplied channel mutation for replace_pack_assets", async () => {
    const { service } = await serviceWithDraft();
    await expect(service.createPackPromotionProposal("qa-pack", { ...promotionRequest(), operation: "replace_pack_assets", channel: "crypto" })).rejects.toMatchObject({ code: "pack_channel_change_not_supported" });
  });
  it("serves promotion APIs and exact artifact downloads", async () => {
    const { service } = await serviceWithDraft(); const server = await startAdminHttpServer({ service, port: 0 });
    try {
      const channels = await fetch(`${server.url}/api/v1/channels`).then((response) => response.json()) as any;
      expect(channels.data.logicalChannels).toEqual(["commodities", "crypto", "etfs", "forex", "indices", "stocks"]);
      const proposalResponse = await fetch(`${server.url}/api/v1/pack-drafts/qa-pack/promotion/proposal`, { method: "POST", headers: { "Content-Type": "application/json", Origin: server.url }, body: JSON.stringify({ request: promotionRequest() }) });
      expect(proposalResponse.status).toBe(201);
      const proposalData = await proposalResponse.json() as any; const promotionId = proposalData.data.promotionId as string;
      const proposalBytes = Buffer.from(await fetch(`${server.url}/api/v1/pack-drafts/qa-pack/promotion/${promotionId}/artifacts/pack-proposal.json`).then((response) => response.text()), "utf8");
      const requestBytes = Buffer.from(await fetch(`${server.url}/api/v1/pack-drafts/qa-pack/promotion/${promotionId}/artifacts/promotion-request.json`).then((response) => response.text()), "utf8");
      const authorization = { schemaVersion: 1, decision: "approved", packProposalSha256: sha256(proposalBytes), draftSha256: sha256(await service.exportDraft("qa-pack")), promotionRequestSha256: sha256(requestBytes), curatorId: "visionx-curator", decidedAt: "2026-07-19T01:15:00Z", referenceId: "visionx.pack-source-planning.qa-pack-v1" };
      expect((await fetch(`${server.url}/api/v1/pack-drafts/qa-pack/promotion/${promotionId}/plan`, { method: "POST", headers: { "Content-Type": "application/json", Origin: server.url }, body: JSON.stringify({ authorization }) })).status).toBe(201);
      expect((await fetch(`${server.url}/api/v1/pack-drafts/qa-pack/promotion/${promotionId}/source-change`, { method: "POST", headers: { "Content-Type": "application/json", Origin: server.url }, body: "{}" })).status).toBe(201);
      const artifactList = await fetch(`${server.url}/api/v1/pack-drafts/qa-pack/promotion/${promotionId}/artifacts`).then((response) => response.json()) as any;
      expect(artifactList.data.artifacts.some((entry: any) => entry.name === "pack-source.patch")).toBe(true);
    } finally { await server.close(); }
  });
  it("UI requires explicit channel selection and contains no Apply control", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8"); const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(html).toContain("Logical Pack channel"); expect(html).toContain("Select explicitly"); expect(html).toContain("Existing immutable Pack channel"); expect(html).toContain("Prepared only — canonical Pack source has not changed");
    expect(html).not.toMatch(/<button[^>]*>\s*Apply\s*<\/button>/iu);
    expect(js).toContain('/api/v1/channels'); expect(js).toContain('#promotion-channel'); expect(js).toContain('#asset-registration-channel'); expect(js).toContain('operation === "create_pack" ? { channel } : {}'); expect(js).not.toContain("majority");
  });
  it("foreign-origin promotion writes remain rejected", async () => {
    const { service } = await serviceWithDraft(); const server = await startAdminHttpServer({ service, port: 0 });
    try {
      const response = await fetch(`${server.url}/api/v1/pack-drafts/qa-pack/promotion/proposal`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify({ request: promotionRequest() }) });
      expect(response.status).toBe(403); const body = await response.json() as any; expect(body.error.code).toBe("origin_rejected");
    } finally { await server.close(); }
  });
});

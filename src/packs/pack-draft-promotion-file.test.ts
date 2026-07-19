import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { serializePackDraft } from "../admin/admin-types.ts";
import { sha256 } from "./pack-draft-promotion.ts";
import {
  generatePackSourceChangeFile,
  planPackSourceChangeFile,
  proposePackDraftPromotionFile,
} from "./pack-draft-promotion-file.ts";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "visionx-pack-promotion-file-")); cleanup.push(root);
  const workspace = join(root, "workspace"); const output = join(root, "output");
  await mkdir(join(workspace, "pack-drafts"), { recursive: true }); await mkdir(output);
  const draftBytes = serializePackDraft({ schemaVersion: 1, draftType: "visionx.pack-draft", id: "qa-pack", displayName: "QA Pack", description: "Workspace-only description.", assetIds: ["gold", "aapl", "btc"], revision: 2 });
  await writeFile(join(workspace, "pack-drafts/qa-pack.json"), draftBytes);
  const request = {
    schemaVersion: 1, requestType: "visionx.pack-draft-promotion-request", operation: "create_pack", draftId: "qa-pack", expectedRevision: 2, channel: "stocks",
    curatorId: "visionx-curator", decidedAt: "2026-07-19T01:00:00Z", referenceId: "visionx.pack-draft-promotion.qa-pack-v1", notes: "Prepare exact source artifacts.",
  };
  const requestPath = join(output, "request.json"); await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  return { root, workspace, output, requestPath, draftBytes };
}

async function fullChain() {
  const setupValue = await setup();
  const proposalPath = join(setupValue.output, "proposal.json");
  const proposal = await proposePackDraftPromotionFile({ repositoryRoot: resolve("."), workspaceRoot: setupValue.workspace, requestPath: setupValue.requestPath, outputPath: proposalPath });
  if (!proposal.ok) throw new Error(`${proposal.reason}: ${proposal.detail}`);
  const authorizationPath = join(setupValue.output, "authorization.json");
  await writeFile(authorizationPath, `${JSON.stringify({ schemaVersion: 1, decision: "approved", packProposalSha256: proposal.value.sha256, draftSha256: sha256(setupValue.draftBytes), promotionRequestSha256: sha256(await readFile(setupValue.requestPath)), curatorId: "visionx-curator", decidedAt: "2026-07-19T01:15:00Z", referenceId: "visionx.pack-source-planning.qa-pack-v1", notes: "Authorize deterministic planning only." }, null, 2)}\n`);
  const planPath = join(setupValue.output, "plan.json");
  const plan = await planPackSourceChangeFile({ repositoryRoot: resolve("."), workspaceRoot: setupValue.workspace, requestPath: setupValue.requestPath, proposalPath, authorizationPath, outputPath: planPath });
  if (!plan.ok) throw new Error(`${plan.reason}: ${plan.detail}`);
  return { ...setupValue, proposalPath, proposal, authorizationPath, planPath, plan };
}

describe("Pack promotion file custody", () => {
  it("writes a deterministic proposal without changing draft bytes", async () => {
    const value = await setup(); const before = await readFile(join(value.workspace, "pack-drafts/qa-pack.json"));
    const result = await proposePackDraftPromotionFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, outputPath: join(value.output, "proposal.json") });
    expect(result.ok).toBe(true); expect(await readFile(join(value.workspace, "pack-drafts/qa-pack.json"))).toEqual(before);
  });
  it("rejects existing proposal output without overwrite", async () => {
    const value = await setup(); const outputPath = join(value.output, "proposal.json"); await writeFile(outputPath, "existing");
    const result = await proposePackDraftPromotionFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, outputPath });
    expect(result).toMatchObject({ ok: false, reason: "output_already_exists" }); expect(await readFile(outputPath, "utf8")).toBe("existing");
  });
  it("rejects input/output collisions", async () => {
    const value = await setup();
    expect(await proposePackDraftPromotionFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, outputPath: value.requestPath })).toMatchObject({ ok: false, reason: "path_collision" });
  });
  it("rejected authorization creates no plan", async () => {
    const value = await setup(); const proposalPath = join(value.output, "proposal.json");
    const proposal = await proposePackDraftPromotionFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, outputPath: proposalPath }); if (!proposal.ok) throw new Error("proposal failed");
    const authorizationPath = join(value.output, "rejected.json"); await writeFile(authorizationPath, `${JSON.stringify({ schemaVersion: 1, decision: "rejected", packProposalSha256: proposal.value.sha256, draftSha256: sha256(value.draftBytes), promotionRequestSha256: sha256(await readFile(value.requestPath)), curatorId: "visionx-curator", decidedAt: "2026-07-19T01:15:00Z", referenceId: "visionx.pack-source-planning.qa-pack-rejected-v1" }, null, 2)}\n`);
    const outputPath = join(value.output, "plan.json"); const result = await planPackSourceChangeFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, proposalPath, authorizationPath, outputPath });
    expect(result).toMatchObject({ ok: false, reason: "planning_authorization_rejected" }); await expect(readFile(outputPath)).rejects.toBeTruthy();
  });
  it("writes patch, receipt, and future Packs transactionally", async () => {
    const value = await fullChain();
    const patch = join(value.output, "source.patch"); const receipt = join(value.output, "source-change.json"); const after = join(value.output, "packs-after.json");
    const result = await generatePackSourceChangeFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, proposalPath: value.proposalPath, authorizationPath: value.authorizationPath, planPath: value.planPath, patchOutputPath: patch, receiptOutputPath: receipt, packsAfterOutputPath: after });
    expect(result.ok).toBe(true); expect((await readFile(patch, "utf8"))).toContain("definitions/packs.json"); expect(JSON.parse(await readFile(after, "utf8")).at(-1)).toMatchObject({ id: "qa-pack", channel: "stocks" });
  });
  it("rejects output/output collisions", async () => {
    const value = await fullChain(); const same = join(value.output, "same.out");
    expect(await generatePackSourceChangeFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, proposalPath: value.proposalPath, authorizationPath: value.authorizationPath, planPath: value.planPath, patchOutputPath: same, receiptOutputPath: same })).toMatchObject({ ok: false, reason: "path_collision" });
  });
  it("identical chains produce identical artifact bytes at different paths", async () => {
    const value = await fullChain();
    const first = await generatePackSourceChangeFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, proposalPath: value.proposalPath, authorizationPath: value.authorizationPath, planPath: value.planPath, patchOutputPath: join(value.output, "a.patch"), receiptOutputPath: join(value.output, "a.json") });
    const second = await generatePackSourceChangeFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, proposalPath: value.proposalPath, authorizationPath: value.authorizationPath, planPath: value.planPath, patchOutputPath: join(value.output, "b.patch"), receiptOutputPath: join(value.output, "b.json") });
    expect(first.ok && second.ok).toBe(true); if (first.ok && second.ok) { expect(first.value.patch).toEqual(second.value.patch); expect(first.value.receiptBytes).toEqual(second.value.receiptBytes); }
  });
  it("never overwrites an existing source-change output", async () => {
    const value = await fullChain(); const patch = join(value.output, "existing.patch"); const receipt = join(value.output, "receipt.json"); await writeFile(patch, "preserve");
    const result = await generatePackSourceChangeFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, proposalPath: value.proposalPath, authorizationPath: value.authorizationPath, planPath: value.planPath, patchOutputPath: patch, receiptOutputPath: receipt });
    expect(result).toMatchObject({ ok: false, reason: "output_already_exists" }); expect(await readFile(patch, "utf8")).toBe("preserve"); await expect(readFile(receipt)).rejects.toBeTruthy();
  });
  it("leaves canonical Registry, Packs, and channels byte-identical", async () => {
    const value = await fullChain(); const paths = [resolve("definitions/registry.json"), resolve("definitions/packs.json"), resolve("config/channels.json")]; const before = await Promise.all(paths.map((path) => readFile(path)));
    const result = await generatePackSourceChangeFile({ repositoryRoot: resolve("."), workspaceRoot: value.workspace, requestPath: value.requestPath, proposalPath: value.proposalPath, authorizationPath: value.authorizationPath, planPath: value.planPath, patchOutputPath: join(value.output, "source.patch"), receiptOutputPath: join(value.output, "source.json") });
    expect(result.ok).toBe(true); expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  });
});

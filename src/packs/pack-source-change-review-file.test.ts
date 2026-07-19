import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { serializePackDraft } from "../admin/admin-types.ts";
import { reviewPackSourceChangeFile } from "./pack-source-change-review-file.ts";
import { sha256 } from "./pack-draft-promotion.ts";
import { makePackSourceReviewApplicationFixture } from "./pack-source-review-application.test-fixture.ts";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "visionx-pack-review-file-"));
  const repo = join(root, "repo"); const workspace = join(root, "workspace"); const inputs = join(root, "inputs");
  await mkdir(join(repo, "definitions"), { recursive: true }); await mkdir(join(repo, "config"), { recursive: true }); await mkdir(join(workspace, "pack-drafts"), { recursive: true }); await mkdir(inputs);
  const f = makePackSourceReviewApplicationFixture();
  await writeFile(join(repo, "definitions/registry.json"), f.registryBytes); await writeFile(join(repo, "definitions/packs.json"), f.packsBytes); await writeFile(join(repo, "config/channels.json"), f.channelsBytes);
  await writeFile(join(workspace, "pack-drafts/qa-pack.json"), serializePackDraft(f.draft));
  const files = {
    promotionRequestPath: join(inputs, "request.json"), proposalPath: join(inputs, "proposal.json"), planningAuthorizationPath: join(inputs, "planning.json"),
    planPath: join(inputs, "plan.json"), patchPath: join(inputs, "change.patch"), sourceChangePath: join(inputs, "change.json"), decisionPath: join(inputs, "decision.json"),
  };
  for (const [path, bytes] of [[files.promotionRequestPath, f.requestBytes], [files.proposalPath, f.proposalBytes], [files.planningAuthorizationPath, f.planningAuthorizationBytes], [files.planPath, f.planBytes], [files.patchPath, f.generated.patch], [files.sourceChangePath, f.sourceChangeReceiptBytes], [files.decisionPath, f.reviewDecisionBytes]] as const) await writeFile(path, bytes);
  return { root, repo, workspace, files, f };
}

describe("Pack source-change review file custody", () => {
  it("writes one deterministic no-overwrite review receipt without source mutation", async () => {
    const s = await setup(); const output = join(s.root, "review.json");
    try {
      const before = sha256(await readFile(join(s.repo, "definitions/packs.json")));
      const result = await reviewPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.files, outputPath: output });
      expect(result).toMatchObject({ ok: true, receipt: { decision: "approved" } });
      expect(sha256(await readFile(join(s.repo, "definitions/packs.json")))).toBe(before);
      expect((await reviewPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.files, outputPath: output }))).toMatchObject({ ok: false, reason: "output_already_exists" });
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it("rejects input/output collision", async () => {
    const s = await setup(); try {
      expect(await reviewPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.files, outputPath: s.files.decisionPath })).toMatchObject({ ok: false, reason: "path_collision" });
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it("detects an input mutation before finalization", async () => {
    const s = await setup(); try {
      const result = await reviewPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.files, outputPath: join(s.root, "review.json") }, { beforeFinalize: async () => { await writeFile(s.files.decisionPath, Buffer.concat([s.f.reviewDecisionBytes, Buffer.from(" ")])); } });
      expect(result).toMatchObject({ ok: false, reason: "input_changed_during_operation" });
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it("does not expose caller paths in receipt bytes", async () => {
    const a = await setup(); const b = await setup();
    try {
      const ar = await reviewPackSourceChangeFile({ repositoryRoot: a.repo, workspaceRoot: a.workspace, ...a.files, outputPath: join(a.root, "a.json") });
      const br = await reviewPackSourceChangeFile({ repositoryRoot: b.repo, workspaceRoot: b.workspace, ...b.files, outputPath: join(b.root, "b.json") });
      expect(ar.ok && br.ok && (await readFile(join(a.root, "a.json"))).equals(await readFile(join(b.root, "b.json")))).toBe(true);
    } finally { await rm(a.root, { recursive: true, force: true }); await rm(b.root, { recursive: true, force: true }); }
  });
});

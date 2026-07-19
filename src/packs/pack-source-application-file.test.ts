import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { serializePackDraft } from "../admin/admin-types.ts";
import { applyPackSourceChangeFile } from "./pack-source-application-file.ts";
import { sha256 } from "./pack-draft-promotion.ts";
import { makePackSourceReviewApplicationFixture } from "./pack-source-review-application.test-fixture.ts";

async function setup(reviewDecision: "approved" | "rejected" = "approved", authorizationDecision: "approved" | "rejected" = "approved") {
  const root = await mkdtemp(join(tmpdir(), "visionx-pack-apply-file-")); const repo = join(root, "repo"); const workspace = join(root, "workspace"); const inputs = join(root, "inputs");
  await mkdir(join(repo, "definitions"), { recursive: true }); await mkdir(join(repo, "config"), { recursive: true }); await mkdir(join(workspace, "pack-drafts"), { recursive: true }); await mkdir(inputs);
  const f = makePackSourceReviewApplicationFixture(reviewDecision, authorizationDecision);
  await writeFile(join(repo, "definitions/registry.json"), f.registryBytes); await writeFile(join(repo, "definitions/packs.json"), f.packsBytes); await writeFile(join(repo, "config/channels.json"), f.channelsBytes); await writeFile(join(workspace, "pack-drafts/qa-pack.json"), serializePackDraft(f.draft));
  const specs = {
    promotionRequestPath: ["request.json", f.requestBytes], proposalPath: ["proposal.json", f.proposalBytes], planningAuthorizationPath: ["planning.json", f.planningAuthorizationBytes], planPath: ["plan.json", f.planBytes], patchPath: ["change.patch", f.generated.patch], sourceChangePath: ["change.json", f.sourceChangeReceiptBytes], reviewDecisionPath: ["review-decision.json", f.reviewDecisionBytes], reviewPath: ["review.json", f.reviewBytes], applicationAuthorizationPath: ["application-authorization.json", f.applicationAuthorizationBytes],
  } as const;
  const paths = {} as Record<keyof typeof specs, string>;
  for (const [key, [name, bytes]] of Object.entries(specs) as [keyof typeof specs, readonly [string, Buffer]][]) { const path = join(inputs, name); await writeFile(path, bytes); paths[key] = path; }
  return { root, repo, workspace, paths, f };
}

describe("Pack source application file transaction", () => {
  it("atomically applies exact Packs bytes and writes a deterministic receipt", async () => {
    const s = await setup(); const output = join(s.root, "application.json");
    try {
      const result = await applyPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.paths, receiptOutputPath: output });
      expect(result).toMatchObject({ ok: true, receipt: { applicationStatus: "applied", sourceChangesApplied: true } });
      expect(sha256(await readFile(join(s.repo, "definitions/packs.json")))).toBe(sha256(s.f.generated.packsAfter));
      expect(sha256(await readFile(join(s.repo, "definitions/registry.json")))).toBe(sha256(s.f.registryBytes));
      expect(sha256(await readFile(join(s.repo, "config/channels.json")))).toBe(sha256(s.f.channelsBytes));
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it("rejects rejected review and rejected authorization without source change", async () => {
    for (const pair of [["rejected", "approved", "source_change_review_rejected"], ["approved", "rejected", "application_authorization_rejected"]] as const) {
      const s = await setup(pair[0], pair[1]); try {
        const result = await applyPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.paths, receiptOutputPath: join(s.root, "application.json") });
        expect(result).toMatchObject({ ok: false, reason: pair[2] });
        expect(sha256(await readFile(join(s.repo, "definitions/packs.json")))).toBe(sha256(s.f.packsBytes));
      } finally { await rm(s.root, { recursive: true, force: true }); }
    }
  });

  it("rolls back exact source bytes when receipt finalization fails", async () => {
    const s = await setup(); try {
      const result = await applyPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.paths, receiptOutputPath: join(s.root, "application.json") }, { beforeReceiptFinalize: async () => { throw new Error("injected receipt failure"); } });
      expect(result).toMatchObject({ ok: false, reason: "application_receipt_finalize_failed" });
      expect(sha256(await readFile(join(s.repo, "definitions/packs.json")))).toBe(sha256(s.f.packsBytes));
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it("fails closed on replay and creates no second receipt", async () => {
    const s = await setup(); try {
      const first = join(s.root, "first.json"); const second = join(s.root, "second.json");
      expect(await applyPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.paths, receiptOutputPath: first })).toMatchObject({ ok: true });
      expect(await applyPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.paths, receiptOutputPath: second })).toMatchObject({ ok: false, reason: "source_change_already_applied" });
      await expect(readFile(second)).rejects.toBeDefined();
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it("rejects receipt collisions without changing source", async () => {
    const s = await setup(); try {
      expect(await applyPackSourceChangeFile({ repositoryRoot: s.repo, workspaceRoot: s.workspace, ...s.paths, receiptOutputPath: join(s.repo, "definitions/packs.json") })).toMatchObject({ ok: false, reason: "path_collision" });
      expect(sha256(await readFile(join(s.repo, "definitions/packs.json")))).toBe(sha256(s.f.packsBytes));
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });
});

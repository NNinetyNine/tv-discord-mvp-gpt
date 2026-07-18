import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { AdminWorkspace } from "./admin-workspace.ts";
import { PACK_DRAFT_TYPE, serializePackDraft, type PackDraft } from "./admin-types.ts";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function draft(overrides: Partial<PackDraft> = {}): PackDraft {
  return {
    schemaVersion: 1,
    draftType: PACK_DRAFT_TYPE,
    id: "qa-pack",
    displayName: "QA Pack",
    description: "Workspace verification.",
    assetIds: ["aapl", "btc", "gold"],
    revision: 1,
    ...overrides,
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "visionx-admin-workspace-test-"));
  cleanup.push(root);
  return AdminWorkspace.open({ workspaceRoot: root });
}

const IDS = new Set(["aapl", "btc", "gold"]);

describe("AdminWorkspace", () => {
  it("creates the Pack draft directory safely", async () => {
    const ws = await workspace();
    expect((await readdir(ws.root)).sort()).toEqual(["pack-drafts"]);
  });

  it("creates and reloads a deterministic draft", async () => {
    const ws = await workspace();
    const created = await ws.createDraft(draft(), IDS);
    expect(await ws.readDraft(created.id, IDS)).toEqual(created);
    expect(await ws.exportDraft(created.id, IDS)).toEqual(serializePackDraft(created));
  });

  it("permits valid empty drafts", async () => {
    const ws = await workspace();
    const created = await ws.createDraft(draft({ assetIds: [] }), IDS);
    expect(created.assetIds).toEqual([]);
  });

  it("rejects creating an existing draft without overwrite", async () => {
    const ws = await workspace();
    await ws.createDraft(draft(), IDS);
    const before = await ws.exportDraft("qa-pack", IDS);
    await expect(ws.createDraft(draft({ displayName: "Replacement" }), IDS)).rejects.toMatchObject({ code: "draft_already_exists" });
    expect(await ws.exportDraft("qa-pack", IDS)).toEqual(before);
  });

  it("updates and increments revision", async () => {
    const ws = await workspace();
    await ws.createDraft(draft(), IDS);
    const updated = await ws.updateDraft({ expectedRevision: 1, draft: draft({ displayName: "QA Pack 2" }) }, IDS);
    expect(updated.revision).toBe(2);
    expect(updated.displayName).toBe("QA Pack 2");
  });

  it("rejects stale revision without changing bytes", async () => {
    const ws = await workspace();
    await ws.createDraft(draft(), IDS);
    await ws.updateDraft({ expectedRevision: 1, draft: draft({ displayName: "QA Pack 2" }) }, IDS);
    const before = await ws.exportDraft("qa-pack", IDS);
    await expect(ws.updateDraft({ expectedRevision: 1, draft: draft({ displayName: "Stale" }) }, IDS)).rejects.toMatchObject({ code: "draft_revision_conflict" });
    expect(await ws.exportDraft("qa-pack", IDS)).toEqual(before);
  });

  it("preserves exact requested Asset order", async () => {
    const ws = await workspace();
    await ws.createDraft(draft({ assetIds: ["gold", "aapl", "btc"] }), IDS);
    expect((await ws.readDraft("qa-pack", IDS)).assetIds).toEqual(["gold", "aapl", "btc"]);
  });

  it("rejects duplicate Asset membership", async () => {
    const ws = await workspace();
    await expect(ws.createDraft(draft({ assetIds: ["aapl", "aapl"] }), IDS)).rejects.toMatchObject({ code: "duplicate_draft_asset" });
  });

  it("rejects missing Asset references", async () => {
    const ws = await workspace();
    await expect(ws.createDraft(draft({ assetIds: ["missing"] }), IDS)).rejects.toMatchObject({ code: "draft_asset_not_found" });
  });

  it("requires the current revision for deletion", async () => {
    const ws = await workspace();
    await ws.createDraft(draft(), IDS);
    await expect(ws.deleteDraft({ draftId: "qa-pack", expectedRevision: 2 }, IDS)).rejects.toMatchObject({ code: "draft_revision_conflict" });
    expect((await ws.readDraft("qa-pack", IDS)).revision).toBe(1);
  });

  it("deletes only after matching the revision", async () => {
    const ws = await workspace();
    await ws.createDraft(draft(), IDS);
    await ws.deleteDraft({ draftId: "qa-pack", expectedRevision: 1 }, IDS);
    await expect(ws.readDraft("qa-pack", IDS)).rejects.toMatchObject({ code: "draft_not_found" });
  });

  it("does not vary bytes with workspace location", async () => {
    const first = await workspace();
    const second = await workspace();
    await first.createDraft(draft(), IDS);
    await second.createDraft(draft(), IDS);
    expect(await first.exportDraft("qa-pack", IDS)).toEqual(await second.exportDraft("qa-pack", IDS));
  });

  it("rejects a symlinked workspace root", async () => {
    const target = await mkdtemp(join(tmpdir(), "visionx-admin-target-"));
    const parent = await mkdtemp(join(tmpdir(), "visionx-admin-link-"));
    cleanup.push(target, parent);
    const link = join(parent, "workspace");
    await symlink(target, link);
    await expect(AdminWorkspace.open({ workspaceRoot: link })).rejects.toMatchObject({ code: "workspace_root_invalid" });
  });

  it("rejects a symlinked draft directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "visionx-admin-workspace-test-"));
    const target = await mkdtemp(join(tmpdir(), "visionx-admin-drafts-target-"));
    cleanup.push(root, target);
    await symlink(target, join(root, "pack-drafts"));
    await expect(AdminWorkspace.open({ workspaceRoot: root })).rejects.toMatchObject({ code: "workspace_path_unsafe" });
  });

  it("rejects a symlinked draft file", async () => {
    const ws = await workspace();
    const target = join(ws.root, "outside.json");
    await writeFile(target, serializePackDraft(draft()));
    await symlink(target, join(ws.draftsDirectory, "qa-pack.json"));
    await expect(ws.readDraft("qa-pack", IDS)).rejects.toMatchObject({ code: "workspace_path_unsafe" });
  });

  it("cleans temporary files after successful writes", async () => {
    const ws = await workspace();
    await ws.createDraft(draft(), IDS);
    expect((await readdir(ws.draftsDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves the original draft when finalization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "visionx-admin-workspace-test-"));
    cleanup.push(root);
    const ws = await AdminWorkspace.open({ workspaceRoot: root }, { beforeFinalize: async () => { throw new Error("forced"); } });
    await expect(ws.createDraft(draft(), IDS)).rejects.toMatchObject({ code: "temporary_write_failed" });
    expect((await readdir(ws.draftsDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects noncanonical saved bytes", async () => {
    const ws = await workspace();
    await writeFile(join(ws.draftsDirectory, "qa-pack.json"), JSON.stringify(draft()));
    await expect(ws.readDraft("qa-pack", IDS)).rejects.toMatchObject({ code: "invalid_pack_draft" });
  });
});

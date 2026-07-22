import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminStandaloneRenderWorkspace } from "./admin-standalone-render-workspace.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "visionx-standalone-render-workspace-"));
  cleanup.push(value);
  return value;
}

describe("Admin standalone render workspace", () => {
  it("preserves a source under a unique task and reads only final artifacts", async () => {
    const workspace = await AdminStandaloneRenderWorkspace.open(await root());
    const source = Buffer.from("PNG-SOURCE");
    const task = await workspace.createTask("BTCUSD_2026-07-22_18-58-01.png", source);
    await writeFile(task.outputPath, Buffer.from("PUBLICATION"));
    await writeFile(task.receiptPath, Buffer.from("RECEIPT"));

    expect(task.renderId).toMatch(/^[a-f0-9]{32}$/u);
    expect(await readFile(task.sourcePath)).toEqual(source);
    expect(await workspace.readArtifact(task.renderId, "publication.png")).toEqual(Buffer.from("PUBLICATION"));
    expect(await workspace.readArtifact(task.renderId, "receipt.json")).toEqual(Buffer.from("RECEIPT"));
  });

  it("rejects unsafe or empty source inputs", async () => {
    const workspace = await AdminStandaloneRenderWorkspace.open(await root());
    await expect(workspace.createTask("../BTCUSD.png", Buffer.from("x"))).rejects.toMatchObject({ code: "invalid_standalone_render" });
    await expect(workspace.createTask("BTCUSD.png", Buffer.alloc(0))).rejects.toMatchObject({ code: "invalid_standalone_render" });
  });

  it("discards a failed task without affecting other renders", async () => {
    const workspace = await AdminStandaloneRenderWorkspace.open(await root());
    const keep = await workspace.createTask("BTCUSD_2026-07-22_18-58-01.png", Buffer.from("keep"));
    const discard = await workspace.createTask("BTCUSD_2026-07-23_18-58-01.png", Buffer.from("discard"));
    await writeFile(keep.outputPath, Buffer.from("PUBLICATION"));

    await workspace.discardTask(discard.renderId);

    expect(await workspace.readArtifact(keep.renderId, "publication.png")).toEqual(Buffer.from("PUBLICATION"));
    await expect(workspace.readArtifact(discard.renderId, "publication.png")).rejects.toMatchObject({ code: "standalone_render_not_found" });
  });

  it("rejects a symlinked standalone-render root", async () => {
    const workspaceRoot = await root();
    const target = await root();
    await symlink(target, join(workspaceRoot, "standalone-renders"), "dir");
    await expect(AdminStandaloneRenderWorkspace.open(workspaceRoot)).rejects.toMatchObject({ code: "workspace_path_unsafe" });
  });
});

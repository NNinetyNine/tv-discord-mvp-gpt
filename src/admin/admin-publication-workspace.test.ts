import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AdminPublicationWorkspace } from "./admin-publication-workspace.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AdminPublicationWorkspace", () => {
  it("creates isolated Release custody below the administration workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "visionx-admin-publication-"));
    cleanup.push(root);
    const workspace = await AdminPublicationWorkspace.open(root);
    const canonicalRoot = await realpath(root);
    expect(workspace.root).toBe(join(canonicalRoot, "publication"));
    expect(workspace.archiveRoot).toBe(join(canonicalRoot, "publication", "archive"));
  });

  it("rejects a symlinked publication directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "visionx-admin-publication-root-"));
    const target = await mkdtemp(join(tmpdir(), "visionx-admin-publication-target-"));
    cleanup.push(root, target);
    await symlink(target, join(root, "publication"));
    await expect(AdminPublicationWorkspace.open(root)).rejects.toMatchObject({ code: "workspace_path_unsafe" });
  });
});

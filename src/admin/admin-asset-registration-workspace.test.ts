import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AdminAssetRegistrationWorkspace } from "./admin-asset-registration-workspace.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "visionx-asset-registration-workspace-"));
  cleanup.push(path);
  return path;
}

describe("Admin Asset registration workspace custody", () => {
  it("uses a fixed subtree and allowlisted no-overwrite artifacts", async () => {
    const workspaceRoot = await root();
    const workspace = await AdminAssetRegistrationWorkspace.open(workspaceRoot);
    const bytes = Buffer.from("{}\n");
    const summary = await workspace.writeArtifact("ui-smoke-asset", "registration-input.json", bytes);
    expect(workspace.root).toBe(await realpath(join(workspaceRoot, "asset-registrations")));
    expect(summary).toMatchObject({ name: "registration-input.json", bytes: 3 });
    expect(await workspace.readArtifact("ui-smoke-asset", "registration-input.json")).toEqual(bytes);
    await expect(workspace.writeArtifact("ui-smoke-asset", "registration-input.json", bytes)).rejects.toMatchObject({ code: "output_already_exists" });
  });

  it("canonicalizes lexical workspace roots while rejecting a workspace root that is itself a symlink", async () => {
    const host = await root();
    const canonicalParent = join(host, "canonical-parent");
    const lexicalParent = join(host, "lexical-parent");
    const canonicalWorkspaceRoot = join(canonicalParent, "workspace");
    await mkdir(canonicalWorkspaceRoot, { recursive: true });
    await symlink(canonicalParent, lexicalParent, "dir");

    const lexicalWorkspaceRoot = join(lexicalParent, "workspace");
    const workspace = await AdminAssetRegistrationWorkspace.open(lexicalWorkspaceRoot);
    expect(workspace.root).toBe(join(await realpath(canonicalWorkspaceRoot), "asset-registrations"));

    const symlinkedWorkspaceRoot = join(host, "workspace-root-link");
    await symlink(canonicalWorkspaceRoot, symlinkedWorkspaceRoot, "dir");
    await expect(AdminAssetRegistrationWorkspace.open(symlinkedWorkspaceRoot)).rejects.toMatchObject({ code: "workspace_path_unsafe" });
  });

  it("rejects traversal, unsupported artifact names, symlinked registration roots, and symlinked artifacts", async () => {
    const workspaceRoot = await root();
    const workspace = await AdminAssetRegistrationWorkspace.open(workspaceRoot);
    expect(() => workspace.validateRegistrationId("../escape")).toThrow(expect.objectContaining({ code: "invalid_asset_registration_input" }));
    await expect(workspace.artifactPath("ui-smoke-asset", "arbitrary.json" as never)).rejects.toMatchObject({ code: "workspace_path_unsafe" });

    const outside = await root();
    await symlink(outside, join(workspace.root, "symlink-registration"));
    await expect(workspace.artifactPath("symlink-registration", "asset-proposal.json")).rejects.toMatchObject({ code: "workspace_path_unsafe" });

    await mkdir(join(workspace.root, "ui-smoke-asset"));
    await writeFile(join(outside, "foreign.json"), "{}\n");
    await symlink(join(outside, "foreign.json"), join(workspace.root, "ui-smoke-asset", "asset-proposal.json"));
    await expect(workspace.readArtifact("ui-smoke-asset", "asset-proposal.json")).rejects.toMatchObject({ code: "workspace_path_unsafe" });
    expect(await readFile(join(outside, "foreign.json"), "utf8")).toBe("{}\n");
  });
});

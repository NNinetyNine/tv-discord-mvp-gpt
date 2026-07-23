import { access, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AdminServerConfigurationWorkspace } from "./admin-server-configuration-workspace.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

describe("Administration server-configuration workspace", () => {
  it("preserves exact migration evidence idempotently before completion", async () => {
    const root = await temporaryDirectory("visionx-server-workspace-");
    const workspace = await AdminServerConfigurationWorkspace.open(root);
    const migrationId = "a".repeat(32);
    const evidence = Object.freeze({
      migrationId,
      channelsBefore: Buffer.from("channels-before\n"),
      threadBindingsBefore: Buffer.from("threads-before\n"),
      channelsAfter: Buffer.from("channels-after\n"),
      threadBindingsAfter: Buffer.from("threads-after\n"),
      preview: Object.freeze({ schemaVersion: 1, valid: true }),
    });

    await workspace.stageMigrationEvidence(evidence);
    await workspace.stageMigrationEvidence(evidence);
    const directory = join(workspace.migrationsRoot, migrationId);
    expect(await readFile(join(directory, "channels.before.json"))).toEqual(evidence.channelsBefore);
    expect((await lstat(join(directory, "preview.json"))).isSymbolicLink()).toBe(false);

    await workspace.completeMigration(migrationId, Object.freeze({ schemaVersion: 1, applied: true }));
    expect(JSON.parse(await readFile(join(directory, "completion.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      applied: true,
    });
  });

  it("rejects pre-existing symlink custody without creating content through it", async () => {
    const root = await temporaryDirectory("visionx-server-workspace-root-");
    const outside = await temporaryDirectory("visionx-server-workspace-outside-");
    await symlink(outside, join(root, "server-configuration"));

    await expect(AdminServerConfigurationWorkspace.open(root)).rejects.toMatchObject({
      code: "path_collision",
    });
    await expect(access(join(outside, "migrations"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ADMIN_ACCEPTANCE_CANONICAL_FILES,
  ADMIN_ACCEPTANCE_WORKSPACES,
  runAdminSystemValidation,
} from "./admin-system-validation.ts";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function acceptanceRoots(): Promise<{ readonly repositoryRoot: string; readonly workspaceRoot: string }> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "visionx-final-validation-repository-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-final-validation-workspace-"));
  cleanup.push(repositoryRoot, workspaceRoot);
  await Promise.all([
    cp(resolve("definitions"), join(repositoryRoot, "definitions"), { recursive: true }),
    cp(resolve("config"), join(repositoryRoot, "config"), { recursive: true }),
  ]);
  return { repositoryRoot, workspaceRoot };
}

describe("Administration final system validation", () => {
  it("loads all seven operator workspaces through the production HTTP composition without writes", async () => {
    const roots = await acceptanceRoots();
    const report = await runAdminSystemValidation(roots);

    expect(report.outcome).toBe("passed");
    expect(report.summary).toMatchObject({ failed: 0, workspaceCount: 7 });
    const workspaceNames = new Set<string>(ADMIN_ACCEPTANCE_WORKSPACES);
    expect(report.checks.filter((check) => workspaceNames.has(check.workspace))).toHaveLength(7);
    expect(report.checks.every((check) => check.outcome === "passed")).toBe(true);
    expect(report.server).toMatchObject({ host: "127.0.0.1", loopbackOnly: true });
    expect(report.nonEffects).toEqual({
      canonicalSourcesChanged: false,
      discordContacted: false,
      writeRoutesExercised: false,
      cleanupPerformed: false,
    });
  });

  it("proves exact canonical-source custody across the validation run", async () => {
    const roots = await acceptanceRoots();
    const report = await runAdminSystemValidation(roots);

    expect(report.canonicalSources.map((source) => source.path)).toEqual([...ADMIN_ACCEPTANCE_CANONICAL_FILES]);
    expect(report.canonicalSources.every((source) => source.unchanged && source.beforeSha256 === source.afterSha256)).toBe(true);
  });
});

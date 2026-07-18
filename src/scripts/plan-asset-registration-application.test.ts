import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadPacks } from "../packs/packs.ts";
import { loadRegistry } from "../registry/registry.ts";
import { proposeAssetRegistration, serializeAssetRegistrationProposal } from "../registry/asset-registration-proposal.ts";
import { main, parsePlanAssetRegistrationApplicationArguments } from "./plan-asset-registration-application.ts";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("plan-asset-registration-application CLI", () => {
  it("requires explicit paths and rejects positional, duplicate, and unknown arguments", () => {
    expect(parsePlanAssetRegistrationApplicationArguments(["node", "script", "x"])).toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(parsePlanAssetRegistrationApplicationArguments(["node", "script", "--nope", "x"])).toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(parsePlanAssetRegistrationApplicationArguments(["node", "script", "--proposal", "a", "--proposal", "b", "--authorization", "c", "--output", "d"])).toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(parsePlanAssetRegistrationApplicationArguments(["node", "script", "--proposal", "a"])).toMatchObject({ ok: false, reason: "invalid_arguments" });
  });

  it("prints exactly one structured approved-plan result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "visionx-plan-cli-"));
    dirs.push(dir);
    const proposalPath = join(dir, "proposal.json");
    const authorizationPath = join(dir, "authorization.json");
    const outputPath = join(dir, "plan.json");

    const registry = loadRegistry(resolve("definitions/registry.json"), resolve("config/channels.json"));
    const channels = JSON.parse(readFileSync(resolve("config/channels.json"), "utf8")) as Record<string, unknown>;
    const packs = loadPacks(resolve("definitions/packs.json"), new Set(registry.all().map((asset) => asset.id)), new Set(Object.keys(channels)));
    const proposed = proposeAssetRegistration({
      schemaVersion: 2,
      operation: "add",
      asset: { id: "planning_cli_test_asset", displayName: "Planning CLI Test Asset", symbol: "PLANNINGCLITEST", market: "NASDAQ", tradingViewSymbol: "NASDAQ:PLANNINGCLITEST", currency: "USD", channel: "stocks" },
      targetPackIds: [],
      decision: { reviewerId: "visionx-curator", decidedAt: "2026-07-17T22:30:00Z", referenceId: "visionx.asset-registration.planning-cli-test-v2", notes: "Schema demonstration only." },
    }, registry.all(), packs, channels);
    if (!proposed.ok) throw new Error(proposed.detail);
    const proposalBytes = serializeAssetRegistrationProposal(proposed.proposal);
    writeFileSync(proposalPath, proposalBytes);
    writeFileSync(authorizationPath, `${JSON.stringify({
      schemaVersion: 1,
      decision: "approved",
      proposalSha256: sha(proposalBytes),
      reviewerId: "visionx-curator",
      decidedAt: "2026-07-18T00:30:00Z",
      referenceId: "visionx.asset-application.planning-cli-test-v2",
      packPlacements: [],
      notes: "Authorize planning only.",
    }, null, 2)}\n`);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(
      ["node", "script", "--proposal", proposalPath, "--authorization", authorizationPath, "--output", outputPath],
      (line) => stdout.push(line),
      (line) => stderr.push(line),
    );
    expect(exit).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({ ok: true, plan: { applicationAuthorized: true, sourceChangesApplied: false } });
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({ applicationStatus: "planned_not_applied" });
  });
});

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { buildPacks } from "../packs/packs.ts";
import { buildRegistry } from "../registry/registry.ts";
import {
  planAssetRegistrationApplication,
  serializeAssetRegistrationApplicationPlan,
} from "../registry/asset-registration-application-plan.ts";
import {
  serializeAssetRegistrationApplicationAuthorization,
  type AssetRegistrationApplicationAuthorization,
} from "../registry/asset-registration-application-authorization.ts";
import {
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
} from "../registry/asset-registration-proposal.ts";
import {
  GENERATE_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE,
  main,
  parseGenerateAssetRegistrationSourceChangeArguments,
} from "./generate-asset-registration-source-change.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "visionx-source-change-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeArtifacts(directory: string) {
  const registryBytes = readFileSync(resolve("definitions/registry.json"));
  const packsBytes = readFileSync(resolve("definitions/packs.json"));
  const channels = JSON.parse(readFileSync(resolve("config/channels.json"), "utf8")) as Record<string, unknown>;
  const registry = buildRegistry(
    JSON.parse(registryBytes.toString("utf8")) as Parameters<typeof buildRegistry>[0],
    channels,
  );
  const packs = buildPacks(
    JSON.parse(packsBytes.toString("utf8")) as unknown,
    new Set(registry.all().map((asset) => asset.id)),
    new Set(Object.keys(channels)),
  );
  const proposed = proposeAssetRegistration({
    schemaVersion: 2,
    operation: "add",
    asset: {
      id: "source_change_cli_asset",
      displayName: "Example Asset",
      symbol: "SOURCECHANGECLI",
      market: "NASDAQ",
      tradingViewSymbol: "NASDAQ:SOURCECHANGECLI",
      currency: "USD",
      channel: "stocks",
    },
    targetPackIds: [],
    decision: {
      reviewerId: "visionx-curator",
      decidedAt: "2026-07-17T22:30:00Z",
      referenceId: "visionx.asset-registration.source-change-cli-v2",
    },
  }, registry.all(), packs, channels);
  if (!proposed.ok) throw new Error(proposed.detail);
  const proposalBytes = serializeAssetRegistrationProposal(proposed.proposal);
  const authorization: AssetRegistrationApplicationAuthorization = Object.freeze({
    schemaVersion: 1,
    decision: "approved",
    proposalSha256: sha256(proposalBytes),
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-18T00:30:00Z",
    referenceId: "visionx.asset-application.source-change-cli-v2",
    packPlacements: Object.freeze([]),
  });
  const authorizationBytes = serializeAssetRegistrationApplicationAuthorization(authorization);
  const planned = planAssetRegistrationApplication({
    proposal: proposed.proposal,
    proposalSha256: sha256(proposalBytes),
    authorization,
    authorizationSha256: sha256(authorizationBytes),
    assets: registry.all(),
    packs,
    channels,
  });
  if (!planned.ok) throw new Error(planned.detail);
  const planBytes = serializeAssetRegistrationApplicationPlan(planned.plan);
  const proposalPath = join(directory, "proposal.json");
  const authorizationPath = join(directory, "authorization.json");
  const planPath = join(directory, "plan.json");
  writeFileSync(proposalPath, proposalBytes);
  writeFileSync(authorizationPath, authorizationBytes);
  writeFileSync(planPath, planBytes);
  return {
    proposalPath,
    authorizationPath,
    planPath,
    patchOutputPath: join(directory, "change.patch"),
    receiptOutputPath: join(directory, "change.json"),
  };
}

describe("generate-asset-registration-source-change CLI", () => {
  test("parses every explicit flag exactly once", () => {
    const parsed = parseGenerateAssetRegistrationSourceChangeArguments([
      "node",
      "script",
      "--proposal", "proposal.json",
      "--authorization", "authorization.json",
      "--plan", "plan.json",
      "--patch-output", "change.patch",
      "--receipt-output", "change.json",
    ]);
    expect(parsed).toMatchObject({
      ok: true,
      options: {
        proposalPath: "proposal.json",
        authorizationPath: "authorization.json",
        planPath: "plan.json",
        patchOutputPath: "change.patch",
        receiptOutputPath: "change.json",
      },
    });
  });

  test.each([
    [["node", "script", "proposal.json"], "positional argument"],
    [["node", "script", "--unknown", "x"], "unknown flag"],
    [["node", "script", "--proposal", "a", "--proposal", "b"], "duplicate flag"],
    [["node", "script", "--proposal"], "missing value"],
    [["node", "script"], "missing required flags"],
  ] as const)("rejects invalid arguments: %s", (argv, detail) => {
    const parsed = parseGenerateAssetRegistrationSourceChangeArguments(argv);
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_arguments" });
    if (!parsed.ok) expect(parsed.detail).toContain(detail);
  });

  test("main emits one structured success result", async () => {
    const directory = tempDirectory();
    const paths = writeArtifacts(directory);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = vi.fn(async () => Object.freeze({
      ok: true as const,
      patchBasename: "change.patch",
      receiptBasename: "change.json",
      patchSha256: "0".repeat(64),
      receiptSha256: "1".repeat(64),
      receipt: Object.freeze({ generationStatus: "generated_not_applied" }) as never,
    }));
    const code = await main([
      "node",
      "script",
      "--proposal", paths.proposalPath,
      "--authorization", paths.authorizationPath,
      "--plan", paths.planPath,
      "--patch-output", paths.patchOutputPath,
      "--receipt-output", paths.receiptOutputPath,
    ], (text) => stdout.push(text), (text) => stderr.push(text), run);
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "{}") as unknown).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("argument errors include concise usage", async () => {
    const stderr: string[] = [];
    const code = await main(["node", "script"], () => undefined, (text) => stderr.push(text));
    expect(code).toBe(2);
    expect(stderr.at(-1)).toBe(GENERATE_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE);
  });
});

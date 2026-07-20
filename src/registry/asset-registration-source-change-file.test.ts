import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildPacks } from "../packs/packs.ts";
import { buildRegistry } from "./registry.ts";
import {
  planAssetRegistrationApplication,
  serializeAssetRegistrationApplicationPlan,
} from "./asset-registration-application-plan.ts";
import {
  serializeAssetRegistrationApplicationAuthorization,
  type AssetRegistrationApplicationAuthorization,
} from "./asset-registration-application-authorization.ts";
import {
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
} from "./asset-registration-proposal.ts";
import {
  generateAssetRegistrationSourceChangeFile,
} from "./asset-registration-source-change-file.ts";
import { makeSourceReviewApplicationFixture } from "./asset-registration-source-review-application.test-fixture.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "visionx-source-change-file-"));
  temporaryDirectories.push(directory);
  return directory;
}

function artifactBytes() {
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
      id: "source_change_file_asset",
      displayName: "Example Asset",
      symbol: "SOURCECHANGEFILE",
      market: "NASDAQ",
      tradingViewSymbol: "NASDAQ:SOURCECHANGEFILE",
      currency: "USD",
      channel: "stocks",
    },
    targetPackIds: [],
    decision: {
      reviewerId: "visionx-curator",
      decidedAt: "2026-07-17T22:30:00Z",
      referenceId: "visionx.asset-registration.source-change-file-v2",
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
    referenceId: "visionx.asset-application.source-change-file-v2",
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
  return Object.freeze({
    proposalBytes,
    authorizationBytes,
    planBytes: serializeAssetRegistrationApplicationPlan(planned.plan),
    registryBytes,
    packsBytes,
    channelsBytes: readFileSync(resolve("config/channels.json")),
  });
}

function writeInputs(directory: string) {
  const artifacts = artifactBytes();
  const proposalPath = join(directory, "proposal.json");
  const authorizationPath = join(directory, "authorization.json");
  const planPath = join(directory, "plan.json");
  writeFileSync(proposalPath, artifacts.proposalBytes);
  writeFileSync(authorizationPath, artifacts.authorizationBytes);
  writeFileSync(planPath, artifacts.planBytes);
  return Object.freeze({ proposalPath, authorizationPath, planPath, ...artifacts });
}

function options(directory: string) {
  const inputs = writeInputs(directory);
  return Object.freeze({
    ...inputs,
    patchOutputPath: join(directory, "change.patch"),
    receiptOutputPath: join(directory, "change.json"),
    expectedRegistrySha256: sha256(inputs.registryBytes),
    expectedPacksSha256: sha256(inputs.packsBytes),
    expectedChannelsSha256: sha256(inputs.channelsBytes),
  });
}

describe("Asset registration source-change file custody", () => {
  test("publishes a deterministic patch/receipt pair without modifying inputs or sources", async () => {
    const directory = tempDirectory();
    const paths = options(directory);
    const sourceBefore = [
      readFileSync(resolve("definitions/registry.json")),
      readFileSync(resolve("definitions/packs.json")),
      readFileSync(resolve("config/channels.json")),
    ];
    const result = await generateAssetRegistrationSourceChangeFile(paths, { verifyPatch: async () => true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(paths.patchOutputPath)).toBe(true);
    expect(existsSync(paths.receiptOutputPath)).toBe(true);
    expect(sha256(readFileSync(paths.patchOutputPath))).toBe(result.patchSha256);
    expect(sha256(readFileSync(paths.receiptOutputPath))).toBe(result.receiptSha256);
    expect(readFileSync(paths.proposalPath).equals(paths.proposalBytes)).toBe(true);
    expect(readFileSync(paths.authorizationPath).equals(paths.authorizationBytes)).toBe(true);
    expect(readFileSync(paths.planPath).equals(paths.planBytes)).toBe(true);
    expect(readFileSync(resolve("definitions/registry.json")).equals(sourceBefore[0]!)).toBe(true);
    expect(readFileSync(resolve("definitions/packs.json")).equals(sourceBefore[1]!)).toBe(true);
    expect(readFileSync(resolve("config/channels.json")).equals(sourceBefore[2]!)).toBe(true);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("generates against a rolling canonical Registry without a static bootstrap hash", async () => {
    const first = makeSourceReviewApplicationFixture();
    const rolling = makeSourceReviewApplicationFixture("approved", {
      registryBytes: first.sourceChange.registryAfterBytes,
      asset: {
        id: "rolling_source_change_file_asset",
        displayName: "Rolling Source Change File Asset",
        symbol: "ROLLSOURCE",
        market: "NASDAQ",
        tradingViewSymbol: "NASDAQ:ROLLSOURCE",
        currency: "USD",
        channel: "stocks",
      },
    });
    const directory = tempDirectory();
    const repositoryRoot = join(directory, "repository");
    mkdirSync(join(repositoryRoot, "definitions"), { recursive: true });
    mkdirSync(join(repositoryRoot, "config"), { recursive: true });
    const proposalPath = join(directory, "proposal.json");
    const authorizationPath = join(directory, "authorization.json");
    const planPath = join(directory, "plan.json");
    const registryPath = join(repositoryRoot, "definitions/registry.json");
    const packsPath = join(repositoryRoot, "definitions/packs.json");
    const channelsPath = join(repositoryRoot, "config/channels.json");
    writeFileSync(proposalPath, rolling.proposalBytes);
    writeFileSync(authorizationPath, rolling.planningAuthorizationBytes);
    writeFileSync(planPath, rolling.planBytes);
    writeFileSync(registryPath, rolling.registryBytes);
    writeFileSync(packsPath, rolling.packsBytes);
    writeFileSync(channelsPath, rolling.channelsBytes);

    const result = await generateAssetRegistrationSourceChangeFile({
      proposalPath,
      authorizationPath,
      planPath,
      patchOutputPath: join(directory, "rolling.patch"),
      receiptOutputPath: join(directory, "rolling.json"),
      registryPath,
      packsPath,
      channelsPath,
      repositoryRoot,
    }, { verifyPatch: async () => true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.sourceState.registry.beforeSha256).toBe(sha256(rolling.registryBytes));
    expect(result.receipt.sourceState.registry.afterSha256).toBe(sha256(rolling.sourceChange.registryAfterBytes));
  });

  test("preserves distinct explicit Registry, Packs, and channel snapshot drift failures", async () => {
    const registryCase = options(tempDirectory());
    expect(await generateAssetRegistrationSourceChangeFile({
      ...registryCase,
      expectedRegistrySha256: "0".repeat(64),
    }, { verifyPatch: async () => true })).toMatchObject({ ok: false, reason: "stale_registry_state" });

    const packsCase = options(tempDirectory());
    expect(await generateAssetRegistrationSourceChangeFile({
      ...packsCase,
      expectedPacksSha256: "0".repeat(64),
    }, { verifyPatch: async () => true })).toMatchObject({ ok: false, reason: "stale_pack_state" });

    const channelsCase = options(tempDirectory());
    expect(await generateAssetRegistrationSourceChangeFile({
      ...channelsCase,
      expectedChannelsSha256: "0".repeat(64),
    }, { verifyPatch: async () => true })).toMatchObject({ ok: false, reason: "stale_channel_configuration" });
  });

  test("caller output locations do not affect artifact bytes", async () => {
    const firstDirectory = tempDirectory();
    const secondDirectory = tempDirectory();
    const first = options(firstDirectory);
    const second = options(secondDirectory);
    const firstResult = await generateAssetRegistrationSourceChangeFile(first, { verifyPatch: async () => true });
    const secondResult = await generateAssetRegistrationSourceChangeFile(second, { verifyPatch: async () => true });
    expect(firstResult.ok && secondResult.ok).toBe(true);
    if (!firstResult.ok || !secondResult.ok) return;
    expect(readFileSync(first.patchOutputPath).equals(readFileSync(second.patchOutputPath))).toBe(true);
    expect(readFileSync(first.receiptOutputPath).equals(readFileSync(second.receiptOutputPath))).toBe(true);
  });

  test("input/output and output/output collisions fail", async () => {
    const directory = tempDirectory();
    const paths = options(directory);
    const inputCollision = await generateAssetRegistrationSourceChangeFile({
      ...paths,
      patchOutputPath: paths.proposalPath,
    }, { verifyPatch: async () => true });
    expect(inputCollision).toMatchObject({ ok: false, reason: "path_collision" });

    const outputCollision = await generateAssetRegistrationSourceChangeFile({
      ...paths,
      patchOutputPath: join(directory, "same"),
      receiptOutputPath: join(directory, "same"),
    }, { verifyPatch: async () => true });
    expect(outputCollision).toMatchObject({ ok: false, reason: "path_collision" });
  });

  test("preexisting outputs are never overwritten", async () => {
    const directory = tempDirectory();
    const paths = options(directory);
    writeFileSync(paths.patchOutputPath, "existing");
    const result = await generateAssetRegistrationSourceChangeFile(paths, { verifyPatch: async () => true });
    expect(result).toMatchObject({ ok: false, reason: "output_already_exists" });
    expect(readFileSync(paths.patchOutputPath, "utf8")).toBe("existing");
    expect(existsSync(paths.receiptOutputPath)).toBe(false);
  });

  test("patch verification failure leaves neither output nor temporary files", async () => {
    const directory = tempDirectory();
    const paths = options(directory);
    const result = await generateAssetRegistrationSourceChangeFile(paths, { verifyPatch: async () => false });
    expect(result).toMatchObject({ ok: false, reason: "patch_verification_failed" });
    expect(existsSync(paths.patchOutputPath)).toBe(false);
    expect(existsSync(paths.receiptOutputPath)).toBe(false);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("an input change before finalization fails closed", async () => {
    const directory = tempDirectory();
    const paths = options(directory);
    const result = await generateAssetRegistrationSourceChangeFile(paths, {
      verifyPatch: async () => true,
      beforeFinalize: async () => { writeFileSync(paths.proposalPath, Buffer.concat([paths.proposalBytes, Buffer.from(" ")])); },
    });
    expect(result).toMatchObject({ ok: false, reason: "input_changed_during_generation" });
    expect(existsSync(paths.patchOutputPath)).toBe(false);
    expect(existsSync(paths.receiptOutputPath)).toBe(false);
  });

  test("second-output finalization failure rolls back the first output", async () => {
    const directory = tempDirectory();
    const paths = options(directory);
    const result = await generateAssetRegistrationSourceChangeFile(paths, {
      verifyPatch: async () => true,
      beforeSecondFinalize: async () => { throw new Error("simulated second-output failure"); },
    });
    expect(result).toMatchObject({ ok: false, reason: "finalize_failed" });
    expect(existsSync(paths.patchOutputPath)).toBe(false);
    expect(existsSync(paths.receiptOutputPath)).toBe(false);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

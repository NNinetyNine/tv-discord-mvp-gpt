import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { applyAssetRegistrationSourceChangeFile } from "./asset-registration-source-application-file.ts";
import { serializeAssetRegistrationSourceApplicationAuthorization } from "./asset-registration-source-application-authorization.ts";
import { makeSourceReviewApplicationFixture, sha256 } from "./asset-registration-source-review-application.test-fixture.ts";

const directories: string[] = [];
afterEach(() => { while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "visionx-source-application-file-")); directories.push(dir); return dir; }

function setup() {
  const directory = temp();
  const repositoryRoot = join(directory, "repo");
  mkdirSync(join(repositoryRoot, "definitions"), { recursive: true });
  mkdirSync(join(repositoryRoot, "config"), { recursive: true });
  const fixture = makeSourceReviewApplicationFixture();
  const registryPath = join(repositoryRoot, "definitions/registry.json");
  const packsPath = join(repositoryRoot, "definitions/packs.json");
  const channelsPath = join(repositoryRoot, "config/channels.json");
  writeFileSync(registryPath, fixture.registryBytes); writeFileSync(packsPath, fixture.packsBytes); writeFileSync(channelsPath, fixture.channelsBytes);
  const files = {
    proposalPath: join(directory, "proposal.json"), planningAuthorizationPath: join(directory, "planning-authorization.json"),
    planPath: join(directory, "plan.json"), patchPath: join(directory, "source.patch"), sourceChangeReceiptPath: join(directory, "source-change.json"),
    reviewPath: join(directory, "review.json"), applicationAuthorizationPath: join(directory, "application-authorization.json"),
    repositoryRoot, applicationReceiptOutputPath: join(directory, "application.json"),
  };
  writeFileSync(files.proposalPath, fixture.proposalBytes); writeFileSync(files.planningAuthorizationPath, fixture.planningAuthorizationBytes);
  writeFileSync(files.planPath, fixture.planBytes); writeFileSync(files.patchPath, fixture.sourceChange.patchBytes);
  writeFileSync(files.sourceChangeReceiptPath, fixture.sourceChange.receiptBytes); writeFileSync(files.reviewPath, fixture.reviewBytes);
  writeFileSync(files.applicationAuthorizationPath, fixture.applicationAuthorizationBytes);
  return { directory, fixture, files, registryPath, packsPath, channelsPath };
}

describe("authorized atomic source application", () => {
  test("applies the reconstructed Registry bytes and publishes one deterministic receipt", async () => {
    const { fixture, files, registryPath, packsPath, channelsPath } = setup();
    const result = await applyAssetRegistrationSourceChangeFile(files, { verifyPatch: async () => true });
    expect(result.ok).toBe(true);
    expect(readFileSync(registryPath).equals(fixture.sourceChange.registryAfterBytes)).toBe(true);
    expect(readFileSync(packsPath).equals(fixture.packsBytes)).toBe(true);
    expect(readFileSync(channelsPath).equals(fixture.channelsBytes)).toBe(true);
    expect(readFileSync(files.applicationReceiptOutputPath).equals(result.ok ? Buffer.from(`${JSON.stringify(result.receipt, null, 2)}\n`) : Buffer.alloc(0))).toBe(true);
  });

  test("replay fails closed without a second receipt", async () => {
    const { files } = setup();
    expect((await applyAssetRegistrationSourceChangeFile(files, { verifyPatch: async () => true })).ok).toBe(true);
    const replayOutput = `${files.applicationReceiptOutputPath}.replay`;
    expect(await applyAssetRegistrationSourceChangeFile({ ...files, applicationReceiptOutputPath: replayOutput }, { verifyPatch: async () => true })).toMatchObject({ ok: false, reason: "source_change_already_applied" });
    expect(existsSync(replayOutput)).toBe(false);
  });

  test("rejected application authorization changes no source", async () => {
    const { fixture, files, registryPath } = setup();
    const rejected = { ...fixture.applicationAuthorization, decision: "rejected" as const };
    writeFileSync(files.applicationAuthorizationPath, serializeAssetRegistrationSourceApplicationAuthorization(rejected));
    expect(await applyAssetRegistrationSourceChangeFile(files, { verifyPatch: async () => true })).toMatchObject({ ok: false, reason: "application_authorization_rejected" });
    expect(readFileSync(registryPath).equals(fixture.registryBytes)).toBe(true);
  });

  test("post-replacement failure restores exact source bytes and cleans transaction files", async () => {
    const { directory, fixture, files, registryPath } = setup();
    const result = await applyAssetRegistrationSourceChangeFile(files, {
      verifyPatch: async () => true,
      afterReplacement: async () => { throw new Error("simulated validation failure"); },
    });
    expect(result).toMatchObject({ ok: false, reason: "post_apply_validation_failed" });
    expect(readFileSync(registryPath).equals(fixture.registryBytes)).toBe(true);
    expect(existsSync(files.applicationReceiptOutputPath)).toBe(false);
    expect(readdirSync(join(files.repositoryRoot, "definitions")).some((name) => name.includes("rollback.tmp") || name.includes("future.tmp"))).toBe(false);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("receipt-finalization failure restores exact source bytes with a distinct typed failure", async () => {
    const { directory, fixture, files, registryPath } = setup();
    const result = await applyAssetRegistrationSourceChangeFile(files, {
      verifyPatch: async () => true,
      beforeReceiptFinalize: async () => { throw new Error("simulated receipt finalization failure"); },
    });
    expect(result).toMatchObject({ ok: false, reason: "application_receipt_finalize_failed" });
    expect(readFileSync(registryPath).equals(fixture.registryBytes)).toBe(true);
    expect(existsSync(files.applicationReceiptOutputPath)).toBe(false);
    expect(readdirSync(join(files.repositoryRoot, "definitions")).some((name) => name.includes("rollback.tmp") || name.includes("future.tmp"))).toBe(false);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("incomplete rollback is classified separately", async () => {
    const { files } = setup();
    expect(await applyAssetRegistrationSourceChangeFile(files, {
      verifyPatch: async () => true,
      afterReplacement: async () => { throw new Error("fail"); },
      simulateRollbackFailure: true,
    })).toMatchObject({ ok: false, reason: "rollback_failed" });
  });

  test("application receipt binding remains path-neutral", async () => {
    const first = setup(); const second = setup();
    const firstResult = await applyAssetRegistrationSourceChangeFile(first.files, { verifyPatch: async () => true });
    const secondResult = await applyAssetRegistrationSourceChangeFile(second.files, { verifyPatch: async () => true });
    expect(firstResult.ok && secondResult.ok).toBe(true);
    if (!firstResult.ok || !secondResult.ok) return;
    expect(firstResult.receiptSha256).toBe(secondResult.receiptSha256);
    expect(firstResult.receipt.inputs.applicationAuthorizationSha256).toBe(sha256(first.fixture.applicationAuthorizationBytes));
  });
});

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { reviewAssetRegistrationSourceChangeFile } from "./asset-registration-source-change-review-file.ts";
import { makeSourceReviewApplicationFixture } from "./asset-registration-source-review-application.test-fixture.ts";

const directories: string[] = [];
afterEach(() => { while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "visionx-source-review-file-")); directories.push(dir); return dir; }

function setup(fixture = makeSourceReviewApplicationFixture()) {
  const directory = temp();
  const repositoryRoot = join(directory, "repo");
  mkdirSync(join(repositoryRoot, "definitions"), { recursive: true });
  mkdirSync(join(repositoryRoot, "config"), { recursive: true });
  writeFileSync(join(repositoryRoot, "definitions/registry.json"), fixture.registryBytes);
  writeFileSync(join(repositoryRoot, "definitions/packs.json"), fixture.packsBytes);
  writeFileSync(join(repositoryRoot, "config/channels.json"), fixture.channelsBytes);
  const files = {
    proposalPath: join(directory, "proposal.json"),
    planningAuthorizationPath: join(directory, "planning-authorization.json"),
    planPath: join(directory, "plan.json"),
    patchPath: join(directory, "source.patch"),
    sourceChangeReceiptPath: join(directory, "source-change.json"),
    decisionPath: join(directory, "decision.json"),
    outputPath: join(directory, "review.json"),
    repositoryRoot,
  };
  writeFileSync(files.proposalPath, fixture.proposalBytes);
  writeFileSync(files.planningAuthorizationPath, fixture.planningAuthorizationBytes);
  writeFileSync(files.planPath, fixture.planBytes);
  writeFileSync(files.patchPath, fixture.sourceChange.patchBytes);
  writeFileSync(files.sourceChangeReceiptPath, fixture.sourceChange.receiptBytes);
  writeFileSync(files.decisionPath, fixture.reviewDecisionBytes);
  return { directory, fixture, files };
}

describe("source-change review file custody", () => {
  test("writes one immutable deterministic review receipt and leaves all inputs unchanged", async () => {
    const { fixture, files } = setup();
    const before = readFileSync(files.proposalPath);
    const result = await reviewAssetRegistrationSourceChangeFile(files, { verifyPatch: async () => true });
    expect(result.ok).toBe(true);
    expect(readFileSync(files.proposalPath).equals(before)).toBe(true);
    expect(readFileSync(files.outputPath).equals(fixture.reviewBytes)).toBe(true);
  });

  test("accepts a fresh chain bound to the immediately current rolling Registry", async () => {
    const first = makeSourceReviewApplicationFixture();
    const second = makeSourceReviewApplicationFixture("approved", {
      registryBytes: first.sourceChange.registryAfterBytes,
      asset: {
        id: "rolling_source_review_asset",
        displayName: "Rolling Source Review Asset",
        symbol: "ROLLREVIEW",
        market: "NASDAQ",
        tradingViewSymbol: "NASDAQ:ROLLREVIEW",
        currency: "USD",
        channel: "stocks",
      },
    });
    const { files } = setup(second);
    const result = await reviewAssetRegistrationSourceChangeFile(files, { verifyPatch: async () => true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.sourceState.registry.beforeSha256).toBe(second.sourceChange.receipt.sourceState.registry.beforeSha256);
  });

  test("rejects an old chain after another valid source change advances the Registry", async () => {
    const { fixture, files } = setup();
    writeFileSync(join(files.repositoryRoot, "definitions/registry.json"), fixture.sourceChange.registryAfterBytes);
    const result = await reviewAssetRegistrationSourceChangeFile(files, { verifyPatch: async () => true });
    expect(result).toMatchObject({ ok: false, reason: "stale_registry_state" });
  });

  test("preserves patch and receipt reconstruction mismatch failures when canonical state is current", async () => {
    const patchCase = setup();
    writeFileSync(patchCase.files.patchPath, Buffer.concat([patchCase.fixture.sourceChange.patchBytes, Buffer.from(" ")]));
    expect(await reviewAssetRegistrationSourceChangeFile(patchCase.files, { verifyPatch: async () => true }))
      .toMatchObject({ ok: false, reason: "source_change_reconstruction_mismatch" });

    const receiptCase = setup();
    const changedReceipt = JSON.parse(receiptCase.fixture.sourceChange.receiptBytes.toString("utf8")) as any;
    changedReceipt.patch.bytes += 1;
    writeFileSync(receiptCase.files.sourceChangeReceiptPath, `${JSON.stringify(changedReceipt, null, 2)}\n`);
    expect(await reviewAssetRegistrationSourceChangeFile(receiptCase.files, { verifyPatch: async () => true }))
      .toMatchObject({ ok: false, reason: "source_change_reconstruction_mismatch" });
  });

  test("classifies Registry, Packs, and channel drift from exact receipt-bound before-state hashes", async () => {
    const registryCase = setup();
    writeFileSync(join(registryCase.files.repositoryRoot, "definitions/registry.json"), Buffer.concat([registryCase.fixture.registryBytes, Buffer.from(" ")]));
    expect(await reviewAssetRegistrationSourceChangeFile(registryCase.files, { verifyPatch: async () => true }))
      .toMatchObject({ ok: false, reason: "stale_registry_state" });

    const packsCase = setup();
    writeFileSync(join(packsCase.files.repositoryRoot, "definitions/packs.json"), Buffer.concat([packsCase.fixture.packsBytes, Buffer.from(" ")]));
    expect(await reviewAssetRegistrationSourceChangeFile(packsCase.files, { verifyPatch: async () => true }))
      .toMatchObject({ ok: false, reason: "stale_pack_state" });

    const channelsCase = setup();
    writeFileSync(join(channelsCase.files.repositoryRoot, "config/channels.json"), Buffer.concat([channelsCase.fixture.channelsBytes, Buffer.from(" ")]));
    expect(await reviewAssetRegistrationSourceChangeFile(channelsCase.files, { verifyPatch: async () => true }))
      .toMatchObject({ ok: false, reason: "stale_channel_configuration" });
  });

  test("rejects collisions and preexisting output", async () => {
    const { files } = setup();
    expect(await reviewAssetRegistrationSourceChangeFile({ ...files, outputPath: files.proposalPath }, { verifyPatch: async () => true })).toMatchObject({ ok: false, reason: "path_collision" });
    writeFileSync(files.outputPath, "existing");
    expect(await reviewAssetRegistrationSourceChangeFile(files, { verifyPatch: async () => true })).toMatchObject({ ok: false, reason: "output_already_exists" });
    expect(readFileSync(files.outputPath, "utf8")).toBe("existing");
  });

  test("input changes before finalization fail and clean temporary files", async () => {
    const { directory, files } = setup();
    const result = await reviewAssetRegistrationSourceChangeFile(files, {
      verifyPatch: async () => true,
      beforeFinalize: async () => { writeFileSync(files.decisionPath, Buffer.concat([readFileSync(files.decisionPath), Buffer.from(" ")])); },
    });
    expect(result).toMatchObject({ ok: false, reason: "input_changed_during_operation" });
    expect(existsSync(files.outputPath)).toBe(false);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

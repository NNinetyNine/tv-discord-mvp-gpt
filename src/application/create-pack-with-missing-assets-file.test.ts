import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRegistry } from "../registry/registry.ts";
import { loadPacks } from "../packs/packs.ts";
import {
  prepareCreatePackWithMissingAssets,
  serializeCreatePackPreview,
  serializeCreatePackWithMissingAssetsInput,
} from "./create-pack-with-missing-assets.ts";
import { applyCreatePackWithMissingAssetsFile } from "./create-pack-with-missing-assets-file.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "visionx-pack-builder-repo-")); cleanup.push(root);
  const workspace = await mkdtemp(join(tmpdir(), "visionx-pack-builder-workspace-")); cleanup.push(workspace);
  await mkdir(join(root, "definitions")); await mkdir(join(root, "config"));
  const registryBytes = Buffer.from('{\n  "aapl": { "tradingView": "NASDAQ:AAPL", "display": "Apple", "currency": "USD", "channel": "stocks" }\n}\n');
  const packsBytes = Buffer.from('[\n  {\n    "id": "stocks",\n    "display": "Stocks",\n    "channel": "stocks",\n    "assets": ["aapl"]\n  }\n]\n');
  const channelsBytes = Buffer.from('{\n  "stocks": "1527846988270534827",\n  "forex": "1528609079822516305"\n}\n');
  await writeFile(join(root, "definitions/registry.json"), registryBytes);
  await writeFile(join(root, "definitions/packs.json"), packsBytes);
  await writeFile(join(root, "config/channels.json"), channelsBytes);
  const input = {
    schemaVersion: 1,
    pack: { id: "forex", display: "Forex", channel: "forex" },
    members: [
      { id: "dxy", display: "U.S. Dollar Currency Index", tradingView: "TVC:DXY", currency: "USD" },
      { id: "exy", display: "Euro Currency Index", tradingView: "TVC:EXY", currency: "USD" },
    ],
  };
  const prepared = prepareCreatePackWithMissingAssets({ value: input, registryBytes, packsBytes, channelsBytes });
  if (!prepared.ok) throw new Error(prepared.detail);
  const inputPath = join(workspace, "input.json");
  const previewPath = join(workspace, "preview.json");
  const receiptPath = join(workspace, "receipt.json");
  await writeFile(inputPath, serializeCreatePackWithMissingAssetsInput(prepared.value.input));
  await writeFile(previewPath, serializeCreatePackPreview(prepared.value.preview));
  return { root, workspace, registryBytes, packsBytes, channelsBytes, inputPath, previewPath, receiptPath, prepared };
}

async function transactionFiles(root: string, workspace: string): Promise<string[]> {
  const entries = [
    ...(await readdir(join(root, "definitions"))),
    ...(await readdir(workspace)),
  ];
  return entries.filter((name) => /\.tmp$|rollback|future/iu.test(name));
}

describe("atomic Create Pack file application", () => {
  it("applies Registry and Packs together, binds currency, and rejects replay", async () => {
    const f = await fixture();
    const result = await applyCreatePackWithMissingAssetsFile({ repositoryRoot: f.root, inputPath: f.inputPath, previewPath: f.previewPath, receiptOutputPath: f.receiptPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const registry = loadRegistry(join(f.root, "definitions/registry.json"), join(f.root, "config/channels.json"));
    const packs = loadPacks(join(f.root, "definitions/packs.json"), new Set(registry.all().map((asset) => asset.id)), new Set(["stocks", "forex"]));
    expect(registry.all()).toHaveLength(3);
    expect(registry.lookupByTradingView("TVC:DXY")).toMatchObject({ id: "dxy", currency: "USD", channel: "forex" });
    expect(packs.find((pack) => pack.id === "forex")).toMatchObject({ assets: ["dxy", "exy"], channel: "forex" });
    expect(await readFile(join(f.root, "config/channels.json"))).toEqual(f.channelsBytes);
    expect(result.receipt.schemaVersion).toBe(2);
    expect(result.receipt.assetLogos).toEqual([]);
    expect(result.receipt.sourceState.registryBeforeSha256).toBe(sha256(f.registryBytes));
    expect(result.receipt.sourceState.registryAfterSha256).toBe(sha256(await readFile(join(f.root, "definitions/registry.json"))));
    expect(await transactionFiles(f.root, f.workspace)).toEqual([]);
    await expect(lstat(f.receiptPath)).resolves.toBeDefined();
    await expect(applyCreatePackWithMissingAssetsFile({ repositoryRoot: f.root, inputPath: f.inputPath, previewPath: f.previewPath, receiptOutputPath: f.receiptPath })).resolves.toMatchObject({ ok: false, reason: "stale_registry_state" });
  });

  it.each([
    ["after Registry replacement", { afterReplacement: async (index: number) => { if (index === 0) throw new Error("fault"); } }, "source_write_verification_failed"],
    ["during joint verification", { beforeJointVerification: async () => { throw new Error("fault"); } }, "source_write_verification_failed"],
    ["during receipt finalization", { beforeReceiptFinalize: async () => { throw new Error("fault"); } }, "application_receipt_finalize_failed"],
  ] as const)("restores both exact sources %s", async (_label, dependencies, reason) => {
    const f = await fixture();
    const result = await applyCreatePackWithMissingAssetsFile({ repositoryRoot: f.root, inputPath: f.inputPath, previewPath: f.previewPath, receiptOutputPath: f.receiptPath }, dependencies);
    expect(result).toMatchObject({ ok: false, reason, safelyRestored: true });
    expect(await readFile(join(f.root, "definitions/registry.json"))).toEqual(f.registryBytes);
    expect(await readFile(join(f.root, "definitions/packs.json"))).toEqual(f.packsBytes);
    expect(await readFile(join(f.root, "config/channels.json"))).toEqual(f.channelsBytes);
    await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await transactionFiles(f.root, f.workspace)).toEqual([]);
  });

  it("rolls both sources back when stored operator input changes during application", async () => {
    const f = await fixture();
    const result = await applyCreatePackWithMissingAssetsFile(
      { repositoryRoot: f.root, inputPath: f.inputPath, previewPath: f.previewPath, receiptOutputPath: f.receiptPath },
      { afterReplacement: async (index) => { if (index === 0) await writeFile(f.inputPath, Buffer.from("{}\n")); } },
    );
    expect(result).toMatchObject({ ok: false, reason: "source_write_verification_failed", safelyRestored: true });
    expect(await readFile(join(f.root, "definitions/registry.json"))).toEqual(f.registryBytes);
    expect(await readFile(join(f.root, "definitions/packs.json"))).toEqual(f.packsBytes);
    await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not claim a verified rollback when immutable channels change during application", async () => {
    const f = await fixture();
    const result = await applyCreatePackWithMissingAssetsFile(
      { repositoryRoot: f.root, inputPath: f.inputPath, previewPath: f.previewPath, receiptOutputPath: f.receiptPath },
      { beforeJointVerification: async () => { await writeFile(join(f.root, "config/channels.json"), Buffer.concat([f.channelsBytes, Buffer.from(" ")])); } },
    );
    expect(result).toMatchObject({ ok: false, reason: "rollback_verification_failed", safelyRestored: false });
    expect(await readFile(join(f.root, "definitions/registry.json"))).toEqual(f.registryBytes);
    expect(await readFile(join(f.root, "definitions/packs.json"))).toEqual(f.packsBytes);
    await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports stale Registry, Packs, and channels distinctly before mutation", async () => {
    for (const [relativePath, expected] of [
      ["definitions/registry.json", "stale_registry_state"],
      ["definitions/packs.json", "stale_pack_state"],
      ["config/channels.json", "stale_channel_state"],
    ] as const) {
      const f = await fixture();
      await writeFile(join(f.root, relativePath), Buffer.concat([await readFile(join(f.root, relativePath)), Buffer.from(" ")]));
      const result = await applyCreatePackWithMissingAssetsFile({ repositoryRoot: f.root, inputPath: f.inputPath, previewPath: f.previewPath, receiptOutputPath: f.receiptPath });
      expect(result).toMatchObject({ ok: false, reason: expected, safelyRestored: false });
    }
  });

  it("keeps rollback failure and rollback verification failure distinct", async () => {
    const failed = await fixture();
    expect(await applyCreatePackWithMissingAssetsFile(
      { repositoryRoot: failed.root, inputPath: failed.inputPath, previewPath: failed.previewPath, receiptOutputPath: failed.receiptPath },
      { afterReplacement: async (index) => { if (index === 0) throw new Error("fault"); }, simulateRollbackFailure: true },
    )).toMatchObject({ ok: false, reason: "rollback_failed", safelyRestored: false });

    const unverifiable = await fixture();
    expect(await applyCreatePackWithMissingAssetsFile(
      { repositoryRoot: unverifiable.root, inputPath: unverifiable.inputPath, previewPath: unverifiable.previewPath, receiptOutputPath: unverifiable.receiptPath },
      { afterReplacement: async (index) => { if (index === 0) throw new Error("fault"); }, simulateRollbackVerificationFailure: true },
    )).toMatchObject({ ok: false, reason: "rollback_verification_failed", safelyRestored: false });
  });

  it("rejects source symlinks and input/output collisions", async () => {
    const f = await fixture();
    const registry = join(f.root, "definitions/registry.json");
    const real = join(f.root, "definitions/registry-real.json");
    await cp(registry, real);
    await rm(registry);
    await import("node:fs/promises").then(({ symlink }) => symlink(real, registry));
    expect(await applyCreatePackWithMissingAssetsFile({ repositoryRoot: f.root, inputPath: f.inputPath, previewPath: f.previewPath, receiptOutputPath: f.receiptPath })).toMatchObject({ ok: false, reason: "source_path_unsafe" });
  });
});

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyRegistryCsvImportFile } from "./registry-csv-import-file.ts";

const roots: string[] = [];
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "visionx-registry-csv-"));
  roots.push(root);
  await mkdir(join(root, "definitions"));
  await mkdir(join(root, "config"));
  const registry = Buffer.from(`${JSON.stringify({ btc: { tradingView: "CRYPTO:BTCUSD", display: "Bitcoin", currency: "USD", channel: "crypto" } }, null, 2)}\n`);
  const packs = Buffer.from(`${JSON.stringify([{ id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] }], null, 2)}\n`);
  const channels = Buffer.from(`${JSON.stringify({ crypto: "1", stocks: "2" }, null, 2)}\n`);
  await writeFile(join(root, "definitions/registry.json"), registry);
  await writeFile(join(root, "definitions/packs.json"), packs);
  await writeFile(join(root, "config/channels.json"), channels);
  return { root, registry, packs, channels };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Registry CSV atomic source application", () => {
  it("replaces Registry and Packs together after exact-state validation", async () => {
    const input = await fixture();
    const registryAfter = Buffer.from(`${JSON.stringify({
      btc: { tradingView: "CRYPTO:BTCUSD", display: "Bitcoin", currency: "USD", channel: "crypto" },
      aapl: { tradingView: "NASDAQ:AAPL", display: "Apple", currency: "USD", channel: "stocks" },
    }, null, 2)}\n`);
    const packsAfter = Buffer.from(`${JSON.stringify([{ id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "aapl"] }], null, 2)}\n`);

    const result = await applyRegistryCsvImportFile({
      repositoryRoot: input.root,
      expectedRegistrySha256: sha256(input.registry),
      expectedPacksSha256: sha256(input.packs),
      expectedChannelsSha256: sha256(input.channels),
      registryAfterBytes: registryAfter,
      packsAfterBytes: packsAfter,
    });

    expect(result.registrySha256).toBe(sha256(registryAfter));
    expect(result.packsSha256).toBe(sha256(packsAfter));
    expect(await readFile(join(input.root, "definitions/registry.json"))).toEqual(registryAfter);
    expect(await readFile(join(input.root, "definitions/packs.json"))).toEqual(packsAfter);
  });


  it("rejects an invalid combined candidate before either source is replaced", async () => {
    const input = await fixture();
    const invalidRegistry = Buffer.from(`${JSON.stringify({
      btc: { tradingView: "CRYPTO:BTCUSD", display: "Bitcoin", currency: "USD", channel: "crypto" },
      broken: { tradingView: "NASDAQ:BROKEN", display: "Broken", currency: "USD", channel: "missing" },
    }, null, 2)}\n`);
    await expect(applyRegistryCsvImportFile({
      repositoryRoot: input.root,
      expectedRegistrySha256: sha256(input.registry),
      expectedPacksSha256: sha256(input.packs),
      expectedChannelsSha256: sha256(input.channels),
      registryAfterBytes: invalidRegistry,
      packsAfterBytes: input.packs,
    })).rejects.toMatchObject({ code: "invalid_candidate" });
    expect(await readFile(join(input.root, "definitions/registry.json"))).toEqual(input.registry);
    expect(await readFile(join(input.root, "definitions/packs.json"))).toEqual(input.packs);
  });

  it("rejects stale source hashes without changing either canonical file", async () => {
    const input = await fixture();
    await expect(applyRegistryCsvImportFile({
      repositoryRoot: input.root,
      expectedRegistrySha256: "0".repeat(64),
      expectedPacksSha256: sha256(input.packs),
      expectedChannelsSha256: sha256(input.channels),
      registryAfterBytes: input.registry,
      packsAfterBytes: input.packs,
    })).rejects.toMatchObject({ code: "stale_source_state" });
    expect(await readFile(join(input.root, "definitions/registry.json"))).toEqual(input.registry);
    expect(await readFile(join(input.root, "definitions/packs.json"))).toEqual(input.packs);
  });
});

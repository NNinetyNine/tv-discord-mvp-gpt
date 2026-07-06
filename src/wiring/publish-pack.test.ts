import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pack } from "../packs/packs.ts";
import type { PackSession } from "../packs/session.ts";
import { createPersistentSession } from "../packs/persistence.ts";
import { createStagingStore, type StagingStore } from "./staging.ts";
import { buildChannelResolver, type ChannelResolver } from "./channels.ts";
import { publishActivePack, type PublishPackDeps } from "./publish-pack.ts";

const packs: Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth", "sol"] },
  { id: "stocks", display: "Stocks", assets: ["aapl"] },
];

const okChannels: ChannelResolver = buildChannelResolver({
  crypto: "chan-crypto",
  stocks: "chan-stocks",
});
const blankCrypto: ChannelResolver = buildChannelResolver({ crypto: "", stocks: "chan-stocks" });

function fakePublisher(failOnPath?: string) {
  const calls: Array<{ channelId: string; imagePath: string }> = [];
  return {
    calls,
    publisher: {
      async publish(channelId: string, imagePath: string): Promise<void> {
        if (failOnPath && imagePath === failOnPath) throw new Error("discord boom");
        calls.push({ channelId, imagePath });
      },
    },
  };
}

let stagingBase: string;
let srcDir: string;
let sessionPath: string;
let staging: StagingStore;

beforeEach(() => {
  stagingBase = mkdtempSync(join(tmpdir(), "visionx-pub-staging-"));
  srcDir = mkdtempSync(join(tmpdir(), "visionx-pub-src-"));
  sessionPath = join(srcDir, "session.json");
  staging = createStagingStore(stagingBase);
});
afterEach(() => {
  rmSync(stagingBase, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

function makeSource(name: string): string {
  const p = join(srcDir, name);
  writeFileSync(p, "PNGDATA", "utf8");
  return p;
}

function captureAndStage(session: PackSession, packId: string, assetId: string, at: string): string {
  const staged = staging.stage(packId, assetId, makeSource(`${assetId}.png`));
  const r = session.capture(assetId, at);
  if (!r.ok) throw new Error(`fixture capture failed: ${assetId}`);
  return staged.path;
}

function deps(
  session: PackSession,
  publisher: PublishPackDeps["publisher"],
  resolveChannel: ChannelResolver,
  confirmPartial: PublishPackDeps["confirmPartial"],
): PublishPackDeps {
  return { session, staging, publisher, resolveChannel, confirmPartial };
}

const alwaysConfirm: PublishPackDeps["confirmPartial"] = async () => true;
const neverConfirm: PublishPackDeps["confirmPartial"] = async () => false;

describe("publishActivePack — full pack success", () => {
  it("publishes all staged images in canonical order, advances, and clears", async () => {
    const session = createPersistentSession({ packs, path: sessionPath });
    const pBtc = captureAndStage(session, "crypto", "btc", "t1");
    const pEth = captureAndStage(session, "crypto", "eth", "t2");
    const pSol = captureAndStage(session, "crypto", "sol", "t3");

    const fp = fakePublisher();
    const r = await publishActivePack(deps(session, fp.publisher, okChannels, alwaysConfirm));

    expect(r).toMatchObject({ ok: true, outcome: "published", packId: "crypto", advanced: true, wasPartial: false });
    if (r.ok) {
      expect(r.publishedAssetIds).toEqual(["btc", "eth", "sol"]);
      expect(r.cleared).toBe(true);
    }
    expect(fp.calls.map((c) => c.imagePath)).toEqual([pBtc, pEth, pSol]);
    expect(fp.calls.every((c) => c.channelId === "chan-crypto")).toBe(true);
    expect(session.activePack()?.id).toBe("stocks");
    expect(staging.list("crypto")).toEqual([]);
  });
});

describe("publishActivePack — partial pack", () => {
  it("publishes the captured subset after confirmation, then advances", async () => {
    const session = createPersistentSession({ packs, path: sessionPath });
    captureAndStage(session, "crypto", "btc", "t1");
    captureAndStage(session, "crypto", "sol", "t3"); // eth missing -> partial

    const fp = fakePublisher();
    const r = await publishActivePack(deps(session, fp.publisher, okChannels, alwaysConfirm));

    expect(r).toMatchObject({ ok: true, outcome: "published", wasPartial: true });
    if (r.ok) expect(r.publishedAssetIds).toEqual(["btc", "sol"]);
    expect(session.activePack()?.id).toBe("stocks");
  });

  it("declined partial publish does nothing (no publish, no advance, no clear)", async () => {
    const session = createPersistentSession({ packs, path: sessionPath });
    captureAndStage(session, "crypto", "btc", "t1"); // partial

    const fp = fakePublisher();
    const r = await publishActivePack(deps(session, fp.publisher, okChannels, neverConfirm));

    expect(r).toMatchObject({ ok: false, outcome: "partial_declined", packId: "crypto" });
    expect(fp.calls).toHaveLength(0);
    expect(session.activePack()?.id).toBe("crypto");
    expect(staging.has("crypto", "btc")).toBe(true);
  });
});

describe("publishActivePack — fail-closed guards", () => {
  it("no_active_pack when the session is complete", async () => {
    const session = createPersistentSession({ packs: [{ id: "only", display: "Only", assets: ["btc"] }], path: sessionPath });
    captureAndStage(session, "only", "btc", "t1");
    await publishActivePack(deps(session, fakePublisher().publisher, buildChannelResolver({ only: "c" }), alwaysConfirm));
    const r = await publishActivePack(deps(session, fakePublisher().publisher, buildChannelResolver({ only: "c" }), alwaysConfirm));
    expect(r).toMatchObject({ ok: false, outcome: "no_active_pack" });
  });

  it("nothing_captured when no captures exist (publishPack is never called)", async () => {
    const session = createPersistentSession({ packs, path: sessionPath });
    const fp = fakePublisher();
    const r = await publishActivePack(deps(session, fp.publisher, okChannels, alwaysConfirm));
    expect(r).toMatchObject({ ok: false, outcome: "nothing_captured", packId: "crypto" });
    expect(fp.calls).toHaveLength(0);
  });

  it("missing_staged_images when a captured asset has no staged file", async () => {
    const session = createPersistentSession({ packs, path: sessionPath });
    session.capture("btc", "t1"); // captured in session but NOT staged
    const fp = fakePublisher();
    const r = await publishActivePack(deps(session, fp.publisher, okChannels, alwaysConfirm));

    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "missing_staged_images") expect(r.missing).toEqual(["btc"]);
    else throw new Error("expected missing_staged_images");
    expect(fp.calls).toHaveLength(0);
    expect(session.activePack()?.id).toBe("crypto");
  });

  it("channel_unresolved (and does NOT prompt for confirmation) when channel id is blank", async () => {
    const session = createPersistentSession({ packs, path: sessionPath });
    captureAndStage(session, "crypto", "btc", "t1"); // partial, would normally prompt

    let prompted = false;
    const confirm: PublishPackDeps["confirmPartial"] = async () => {
      prompted = true;
      return true;
    };
    const fp = fakePublisher();
    const r = await publishActivePack(deps(session, fp.publisher, blankCrypto, confirm));

    expect(r).toMatchObject({ ok: false, outcome: "channel_unresolved", packId: "crypto" });
    expect(prompted).toBe(false); // resolved BEFORE confirmation
    expect(fp.calls).toHaveLength(0);
    expect(session.activePack()?.id).toBe("crypto");
  });
});

describe("publishActivePack — publish failure", () => {
  it("stops on first failure, does not advance, does not clear, reports progress", async () => {
    const session = createPersistentSession({ packs, path: sessionPath });
    const pBtc = captureAndStage(session, "crypto", "btc", "t1");
    const pEth = captureAndStage(session, "crypto", "eth", "t2");
    captureAndStage(session, "crypto", "sol", "t3");

    const fp = fakePublisher(pEth); // fail when publishing eth
    const r = await publishActivePack(deps(session, fp.publisher, okChannels, alwaysConfirm));

    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "publish_failed") {
      expect(r.publishedAssetIds).toEqual(["btc"]);
      expect(r.failedAssetId).toBe("eth");
      expect(r.advanced).toBe(false);
      expect(r.cleared).toBe(false);
    } else throw new Error("expected publish_failed");

    expect(fp.calls.map((c) => c.imagePath)).toEqual([pBtc]); // sol never attempted
    expect(session.activePack()?.id).toBe("crypto");
    expect(staging.has("crypto", "btc")).toBe(true);
    expect(staging.has("crypto", "sol")).toBe(true);
  });
});

describe("publishActivePack — latest staged image per asset", () => {
  it("publishes the most recent staged image after a recapture", async () => {
    const session = createPersistentSession({ packs: [{ id: "crypto", display: "Crypto", assets: ["btc"] }], path: sessionPath });
    captureAndStage(session, "crypto", "btc", "t1");
    const newer = staging.stage("crypto", "btc", makeSource("btc-v2.png"));
    session.capture("btc", "t2");

    const fp = fakePublisher();
    const r = await publishActivePack(deps(session, fp.publisher, buildChannelResolver({ crypto: "c" }), alwaysConfirm));

    expect(r.ok).toBe(true);
    expect(fp.calls).toHaveLength(1);
    expect(fp.calls[0]?.imagePath).toBe(newer.path);
  });
});

describe("publishActivePack — publish/advance/persistence/restore regression", () => {
  it("a fresh session restored from the same file resumes on the next pack", async () => {
    const sessionA = createPersistentSession({ packs, path: sessionPath });
    captureAndStage(sessionA, "crypto", "btc", "t1");
    captureAndStage(sessionA, "crypto", "eth", "t2");
    captureAndStage(sessionA, "crypto", "sol", "t3");

    const r = await publishActivePack(deps(sessionA, fakePublisher().publisher, okChannels, alwaysConfirm));
    expect(r).toMatchObject({ ok: true, outcome: "published", packId: "crypto", advanced: true });
    expect(sessionA.activePack()?.id).toBe("stocks");

    const sessionB = createPersistentSession({ packs, path: sessionPath });
    expect(sessionB.completedPackIds()).toEqual(["crypto"]);
    expect(sessionB.activePack()?.id).toBe("stocks");
    expect(sessionB.capturedAssets()).toEqual([]);

    captureAndStage(sessionB, "stocks", "aapl", "t4");
    const r2 = await publishActivePack(deps(sessionB, fakePublisher().publisher, okChannels, alwaysConfirm));
    expect(r2).toMatchObject({ ok: true, outcome: "published", packId: "stocks", advanced: true });
    expect(sessionB.isComplete()).toBe(true);
  });
});
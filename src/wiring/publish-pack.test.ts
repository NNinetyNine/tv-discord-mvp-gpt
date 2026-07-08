import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { publishActivePack, type PublishPackDeps, type PublisherSessionShape } from "./publish-pack.ts";
import { createSession, type PackSession } from "../packs/session.ts";
import { createPersistentSession } from "../packs/persistence.ts";
import { createStagingStore, type StagingStore } from "./staging.ts";
import { createReleaseStore, type ReleaseStore } from "../release/release-store.ts";
import type { Pack } from "../packs/packs.ts";

const PACKS: readonly Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", assets: ["aapl"] },
];

let workDir: string;
let staging: StagingStore;
let releases: ReleaseStore;
let session: PackSession;

/** Deterministic increasing timestamps. */
function makeNow(startMinute = 30): () => string {
  let minute = startMinute;
  return () => `2026-07-08T14:${String(minute++).padStart(2, "0")}:00.000Z`;
}

/** Fake publisher session factory: records posts, optional per-asset failure. */
function fakePublisher(failOnPath?: string) {
  const posts: Array<{ channelId: string; imagePath: string }> = [];
  let closed = 0;
  let msgCounter = 0;
  const sessionShape: PublisherSessionShape = {
    async post(channelId, imagePath) {
      if (failOnPath !== undefined && imagePath.endsWith(failOnPath)) {
        throw new Error("discord exploded");
      }
      posts.push({ channelId, imagePath });
      return { messageId: `msg-${++msgCounter}` };
    },
    async close() {
      closed++;
    },
  };
  return {
    open: async () => sessionShape,
    posts,
    closedCount: () => closed,
  };
}

function stageAsset(packId: string, assetId: string): void {
  const src = join(workDir, `src-${packId}-${assetId}.png`);
  writeFileSync(src, `png:${assetId}`);
  staging.stage(packId, assetId, src);
}

function captureAll(packId: "crypto" | "stocks"): void {
  const pack = PACKS.find((p) => p.id === packId)!;
  for (const assetId of pack.assets) {
    const r = session.capture(assetId, `captured-${assetId}`);
    if (!r.ok) throw new Error(`test setup: capture rejected for ${assetId}`);
    stageAsset(packId, assetId);
  }
}

function deps(overrides?: Partial<PublishPackDeps>): PublishPackDeps {
  return {
    session,
    staging,
    releases,
    resolveChannel: () => "chan-1",
    openPublisher: fakePublisher().open,
    assetDisplay: (id) => id.toUpperCase(),
    now: makeNow(),
    ...overrides,
  };
}

const GO = { supersedeInterrupted: false } as const;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "publish-pack-test-"));
  mkdirSync(join(workDir, "staging"), { recursive: true });
  staging = createStagingStore(join(workDir, "staging"));
  releases = createReleaseStore(join(workDir, "archive"));
  session = createSession(PACKS);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("gates", () => {
  it("no_active_pack when the session is complete", async () => {
    session.advance();
    session.advance();
    const r = await publishActivePack(deps(), GO);
    expect(r).toEqual({ ok: false, outcome: "no_active_pack" });
  });

  it("pack_incomplete names the missing assets; nothing external happens", async () => {
    session.capture("btc", "t");
    stageAsset("crypto", "btc");
    const fp = fakePublisher();
    const r = await publishActivePack(deps({ openPublisher: fp.open }), GO);
    expect(r).toEqual({
      ok: false,
      outcome: "pack_incomplete",
      packId: "crypto",
      captured: 1,
      total: 2,
      missingAssetIds: ["eth"],
    });
    expect(fp.posts).toHaveLength(0);
    expect(releases.listReleases("crypto")).toHaveLength(0);
  });

  it("missing_staged_images fails closed before any posting", async () => {
    captureAll("crypto");
    staging.unstage("crypto", "eth");
    const r = await publishActivePack(deps(), GO);
    expect(r).toMatchObject({ ok: false, outcome: "missing_staged_images", missing: ["eth"] });
    expect(releases.listReleases("crypto")).toHaveLength(0);
  });

  it("channel_unresolved fails closed", async () => {
    captureAll("crypto");
    const r = await publishActivePack(deps({ resolveChannel: () => null }), GO);
    expect(r).toMatchObject({ ok: false, outcome: "channel_unresolved", packId: "crypto" });
    expect(releases.listReleases("crypto")).toHaveLength(0);
  });

  it("publisher_connect_failed leaves ZERO durable state (open precedes create)", async () => {
    captureAll("crypto");
    const r = await publishActivePack(
      deps({ openPublisher: async () => { throw new Error("bad token"); } }),
      GO,
    );
    expect(r).toMatchObject({ ok: false, outcome: "publisher_connect_failed", detail: "bad token" });
    expect(releases.listReleases("crypto")).toHaveLength(0);
    expect(session.activePack()?.id).toBe("crypto"); // no advance
  });
});

describe("published (happy path)", () => {
  it("archives first, posts in canonical order, records identities, advances, clears", async () => {
    captureAll("crypto");
    const fp = fakePublisher();
    const r = await publishActivePack(deps({ openPublisher: fp.open }), GO);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.publishedAssetIds).toEqual(["btc", "eth"]);
    expect(r.advanced).toBe(true);
    expect(r.cleared).toBe(true);

    // Release record: published, message identities recorded, custody held.
    const rec = releases.getRelease("crypto", r.releaseId);
    expect(rec.state).toBe("published");
    expect(rec.packDisplay).toBe("Crypto");
    expect(rec.channelId).toBe("chan-1");
    expect(rec.analyses.map((a) => [a.assetId, a.display, a.discordMessageId])).toEqual([
      ["btc", "BTC", "msg-1"],
      ["eth", "ETH", "msg-2"],
    ]);
    // Posted from staged paths, in canonical order.
    expect(fp.posts.map((p) => p.channelId)).toEqual(["chan-1", "chan-1"]);
    expect(fp.closedCount()).toBe(1);

    // Workspace reset: session advanced to stocks; staging cleared.
    expect(session.activePack()?.id).toBe("stocks");
    expect(staging.list("crypto")).toEqual([]);
    // Archive custody survives the staging clear.
    expect(existsSync(join(workDir, "archive", "crypto", r.releaseId, "btc.png"))).toBe(true);
  });
});

describe("publish_interrupted (honest failure)", () => {
  it("mid-post failure: earned identities recorded, no advance, staging kept, publisher closed", async () => {
    captureAll("crypto");
    const fp = fakePublisher("eth.png"); // btc posts, eth fails
    const r = await publishActivePack(deps({ openPublisher: fp.open }), GO);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.outcome).toBe("publish_interrupted");
    if (r.outcome !== "publish_interrupted") return;
    expect(r.failedAssetId).toBe("eth");
    expect(r.publishedAssetIds).toEqual(["btc"]);

    // The release tells the exact truth: btc posted (identity held), eth not.
    const rec = releases.getRelease("crypto", r.releaseId);
    expect(rec.state).toBe("publishing");
    expect(rec.analyses.find((a) => a.assetId === "btc")?.discordMessageId).toBe("msg-1");
    expect(rec.analyses.find((a) => a.assetId === "eth")?.discordMessageId).toBeNull();

    // Workspace untouched; socket closed.
    expect(session.activePack()?.id).toBe("crypto");
    expect(staging.has("crypto", "btc")).toBe(true);
    expect(fp.closedCount()).toBe(1);
  });
});

describe("interrupted release: refuse / supersede", () => {
  async function interruptCrypto(): Promise<string> {
    captureAll("crypto");
    const fp = fakePublisher("eth.png");
    const r = await publishActivePack(deps({ openPublisher: fp.open, now: makeNow(10) }), GO);
    if (r.ok || r.outcome !== "publish_interrupted") throw new Error("setup failed");
    return r.releaseId;
  }

  it("a fresh publish is REFUSED while an unsuperseded interrupted release exists", async () => {
    const stuckId = await interruptCrypto();
    const fp = fakePublisher();
    const r = await publishActivePack(deps({ openPublisher: fp.open, now: makeNow(20) }), GO);
    expect(r).toMatchObject({
      ok: false,
      outcome: "interrupted_release_exists",
      packId: "crypto",
      releaseId: stuckId,
      postedCount: 1,
      totalCount: 2,
    });
    expect(fp.posts).toHaveLength(0);
  });

  it("supersedeInterrupted publishes fresh; the old record is untouched and retired from 'live'", async () => {
    const stuckId = await interruptCrypto();
    const fp = fakePublisher();
    const r = await publishActivePack(
      deps({ openPublisher: fp.open, now: makeNow(20) }),
      { supersedeInterrupted: true },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Old record: unchanged on disk, still publishing, identity preserved.
    const old = releases.getRelease("crypto", stuckId);
    expect(old.state).toBe("publishing");
    expect(old.analyses.find((a) => a.assetId === "btc")?.discordMessageId).toBe("msg-1");

    // New record published; supersession is DERIVED: the old interrupted record
    // no longer blocks anything.
    expect(releases.getRelease("crypto", r.releaseId).state).toBe("published");
    expect(session.activePack()?.id).toBe("stocks");
  });

  it("an interrupted release superseded by a later published one no longer blocks (derived, not stored)", async () => {
    // Build the archive state directly: old publishing record, newer published.
    const src1 = join(workDir, "a.png");
    writeFileSync(src1, "png");
    releases.createRelease({
      packId: "crypto", packDisplay: "Crypto", channelId: "c",
      startedAt: "2026-07-08T09:00:00.000Z",
      analyses: [{ assetId: "btc", display: "BTC", capturedAt: "t", sourceImagePath: src1 }],
    });
    const newer = releases.createRelease({
      packId: "crypto", packDisplay: "Crypto", channelId: "c",
      startedAt: "2026-07-08T11:00:00.000Z",
      analyses: [{ assetId: "btc", display: "BTC", capturedAt: "t", sourceImagePath: src1 }],
    });
    releases.recordPost("crypto", newer.releaseId, "btc", "m", "t");
    releases.markPublished("crypto", newer.releaseId, "t");

    captureAll("crypto");
    const fp = fakePublisher();
    const r = await publishActivePack(deps({ openPublisher: fp.open, now: makeNow(50) }), GO);
    expect(r.ok).toBe(true); // no refusal: the 09:00 interruption was superseded
  });
});

describe("pack_incomplete — zero captured (nothing_captured is subsumed)", () => {
  it("a pack with nothing captured is simply incomplete", async () => {
    const r = await publishActivePack(deps(), GO);
    expect(r).toMatchObject({
      ok: false,
      outcome: "pack_incomplete",
      packId: "crypto",
      captured: 0,
      total: 2,
      missingAssetIds: ["btc", "eth"],
    });
  });
});

describe("revision honesty — newest staged image publishes and is archived", () => {
  it("after a re-stage, the release custody copy holds the newer bytes", async () => {
    captureAll("crypto");
    const newerSrc = join(workDir, "btc-v2.png");
    writeFileSync(newerSrc, "png:btc-v2");
    staging.stage("crypto", "btc", newerSrc);
    session.capture("btc", "recaptured");

    const r = await publishActivePack(deps(), GO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      readFileSync(join(workDir, "archive", "crypto", r.releaseId, "btc.png"), "utf8"),
    ).toBe("png:btc-v2");
  });
});

describe("publish + persistent session restore (regression)", () => {
  it("a session restored from the same file resumes on the next pack after publish", async () => {
    const sessionPath = join(workDir, "session.json");
    const persistent = createPersistentSession({ packs: PACKS, path: sessionPath });
    for (const assetId of ["btc", "eth"]) {
      const src = join(workDir, `p-${assetId}.png`);
      writeFileSync(src, `png:${assetId}`);
      staging.stage("crypto", assetId, src);
      const c = persistent.capture(assetId, `t-${assetId}`);
      if (!c.ok) throw new Error(`test setup: capture rejected for ${assetId}`);
    }

    const r = await publishActivePack(deps({ session: persistent }), GO);
    expect(r.ok).toBe(true);

    const restored = createPersistentSession({ packs: PACKS, path: sessionPath });
    expect(restored.completedPackIds()).toEqual(["crypto"]);
    expect(restored.activePack()?.id).toBe("stocks");
    expect(restored.capturedAssets()).toEqual([]);
  });
});

describe("record-write failure after a successful post (truth-telling branch)", () => {
  it("reports the live-but-unrecorded message in detail; release stays publishing", async () => {
    captureAll("crypto");
    const wrapped: ReleaseStore = {
      ...releases,
      recordPost(packId, releaseId, assetId, msgId, at) {
        if (assetId === "eth") throw new Error("disk full");
        return releases.recordPost(packId, releaseId, assetId, msgId, at);
      },
    };

    const r = await publishActivePack(deps({ releases: wrapped }), GO);
    expect(r.ok).toBe(false);
    if (r.ok || r.outcome !== "publish_interrupted") throw new Error("expected publish_interrupted");
    expect(r.failedAssetId).toBe("eth");
    expect(r.publishedAssetIds).toEqual(["btc"]);
    expect(r.detail).toContain("posted to Discord");
    expect(r.detail).toContain("msg-2"); // the live message's identity is confessed

    const rec = releases.getRelease("crypto", r.releaseId);
    expect(rec.state).toBe("publishing");
    expect(rec.analyses.find((a) => a.assetId === "btc")?.discordMessageId).toBe("msg-1");
    // eth is LIVE on Discord but honestly unrecorded — the gap the detail names.
    expect(rec.analyses.find((a) => a.assetId === "eth")?.discordMessageId).toBeNull();
  });
});
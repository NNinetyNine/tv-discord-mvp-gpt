import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  publishPack,
  resumeInterruptedRelease,
  type PublishPackDeps,
  type ResumePackDeps,
  type PublisherSessionShape,
} from "./publish-pack.ts";
import { createWorkspace, type Workspace } from "../packs/workspace.ts";
import { createPersistentWorkspace } from "../packs/persistence.ts";
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
let workspace: Workspace;

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
  staging.stage(assetId, src);
}

function captureAll(packId: "crypto" | "stocks"): void {
  const pack = PACKS.find((p) => p.id === packId)!;
  for (const assetId of pack.assets) {
    workspace.capture(assetId, `captured-${assetId}`);
    stageAsset(packId, assetId);
  }
}

function deps(overrides?: Partial<PublishPackDeps>): PublishPackDeps {
  return {
    workspace,
    staging,
    releases,
    resolveChannel: () => "chan-1",
    openPublisher: fakePublisher().open,
    assetDisplay: (id) => id.toUpperCase(),
    now: makeNow(),
    ...overrides,
  };
}

function resumeDeps(overrides?: Partial<ResumePackDeps>): ResumePackDeps {
  return {
    workspace,
    staging,
    releases,
    openPublisher: fakePublisher().open,
    now: makeNow(40),
    ...overrides,
  };
}

const GO = { supersedeInterrupted: false } as const;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "publish-pack-test-"));
  mkdirSync(join(workDir, "staging"), { recursive: true });
  staging = createStagingStore(join(workDir, "staging"));
  releases = createReleaseStore(join(workDir, "archive"));
  workspace = createWorkspace(PACKS);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("gates", () => {
  it("throws LOUDLY on an unknown packId (callers validate operator input)", async () => {
    await expect(publishPack(deps(), "nope", GO)).rejects.toThrow(/unknown pack/);
  });

  it("pack_incomplete names the missing assets; nothing external happens", async () => {
    workspace.capture("btc", "t");
    stageAsset("crypto", "btc");
    const fp = fakePublisher();
    const r = await publishPack(deps({ openPublisher: fp.open }), "crypto", GO);
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
    staging.unstage("eth");
    const r = await publishPack(deps(), "crypto", GO);
    expect(r).toMatchObject({ ok: false, outcome: "missing_staged_images", missing: ["eth"] });
    expect(releases.listReleases("crypto")).toHaveLength(0);
  });

  it("channel_unresolved fails closed", async () => {
    captureAll("crypto");
    const r = await publishPack(deps({ resolveChannel: () => null }), "crypto", GO);
    expect(r).toMatchObject({ ok: false, outcome: "channel_unresolved", packId: "crypto" });
    expect(releases.listReleases("crypto")).toHaveLength(0);
  });

  it("publisher_connect_failed leaves ZERO durable state (open precedes create)", async () => {
    captureAll("crypto");
    const r = await publishPack(
      deps({ openPublisher: async () => { throw new Error("bad token"); } }),
      "crypto",
      GO,
    );
    expect(r).toMatchObject({ ok: false, outcome: "publisher_connect_failed", detail: "bad token" });
    expect(releases.listReleases("crypto")).toHaveLength(0);
    expect(workspace.packState("crypto")).toBe("complete"); // no reset
  });
});

describe("published (happy path)", () => {
  it("archives first, posts in canonical order, records identities, resets the pack, clears", async () => {
    captureAll("crypto");
    const fp = fakePublisher();
    const r = await publishPack(deps({ openPublisher: fp.open }), "crypto", GO);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.publishedAssetIds).toEqual(["btc", "eth"]);
    expect(r.cleared).toBe(true);

    // Release record: published (publishedAt set), identities recorded, custody held.
    const rec = releases.getRelease("crypto", r.releaseId);
    expect(rec.publishedAt).not.toBeNull();
    expect(rec.packDisplay).toBe("Crypto");
    expect(rec.channelId).toBe("chan-1");
    expect(rec.analyses.map((a) => [a.assetId, a.display, a.discordMessageId])).toEqual([
      ["btc", "BTC", "msg-1"],
      ["eth", "ETH", "msg-2"],
    ]);
    // Posted from staged paths, in canonical order.
    expect(fp.posts.map((p) => p.channelId)).toEqual(["chan-1", "chan-1"]);
    expect(fp.closedCount()).toBe(1);

    // This pack's instance ended (per-pack reset); the release's assets cleared.
    expect(workspace.packState("crypto")).toBe("empty");
    expect(staging.list()).toEqual([]);
    // Archive custody survives the staging clear.
    expect(existsSync(join(workDir, "archive", "crypto", r.releaseId, "btc.png"))).toBe(true);
  });
});

describe("publish_interrupted (honest failure)", () => {
  it("mid-post failure: earned identities recorded, no reset, staging kept, publisher closed", async () => {
    captureAll("crypto");
    const fp = fakePublisher("eth.png"); // btc posts, eth fails
    const r = await publishPack(deps({ openPublisher: fp.open }), "crypto", GO);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.outcome).toBe("publish_interrupted");
    if (r.outcome !== "publish_interrupted") return;
    expect(r.failedAssetId).toBe("eth");
    expect(r.publishedAssetIds).toEqual(["btc"]);

    // The release tells the exact truth: btc posted (identity held), eth not,
    // and the release is still in flight (publishedAt null).
    const rec = releases.getRelease("crypto", r.releaseId);
    expect(rec.publishedAt).toBeNull();
    expect(rec.analyses.find((a) => a.assetId === "btc")?.discordMessageId).toBe("msg-1");
    expect(rec.analyses.find((a) => a.assetId === "eth")?.discordMessageId).toBeNull();

    // Workspace untouched; socket closed.
    expect(workspace.packState("crypto")).toBe("complete");
    expect(staging.has("btc")).toBe(true);
    expect(fp.closedCount()).toBe(1);
  });
});

describe("interrupted release: refuse / supersede", () => {
  async function interruptCrypto(): Promise<string> {
    captureAll("crypto");
    const fp = fakePublisher("eth.png");
    const r = await publishPack(deps({ openPublisher: fp.open, now: makeNow(10) }), "crypto", GO);
    if (r.ok || r.outcome !== "publish_interrupted") throw new Error("setup failed");
    return r.releaseId;
  }

  it("a fresh publish is REFUSED while an unsuperseded interrupted release exists", async () => {
    const stuckId = await interruptCrypto();
    const fp = fakePublisher();
    const r = await publishPack(deps({ openPublisher: fp.open, now: makeNow(20) }), "crypto", GO);
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
    const r = await publishPack(
      deps({ openPublisher: fp.open, now: makeNow(20) }),
      "crypto",
      { supersedeInterrupted: true },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Old record: unchanged on disk, still in flight, identity preserved.
    const old = releases.getRelease("crypto", stuckId);
    expect(old.publishedAt).toBeNull();
    expect(old.analyses.find((a) => a.assetId === "btc")?.discordMessageId).toBe("msg-1");

    // New record published; supersession is DERIVED: the old interrupted record
    // no longer blocks anything.
    expect(releases.getRelease("crypto", r.releaseId).publishedAt).not.toBeNull();
    expect(workspace.packState("crypto")).toBe("empty"); // this pack's instance ended
  });

  it("an interrupted release superseded by a later published one no longer blocks (derived, not stored)", async () => {
    // Build the archive state directly: old in-flight record, newer published.
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
    const r = await publishPack(deps({ openPublisher: fp.open, now: makeNow(50) }), "crypto", GO);
    expect(r.ok).toBe(true); // no refusal: the 09:00 interruption was superseded
  });
});

describe("pack_incomplete — zero captured (nothing_captured is subsumed)", () => {
  it("a pack with nothing captured is simply incomplete", async () => {
    const r = await publishPack(deps(), "crypto", GO);
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
    staging.stage("btc", newerSrc);
    workspace.capture("btc", "recaptured");

    const r = await publishPack(deps(), "crypto", GO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      readFileSync(join(workDir, "archive", "crypto", r.releaseId, "btc.png"), "utf8"),
    ).toBe("png:btc-v2");
  });
});

describe("publish + persisted workspace restore (regression)", () => {
  it("a workspace restored from the same file shows the published pack reset and others untouched", async () => {
    const sessionPath = join(workDir, "session.json");
    const persisted = createPersistentWorkspace({ packs: PACKS, path: sessionPath });
    persisted.workspace.capture("aapl", "t-aapl"); // another pack's work, must survive
    for (const assetId of ["btc", "eth"]) {
      const src = join(workDir, `p-${assetId}.png`);
      writeFileSync(src, `png:${assetId}`);
      staging.stage(assetId, src);
      persisted.workspace.capture(assetId, `t-${assetId}`);
    }

    const r = await publishPack(deps({ workspace: persisted.workspace }), "crypto", GO);
    expect(r.ok).toBe(true);

    const restored = createPersistentWorkspace({ packs: PACKS, path: sessionPath });
    expect(restored.workspace.packState("crypto")).toBe("empty"); // published pack reset, durably
    expect(restored.workspace.captureOf("btc")).toBeNull();
    expect(restored.workspace.captureOf("aapl")).not.toBeNull(); // other pack untouched
  });
});

describe("record-write failure after a successful post (truth-telling branch)", () => {
  it("reports the live-but-unrecorded message in detail; release stays in flight", async () => {
    captureAll("crypto");
    const wrapped: ReleaseStore = {
      ...releases,
      recordPost(packId, releaseId, assetId, msgId, at) {
        if (assetId === "eth") throw new Error("disk full");
        return releases.recordPost(packId, releaseId, assetId, msgId, at);
      },
    };

    const r = await publishPack(deps({ releases: wrapped }), "crypto", GO);
    expect(r.ok).toBe(false);
    if (r.ok || r.outcome !== "publish_interrupted") throw new Error("expected publish_interrupted");
    expect(r.failedAssetId).toBe("eth");
    expect(r.publishedAssetIds).toEqual(["btc"]);
    expect(r.detail).toContain("posted to Discord");
    expect(r.detail).toContain("msg-2"); // the live message's identity is confessed

    const rec = releases.getRelease("crypto", r.releaseId);
    expect(rec.publishedAt).toBeNull();
    expect(rec.analyses.find((a) => a.assetId === "btc")?.discordMessageId).toBe("msg-1");
    // eth is LIVE on Discord but honestly unrecorded — the gap the detail names.
    expect(rec.analyses.find((a) => a.assetId === "eth")?.discordMessageId).toBeNull();
  });
});

describe("resume — completing an interrupted release", () => {
  async function interruptCrypto(): Promise<string> {
    captureAll("crypto");
    const fp = fakePublisher("eth.png"); // btc posts, eth fails
    const r = await publishPack(deps({ openPublisher: fp.open, now: makeNow(10) }), "crypto", GO);
    if (r.ok || r.outcome !== "publish_interrupted") throw new Error("setup failed");
    return r.releaseId;
  }

  it("posts ONLY the unposted remainder from archive custody, completes, resets the pack, clears", async () => {
    const releaseId = await interruptCrypto();
    const fp = fakePublisher();
    const r = await resumeInterruptedRelease(resumeDeps({ openPublisher: fp.open }), "crypto");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcome).toBe("resumed");
    expect(r.releaseId).toBe(releaseId); // the SAME release — never a second one
    expect(r.postedNowAssetIds).toEqual(["eth"]);
    expect(r.cleared).toBe(true);

    // Exactly one post happened, from ARCHIVE custody (not staging).
    expect(fp.posts).toHaveLength(1);
    expect(fp.posts[0]!.imagePath).toBe(
      join(workDir, "archive", "crypto", releaseId, "eth.png"),
    );

    // The record: published, btc's ORIGINAL identity preserved, eth's earned.
    // (Both read "msg-1" because each fake publisher session numbers its own
    // posts from 1 — the invariant is that btc's identity from the FIRST run
    // survived untouched, not the counter values.)
    const rec = releases.getRelease("crypto", releaseId);
    expect(rec.publishedAt).not.toBeNull();
    expect(rec.analyses.find((a) => a.assetId === "btc")?.discordMessageId).toBe("msg-1");
    expect(rec.analyses.find((a) => a.assetId === "eth")?.discordMessageId).toBe("msg-1");
    expect(releases.listReleases("crypto")).toHaveLength(1); // no second release

    // This pack's instance ended only now; the release's assets cleared.
    expect(workspace.packState("crypto")).toBe("empty");
    expect(staging.list()).toEqual([]);
    expect(fp.closedCount()).toBe(1);
  });

  it("posts to the RECORD's snapshotted channel (no channel resolver dependency exists)", async () => {
    await interruptCrypto();
    const fp = fakePublisher();
    await resumeInterruptedRelease(resumeDeps({ openPublisher: fp.open }), "crypto");
    expect(fp.posts[0]!.channelId).toBe("chan-1"); // from the record
  });

  it("a release interrupted AFTER its last post resumes by posting nothing", async () => {
    // Build the state directly: all posted, never marked published.
    const src = join(workDir, "s.png");
    writeFileSync(src, "png");
    const rec = releases.createRelease({
      packId: "crypto", packDisplay: "Crypto", channelId: "c",
      startedAt: "2026-07-08T10:00:00.000Z",
      analyses: [{ assetId: "btc", display: "BTC", capturedAt: "t", sourceImagePath: src }],
    });
    releases.recordPost("crypto", rec.releaseId, "btc", "msg-old", "t");
    workspace.capture("btc", "t"); // in-flight work for the pack being completed

    const fp = fakePublisher();
    const r = await resumeInterruptedRelease(resumeDeps({ openPublisher: fp.open }), "crypto");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.postedNowAssetIds).toEqual([]); // nothing posted now — and that's correct
    expect(fp.posts).toHaveLength(0);
    expect(releases.getRelease("crypto", rec.releaseId).publishedAt).not.toBeNull();
    expect(workspace.packState("crypto")).toBe("empty"); // instance ended
  });

  it("nothing_to_resume when the pack has no interrupted release; nothing changes", async () => {
    workspace.capture("btc", "t");
    const r = await resumeInterruptedRelease(resumeDeps(), "crypto");
    expect(r).toEqual({ ok: false, outcome: "nothing_to_resume", packId: "crypto" });
    expect(workspace.captureOf("btc")).not.toBeNull(); // no reset
  });

  it("resuming one pack never touches another pack's work (per-pack reset)", async () => {
    const releaseId = await interruptCrypto();
    workspace.capture("aapl", "t-aapl"); // stocks work in flight alongside

    const fp = fakePublisher();
    const r = await resumeInterruptedRelease(resumeDeps({ openPublisher: fp.open }), "crypto");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.releaseId).toBe(releaseId);

    expect(workspace.packState("crypto")).toBe("empty"); // resumed pack reset
    expect(workspace.captureOf("aapl")).not.toBeNull(); // stocks untouched
    expect(workspace.packState("stocks")).toBe("complete");
  });

  it("connect failure leaves the interrupted release and workspace untouched", async () => {
    const releaseId = await interruptCrypto();
    const r = await resumeInterruptedRelease(
      resumeDeps({ openPublisher: async () => { throw new Error("bad token"); } }),
      "crypto",
    );
    expect(r).toMatchObject({ ok: false, outcome: "publisher_connect_failed", detail: "bad token" });
    expect(releases.getRelease("crypto", releaseId).publishedAt).toBeNull(); // unchanged
    expect(workspace.packState("crypto")).toBe("complete"); // no reset
    expect(staging.has("btc")).toBe(true); // staging kept
  });

  it("resume interrupted AGAIN stays honest and re-runnable", async () => {
    const releaseId = await interruptCrypto();

    // First resume attempt also fails on eth.
    const failing = fakePublisher("eth.png");
    const r1 = await resumeInterruptedRelease(resumeDeps({ openPublisher: failing.open }), "crypto");
    expect(r1.ok).toBe(false);
    if (r1.ok || r1.outcome !== "publish_interrupted") throw new Error("expected publish_interrupted");
    expect(r1.releaseId).toBe(releaseId);
    expect(r1.publishedAssetIds).toEqual([]); // nothing earned this run
    expect(workspace.packState("crypto")).toBe("complete"); // still no reset

    // Second resume succeeds — same release, completed.
    const fp = fakePublisher();
    const r2 = await resumeInterruptedRelease(resumeDeps({ openPublisher: fp.open }), "crypto");
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.releaseId).toBe(releaseId);
    expect(releases.listReleases("crypto")).toHaveLength(1); // still exactly one release
  });
});
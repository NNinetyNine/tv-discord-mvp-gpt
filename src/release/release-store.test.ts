import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createReleaseStore,
  ReleaseError,
  type ReleaseStore,
  type CreateReleaseInput,
} from "./release-store.ts";

let workDir: string;
let archiveDir: string;
let sourcesDir: string;
let store: ReleaseStore;

let sourceCounter = 0;
function writeSource(name?: string): string {
  const file = name ?? `src-${sourceCounter++}.png`;
  const p = join(sourcesDir, file);
  writeFileSync(p, `fake-png-bytes:${file}`);
  return p;
}

function input(overrides?: Partial<CreateReleaseInput>): CreateReleaseInput {
  return {
    packId: "crypto",
    packDisplay: "Crypto",
    channelId: "chan-1",
    startedAt: "2026-07-08T14:30:22.118Z",
    analyses: [
      { assetId: "btc", display: "Bitcoin", capturedAt: "2026-07-08T14:00:00.000Z", sourceImagePath: writeSource("btc.png") },
      { assetId: "eth", display: "Ethereum", capturedAt: "2026-07-08T14:05:00.000Z", sourceImagePath: writeSource("eth.png") },
    ],
    ...overrides,
  };
}

/** A minimal single-analysis input at a given startedAt (for multi-release tests). */
function singleAt(startedAt: string): CreateReleaseInput {
  return {
    packId: "crypto",
    packDisplay: "Crypto",
    channelId: "chan-1",
    startedAt,
    analyses: [{ assetId: "btc", display: "Bitcoin", capturedAt: "t", sourceImagePath: writeSource() }],
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "release-store-test-"));
  archiveDir = join(workDir, "archive");
  sourcesDir = join(workDir, "sources");
  mkdirSync(sourcesDir, { recursive: true });
  store = createReleaseStore(archiveDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("release identity", () => {
  it("generates an opaque rls_-prefixed id with no semantic content", () => {
    const record = store.createRelease(input());
    expect(record.releaseId).toMatch(/^rls_[0-9a-f]{16}$/);
    // Identity carries no time: the startedAt is NOT embedded in the id.
    expect(record.releaseId).not.toContain("2026");
  });

  it("two releases of the same pack (even same startedAt) get distinct identities", () => {
    const a = store.createRelease(singleAt("2026-07-08T14:30:22.118Z"));
    const b = store.createRelease(singleAt("2026-07-08T14:30:22.118Z"));
    expect(a.releaseId).not.toBe(b.releaseId);
    expect(existsSync(join(archiveDir, "crypto", a.releaseId, "release.json"))).toBe(true);
    expect(existsSync(join(archiveDir, "crypto", b.releaseId, "release.json"))).toBe(true);
  });
});

describe("createRelease", () => {
  it("copies images into the archive and writes a publishing record", () => {
    const record = store.createRelease(input());

    expect(record.state).toBe("publishing");
    expect(record.publishedAt).toBeNull();
    expect(record.startedAt).toBe("2026-07-08T14:30:22.118Z"); // metadata, preserved verbatim
    expect(record.corrections).toEqual([]);
    expect(record.analyses).toEqual([
      { assetId: "btc", display: "Bitcoin", capturedAt: "2026-07-08T14:00:00.000Z", imageFile: "btc.png", discordMessageId: null, postedAt: null },
      { assetId: "eth", display: "Ethereum", capturedAt: "2026-07-08T14:05:00.000Z", imageFile: "eth.png", discordMessageId: null, postedAt: null },
    ]);

    const dir = join(archiveDir, "crypto", record.releaseId);
    expect(existsSync(join(dir, "release.json"))).toBe(true);
    expect(readFileSync(join(dir, "btc.png"), "utf8")).toBe("fake-png-bytes:btc.png");
    expect(readFileSync(join(dir, "eth.png"), "utf8")).toBe("fake-png-bytes:eth.png");
  });

  it("archived images are COPIES: sources remain untouched", () => {
    const inp = input();
    store.createRelease(inp);
    for (const a of inp.analyses) {
      expect(existsSync(a.sourceImagePath)).toBe(true);
    }
  });

  it("fails with zero side effects when a source image is missing", () => {
    const inp = input({
      analyses: [
        { assetId: "btc", display: "Bitcoin", capturedAt: "t", sourceImagePath: writeSource("ok.png") },
        { assetId: "eth", display: "Ethereum", capturedAt: "t", sourceImagePath: join(sourcesDir, "missing.png") },
      ],
    });
    expect(() => store.createRelease(inp)).toThrow(ReleaseError);
    // Nothing was created — not even the pack directory.
    expect(existsSync(join(archiveDir, "crypto"))).toBe(false);
  });

  it("rejects empty analyses, duplicate assetIds, and unsafe ids", () => {
    expect(() => store.createRelease(input({ analyses: [] }))).toThrow(/no analyses/);

    const dup = input({
      analyses: [
        { assetId: "btc", display: "Bitcoin", capturedAt: "t", sourceImagePath: writeSource() },
        { assetId: "btc", display: "Bitcoin", capturedAt: "t", sourceImagePath: writeSource() },
      ],
    });
    expect(() => store.createRelease(dup)).toThrow(/duplicate assetId/);

    const unsafe = input({
      analyses: [{ assetId: "../evil", display: "X", capturedAt: "t", sourceImagePath: writeSource() }],
    });
    expect(() => store.createRelease(unsafe)).toThrow(ReleaseError);

    expect(() => store.createRelease(input({ packId: "no/slashes" }))).toThrow(ReleaseError);
  });
});

describe("listReleases — policy-free facts", () => {
  it("returns [] for a pack with no releases", () => {
    expect(store.listReleases("crypto")).toEqual([]);
  });

  it("returns every release regardless of state", () => {
    const a = store.createRelease(singleAt("2026-07-08T09:00:00.000Z"));
    const b = store.createRelease(singleAt("2026-07-08T11:00:00.000Z"));
    store.recordPost("crypto", b.releaseId, "btc", "m1", "t");
    store.markPublished("crypto", b.releaseId, "t-pub");

    const all = store.listReleases("crypto");
    expect(all).toHaveLength(2);
    const byId = new Map(all.map((r) => [r.releaseId, r]));
    expect(byId.get(a.releaseId)?.state).toBe("publishing");
    expect(byId.get(b.releaseId)?.state).toBe("published");
  });

  it("imposes no ordering policy (facts only; ordering belongs to policy)", () => {
    store.createRelease(singleAt("2026-07-08T09:00:00.000Z"));
    store.createRelease(singleAt("2026-07-08T11:00:00.000Z"));
    const all = store.listReleases("crypto");
    // Assert contents, not order: the store's contract is the SET of facts.
    expect(new Set(all.map((r) => r.startedAt))).toEqual(
      new Set(["2026-07-08T09:00:00.000Z", "2026-07-08T11:00:00.000Z"]),
    );
  });

  it("fails LOUD on a corrupt record instead of silently skipping it", () => {
    const rec = store.createRelease(input());
    writeFileSync(join(archiveDir, "crypto", rec.releaseId, "release.json"), "{ not json", "utf8");
    expect(() => store.listReleases("crypto")).toThrow(/corrupt release record/);
  });
});

describe("recordPost", () => {
  it("records a message identity incrementally and persists it", () => {
    const rec = store.createRelease(input());
    store.recordPost("crypto", rec.releaseId, "btc", "msg-100", "2026-07-08T14:31:00.000Z");

    const loaded = store.getRelease("crypto", rec.releaseId);
    expect(loaded.analyses).toEqual([
      { assetId: "btc", display: "Bitcoin", capturedAt: "2026-07-08T14:00:00.000Z", imageFile: "btc.png", discordMessageId: "msg-100", postedAt: "2026-07-08T14:31:00.000Z" },
      { assetId: "eth", display: "Ethereum", capturedAt: "2026-07-08T14:05:00.000Z", imageFile: "eth.png", discordMessageId: null, postedAt: null },
    ]);
    expect(loaded.state).toBe("publishing");
  });

  it("rejects a post for an unknown asset", () => {
    const rec = store.createRelease(input());
    expect(() => store.recordPost("crypto", rec.releaseId, "doge", "m", "t")).toThrow(/no analysis for asset/);
  });

  it("rejects a double post for the same asset (bug guard)", () => {
    const rec = store.createRelease(input());
    store.recordPost("crypto", rec.releaseId, "btc", "msg-100", "t1");
    expect(() => store.recordPost("crypto", rec.releaseId, "btc", "msg-200", "t2")).toThrow(/double post/);
  });

  it("rejects posts on a published release", () => {
    const rec = store.createRelease(input());
    store.recordPost("crypto", rec.releaseId, "btc", "m1", "t");
    store.recordPost("crypto", rec.releaseId, "eth", "m2", "t");
    store.markPublished("crypto", rec.releaseId, "t-pub");
    expect(() => store.recordPost("crypto", rec.releaseId, "btc", "m3", "t")).toThrow(/state "published"/);
  });
});

describe("markPublished", () => {
  it("refuses while any analysis is unposted, naming the missing", () => {
    const rec = store.createRelease(input());
    store.recordPost("crypto", rec.releaseId, "btc", "m1", "t");
    expect(() => store.markPublished("crypto", rec.releaseId, "t-pub")).toThrow(/eth/);
  });

  it("transitions publishing -> published once every analysis is posted", () => {
    const rec = store.createRelease(input());
    store.recordPost("crypto", rec.releaseId, "btc", "m1", "t1");
    store.recordPost("crypto", rec.releaseId, "eth", "m2", "t2");
    const done = store.markPublished("crypto", rec.releaseId, "2026-07-08T14:35:00.000Z");
    expect(done.state).toBe("published");
    expect(done.publishedAt).toBe("2026-07-08T14:35:00.000Z");

    const loaded = store.getRelease("crypto", rec.releaseId);
    expect(loaded.state).toBe("published");
  });

  it("cannot double-publish", () => {
    const rec = store.createRelease(input());
    store.recordPost("crypto", rec.releaseId, "btc", "m1", "t");
    store.recordPost("crypto", rec.releaseId, "eth", "m2", "t");
    store.markPublished("crypto", rec.releaseId, "t-pub");
    expect(() => store.markPublished("crypto", rec.releaseId, "t-again")).toThrow(/state "published"/);
  });
});
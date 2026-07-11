import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStagingStore, StagingError } from "./staging.ts";

let base: string; // temp staging base dir
let src: string;  // temp dir for source images

function makeSource(name: string, contents = "PNGDATA"): string {
  const p = join(src, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "visionx-staging-"));
  src = mkdtempSync(join(tmpdir(), "visionx-src-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

describe("stage", () => {
  it("writes the image to the deterministic asset-keyed path and creates directories", () => {
    const store = createStagingStore(base);
    const sourcePath = makeSource("btc.png");
    const staged = store.stage("btc", sourcePath);

    expect(staged).toMatchObject({ assetId: "btc" });
    expect(staged.path).toBe(join(base, "active", "btc.png"));
    expect(typeof staged.stagedAt).toBe("string");
    expect(existsSync(staged.path)).toBe(true);
  });

  it("copies rather than moves (source remains)", () => {
    const store = createStagingStore(base);
    const sourcePath = makeSource("btc.png");
    store.stage("btc", sourcePath);
    expect(existsSync(sourcePath)).toBe(true);
  });

  it("re-staging the same asset overwrites (newest wins)", () => {
    const store = createStagingStore(base);
    store.stage("btc", makeSource("v1.png", "FIRST"));
    const second = store.stage("btc", makeSource("v2.png", "SECOND"));
    expect(readFileSync(second.path, "utf8")).toBe("SECOND");
    // still exactly one file for this asset
    expect(store.list().filter((s) => s.assetId === "btc")).toHaveLength(1);
  });

  it("throws if the source image does not exist", () => {
    const store = createStagingStore(base);
    expect(() => store.stage("btc", join(src, "missing.png"))).toThrow(StagingError);
  });
});

describe("get / has", () => {
  it("get returns the staged record or null", () => {
    const store = createStagingStore(base);
    expect(store.get("btc")).toBeNull();
    store.stage("btc", makeSource("btc.png"));
    expect(store.get("btc")?.assetId).toBe("btc");
  });

  it("has reflects existence", () => {
    const store = createStagingStore(base);
    expect(store.has("btc")).toBe(false);
    store.stage("btc", makeSource("btc.png"));
    expect(store.has("btc")).toBe(true);
  });
});

describe("list", () => {
  it("returns ALL staged assets, deterministically ordered", () => {
    const store = createStagingStore(base);
    store.stage("eth", makeSource("eth.png"));
    store.stage("aapl", makeSource("aapl.png"));
    store.stage("btc", makeSource("btc.png"));
    expect(store.list().map((s) => s.assetId)).toEqual(["aapl", "btc", "eth"]); // sorted
  });

  it("is empty when nothing is staged", () => {
    const store = createStagingStore(base);
    expect(store.list()).toEqual([]);
  });
});

describe("unstage", () => {
  it("removes one asset and returns true; leaves siblings intact", () => {
    const store = createStagingStore(base);
    store.stage("btc", makeSource("btc.png"));
    store.stage("eth", makeSource("eth.png"));
    expect(store.unstage("btc")).toBe(true);
    expect(store.has("btc")).toBe(false);
    expect(store.has("eth")).toBe(true);
  });

  it("returns false when nothing was staged", () => {
    const store = createStagingStore(base);
    expect(store.unstage("btc")).toBe(false);
  });
});

describe("clear (by explicit asset ids)", () => {
  it("removes exactly the supplied assets, leaving others intact", () => {
    const store = createStagingStore(base);
    store.stage("btc", makeSource("btc.png"));
    store.stage("eth", makeSource("eth.png"));
    store.stage("aapl", makeSource("aapl.png"));
    store.clear(["btc", "eth"]);
    expect(store.list().map((s) => s.assetId)).toEqual(["aapl"]);
  });

  it("is a no-op for assets with nothing staged (mixed with real ones)", () => {
    const store = createStagingStore(base);
    store.stage("btc", makeSource("btc.png"));
    expect(() => store.clear(["btc", "never-staged"])).not.toThrow();
    expect(store.list()).toEqual([]);
  });

  it("an empty list clears nothing", () => {
    const store = createStagingStore(base);
    store.stage("btc", makeSource("btc.png"));
    store.clear([]);
    expect(store.has("btc")).toBe(true);
  });
});

describe("path-safety", () => {
  it("rejects unsafe asset IDs on stage", () => {
    const store = createStagingStore(base);
    const sourcePath = makeSource("x.png");
    expect(() => store.stage("../../etc/passwd", sourcePath)).toThrow(StagingError);
    expect(() => store.stage("a/b", sourcePath)).toThrow(StagingError);
    expect(() => store.stage("..", sourcePath)).toThrow(StagingError);
  });

  it("accepts dotted/numeric asset IDs that are genuinely used (brk.b, 1810)", () => {
    const store = createStagingStore(base);
    expect(() => store.stage("brk.b", makeSource("brkb.png"))).not.toThrow();
    expect(() => store.stage("1810", makeSource("xiaomi.png"))).not.toThrow();
    expect(store.has("brk.b")).toBe(true);
  });

  it("read and clear methods also reject unsafe IDs", () => {
    const store = createStagingStore(base);
    expect(() => store.get("../x")).toThrow(StagingError);
    expect(() => store.has("a/b")).toThrow(StagingError);
    expect(() => store.unstage("..")).toThrow(StagingError);
    expect(() => store.clear(["a/b"])).toThrow(StagingError);
  });
});

describe("list ignores non-png files", () => {
  it("a stray non-png in the staging root is not listed", () => {
    const store = createStagingStore(base);
    store.stage("btc", makeSource("btc.png"));
    writeFileSync(join(base, "active", "stray.tmp"), "junk", "utf8");
    expect(store.list().map((s) => s.assetId)).toEqual(["btc"]);
  });
});
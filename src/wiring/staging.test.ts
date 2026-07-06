import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
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
  it("writes the image to the deterministic path and creates directories", () => {
    const store = createStagingStore(base);
    const sourcePath = makeSource("btc.png");
    const staged = store.stage("crypto", "btc", sourcePath);

    expect(staged).toMatchObject({ packId: "crypto", assetId: "btc" });
    expect(staged.path).toBe(join(base, "active", "crypto", "btc.png"));
    expect(typeof staged.stagedAt).toBe("string");
    expect(existsSync(staged.path)).toBe(true);
  });

  it("copies rather than moves (source remains)", () => {
    const store = createStagingStore(base);
    const sourcePath = makeSource("btc.png");
    store.stage("crypto", "btc", sourcePath);
    expect(existsSync(sourcePath)).toBe(true);
  });

  it("re-staging the same asset overwrites (newest wins)", () => {
    const store = createStagingStore(base);
    store.stage("crypto", "btc", makeSource("v1.png", "FIRST"));
    const second = store.stage("crypto", "btc", makeSource("v2.png", "SECOND"));
    expect(readFileSync(second.path, "utf8")).toBe("SECOND");
    // still exactly one file for this asset
    expect(store.list("crypto").filter((s) => s.assetId === "btc")).toHaveLength(1);
  });

  it("throws if the source image does not exist", () => {
    const store = createStagingStore(base);
    expect(() => store.stage("crypto", "btc", join(src, "missing.png"))).toThrow(StagingError);
  });
});

describe("get / has", () => {
  it("get returns the staged record or null", () => {
    const store = createStagingStore(base);
    expect(store.get("crypto", "btc")).toBeNull();
    store.stage("crypto", "btc", makeSource("btc.png"));
    expect(store.get("crypto", "btc")?.assetId).toBe("btc");
  });

  it("has reflects existence", () => {
    const store = createStagingStore(base);
    expect(store.has("crypto", "btc")).toBe(false);
    store.stage("crypto", "btc", makeSource("btc.png"));
    expect(store.has("crypto", "btc")).toBe(true);
  });
});

describe("list", () => {
  it("returns all staged images for a pack, deterministically ordered", () => {
    const store = createStagingStore(base);
    store.stage("crypto", "eth", makeSource("eth.png"));
    store.stage("crypto", "btc", makeSource("btc.png"));
    expect(store.list("crypto").map((s) => s.assetId)).toEqual(["btc", "eth"]); // sorted
  });

  it("is empty for a pack with nothing staged", () => {
    const store = createStagingStore(base);
    expect(store.list("crypto")).toEqual([]);
  });

  it("is isolated across packs", () => {
    const store = createStagingStore(base);
    store.stage("crypto", "btc", makeSource("btc.png"));
    store.stage("stocks", "aapl", makeSource("aapl.png"));
    expect(store.list("crypto").map((s) => s.assetId)).toEqual(["btc"]);
    expect(store.list("stocks").map((s) => s.assetId)).toEqual(["aapl"]);
  });
});

describe("unstage", () => {
  it("removes one asset and returns true; leaves siblings intact", () => {
    const store = createStagingStore(base);
    store.stage("crypto", "btc", makeSource("btc.png"));
    store.stage("crypto", "eth", makeSource("eth.png"));
    expect(store.unstage("crypto", "btc")).toBe(true);
    expect(store.has("crypto", "btc")).toBe(false);
    expect(store.has("crypto", "eth")).toBe(true);
  });

  it("returns false when nothing was staged", () => {
    const store = createStagingStore(base);
    expect(store.unstage("crypto", "btc")).toBe(false);
  });
});

describe("clear", () => {
  it("removes all staged images for a pack, leaving other packs intact", () => {
    const store = createStagingStore(base);
    store.stage("crypto", "btc", makeSource("btc.png"));
    store.stage("crypto", "eth", makeSource("eth.png"));
    store.stage("stocks", "aapl", makeSource("aapl.png"));
    store.clear("crypto");
    expect(store.list("crypto")).toEqual([]);
    expect(store.list("stocks").map((s) => s.assetId)).toEqual(["aapl"]);
  });

  it("is a no-op for a pack with nothing staged", () => {
    const store = createStagingStore(base);
    expect(() => store.clear("crypto")).not.toThrow();
  });
});

describe("path-safety", () => {
  it("rejects unsafe pack IDs", () => {
    const store = createStagingStore(base);
    const sourcePath = makeSource("x.png");
    expect(() => store.stage("../escape", "btc", sourcePath)).toThrow(StagingError);
    expect(() => store.stage("a/b", "btc", sourcePath)).toThrow(StagingError);
    expect(() => store.stage("..", "btc", sourcePath)).toThrow(StagingError);
  });

  it("rejects unsafe asset IDs", () => {
    const store = createStagingStore(base);
    const sourcePath = makeSource("x.png");
    expect(() => store.stage("crypto", "../../etc/passwd", sourcePath)).toThrow(StagingError);
    expect(() => store.stage("crypto", "a/b", sourcePath)).toThrow(StagingError);
  });

  it("accepts dotted/numeric asset IDs that are genuinely used (brk.b, 1810)", () => {
    const store = createStagingStore(base);
    expect(() => store.stage("stocks", "brk.b", makeSource("brkb.png"))).not.toThrow();
    expect(() => store.stage("stocks", "1810", makeSource("xiaomi.png"))).not.toThrow();
    expect(store.has("stocks", "brk.b")).toBe(true);
  });

  it("read methods also reject unsafe IDs", () => {
    const store = createStagingStore(base);
    expect(() => store.get("../x", "btc")).toThrow(StagingError);
    expect(() => store.has("crypto", "a/b")).toThrow(StagingError);
    expect(() => store.list("..")).toThrow(StagingError);
  });
});

describe("list ignores non-png files", () => {
  it("a stray non-png in the pack dir is not listed", () => {
    const store = createStagingStore(base);
    store.stage("crypto", "btc", makeSource("btc.png"));
    const dir = join(base, "active", "crypto");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stray.tmp"), "junk", "utf8");
    expect(store.list("crypto").map((s) => s.assetId)).toEqual(["btc"]);
  });
});
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pack } from "./packs.ts";
import { createPersistentSession, PersistenceError } from "./persistence.ts";

const packs: Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth", "sol"] },
  { id: "stocks", display: "Stocks", assets: ["aapl", "nvda"] },
  { id: "indices", display: "Indices", assets: ["spx"] },
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "visionx-session-"));
  path = join(dir, "session.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("create new session", () => {
  it("starts on the first pack and writes the file", () => {
    expect(existsSync(path)).toBe(false);
    const s = createPersistentSession({ packs, path });
    expect(s.activePack()?.id).toBe("crypto");
    expect(s.isComplete()).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});

describe("restore existing session", () => {
  it("restores active pack, completed packs, and captures", () => {
    const a = createPersistentSession({ packs, path });
    a.capture("btc", "t1");
    a.capture("eth", "t2");
    a.advance(); // crypto complete -> stocks
    a.capture("aapl", "t3");

    const b = createPersistentSession({ packs, path });
    expect(b.completedPackIds()).toEqual(["crypto"]);
    expect(b.activePack()?.id).toBe("stocks");
    expect(b.capturedAssets().map((c) => c.assetId)).toEqual(["aapl"]);
    expect(b.capturedAssets()[0]?.capturedAt).toBe("t3");
  });

  it("restores a completed session", () => {
    const a = createPersistentSession({ packs, path });
    a.capture("btc", "t1"); a.advance();
    a.capture("aapl", "t2"); a.advance();
    a.capture("spx", "t3"); a.advance(); // all complete

    const b = createPersistentSession({ packs, path });
    expect(b.isComplete()).toBe(true);
    expect(b.completedPackIds()).toEqual(["crypto", "stocks", "indices"]);
    expect(b.activePack()).toBeNull();
  });
});

describe("auto-save on mutation", () => {
  it("saves after a capture", () => {
    const s = createPersistentSession({ packs, path });
    s.capture("btc", "t1");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captured.map((c: { assetId: string }) => c.assetId)).toEqual(["btc"]);
  });

  it("saves newest-wins replacement", () => {
    const s = createPersistentSession({ packs, path });
    s.capture("btc", "t1");
    s.capture("btc", "t2");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captured).toHaveLength(1);
    expect(onDisk.captured[0].capturedAt).toBe("t2");
  });

  it("saves after advance (completed recorded, captures cleared on disk)", () => {
    const s = createPersistentSession({ packs, path });
    s.capture("btc", "t1");
    s.advance();
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.completedPackIds).toEqual(["crypto"]);
    expect(onDisk.captured).toEqual([]);
  });

  it("a rejected capture does not modify the file", () => {
    const s = createPersistentSession({ packs, path });
    s.capture("btc", "t1");
    const before = readFileSync(path, "utf8");
    const r = s.capture("aapl", "t2"); // not in active crypto pack
    expect(r.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("fail-closed on bad files", () => {
  it("throws on invalid JSON", () => {
    writeFileSync(path, "{ not valid json", "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(PersistenceError);
    expect(() => createPersistentSession({ packs, path })).toThrow(/corrupt/i);
  });

  it("throws on an unsupported version", () => {
    writeFileSync(path, JSON.stringify({ version: 99, completedPackIds: [], captured: [] }), "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(/version/i);
  });

  it("throws on a malformed structure", () => {
    writeFileSync(path, JSON.stringify({ version: 1, completedPackIds: [], captured: [{ assetId: "btc" }] }), "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(/captured entry/i);
  });

  it("throws on incompatible completed packs (replay mismatch)", () => {
    // says 'stocks' completed first, but sequence starts with 'crypto'
    writeFileSync(path, JSON.stringify({ version: 1, completedPackIds: ["stocks"], captured: [] }), "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(/changed/i);
  });

  it("throws when a saved capture is impossible to replay for the active pack", () => {
    // 'aapl' is not in the active crypto pack
    writeFileSync(path, JSON.stringify({ version: 1, completedPackIds: [], captured: [{ assetId: "aapl", capturedAt: "t1" }] }), "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(/not valid for the active pack/i);
  });
});
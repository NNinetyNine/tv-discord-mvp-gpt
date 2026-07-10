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
  it("starts on the first pack and writes the file (version 2)", () => {
    expect(existsSync(path)).toBe(false);
    const s = createPersistentSession({ packs, path });
    expect(s.activePack()?.id).toBe("crypto");
    expect(s.isComplete()).toBe(false);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(2);
    expect(onDisk.captures).toEqual([]);
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

  it("restores revision counts (replacement semantics continue across restarts)", () => {
    const a = createPersistentSession({ packs, path });
    a.capture("btc", "t1");
    a.capture("btc", "t2"); // revision 2

    const b = createPersistentSession({ packs, path });
    // A further re-capture after restore is still a replacement — the count
    // survived the restart rather than resetting to 1.
    const r = b.capture("btc", "t3");
    expect(r).toEqual({ ok: true, assetId: "btc", replaced: true });
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captures).toHaveLength(1);
    expect(onDisk.captures[0]).toEqual({ assetId: "btc", capturedAt: "t3", revisions: 3 });
  });
});

describe("auto-save on mutation", () => {
  it("saves after a capture (with its revision count)", () => {
    const s = createPersistentSession({ packs, path });
    s.capture("btc", "t1");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captures.map((c: { assetId: string }) => c.assetId)).toEqual(["btc"]);
    expect(onDisk.captures[0].revisions).toBe(1);
  });

  it("saves newest-wins replacement (revision count incremented)", () => {
    const s = createPersistentSession({ packs, path });
    s.capture("btc", "t1");
    s.capture("btc", "t2");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captures).toHaveLength(1);
    expect(onDisk.captures[0].capturedAt).toBe("t2");
    expect(onDisk.captures[0].revisions).toBe(2);
  });

  it("saves after advance (completed recorded, captures cleared on disk)", () => {
    const s = createPersistentSession({ packs, path });
    s.capture("btc", "t1");
    s.advance();
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.completedPackIds).toEqual(["crypto"]);
    expect(onDisk.captures).toEqual([]);
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

describe("version-1 migration (one-time, demolition-scheduled)", () => {
  it("migrates a v1 file: captures carry over with revisions 1; cursor preserved", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        completedPackIds: ["crypto"],
        captured: [{ assetId: "aapl", capturedAt: "t3" }],
      }),
      "utf8",
    );

    const s = createPersistentSession({ packs, path });
    expect(s.completedPackIds()).toEqual(["crypto"]);
    expect(s.activePack()?.id).toBe("stocks");
    expect(s.capturedAssets()).toEqual([{ assetId: "aapl", capturedAt: "t3" }]);
    // revisions: 1 is the honest floor — v1 recorded no revision history, so
    // the next re-capture is revision 2 (a replacement).
    expect(s.capture("aapl", "t4")).toEqual({ ok: true, assetId: "aapl", replaced: true });
  });

  it("immediately rewrites the file in version-2 form (v1 is never written again)", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, completedPackIds: [], captured: [{ assetId: "btc", capturedAt: "t1" }] }),
      "utf8",
    );

    createPersistentSession({ packs, path });

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(2);
    expect("captured" in onDisk).toBe(false);
    expect(onDisk.captures).toEqual([{ assetId: "btc", capturedAt: "t1", revisions: 1 }]);
    expect(onDisk.completedPackIds).toEqual([]);

    // And the rewritten file restores cleanly on its own.
    const again = createPersistentSession({ packs, path });
    expect(again.capturedAssets().map((c) => c.assetId)).toEqual(["btc"]);
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

  it("throws on a malformed v1 structure", () => {
    writeFileSync(path, JSON.stringify({ version: 1, completedPackIds: [], captured: [{ assetId: "btc" }] }), "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(/captured entry/i);
  });

  it("throws on a malformed v2 captures entry", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 2, completedPackIds: [], captures: [{ assetId: "btc", capturedAt: "t1" }] }),
      "utf8",
    );
    expect(() => createPersistentSession({ packs, path })).toThrow(/revisions/i);
  });

  it("throws on incompatible completed packs in a v1 file (cursor mismatch)", () => {
    // says 'stocks' completed first, but sequence starts with 'crypto'
    writeFileSync(path, JSON.stringify({ version: 1, completedPackIds: ["stocks"], captured: [] }), "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(/changed/i);
  });

  it("throws on incompatible completed packs in a v2 file (transitional cursor coherence)", () => {
    writeFileSync(path, JSON.stringify({ version: 2, completedPackIds: ["stocks"], captures: [] }), "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(/changed/i);
  });

  it("throws when a v1 capture is impossible for the cursor's active pack (corrupt v1 file)", () => {
    // 'aapl' is not in the active crypto pack — a v1 file could never have
    // contained this; the migration validates with the replay-era invariant.
    writeFileSync(path, JSON.stringify({ version: 1, completedPackIds: [], captured: [{ assetId: "aapl", capturedAt: "t1" }] }), "utf8");
    expect(() => createPersistentSession({ packs, path })).toThrow(/not valid for the active pack/i);
  });

  it("a v2 capture outside the active pack is ACCEPTED (workspace fact, not corruption)", () => {
    // The workspace models captures for any asset (held work arrives in a
    // later step); rejecting membership here would rebuild Fossil 1 in the
    // new format. The compatibility layer's views simply don't count it.
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        completedPackIds: [],
        captures: [{ assetId: "aapl", capturedAt: "t1", revisions: 1 }],
      }),
      "utf8",
    );
    const s = createPersistentSession({ packs, path });
    expect(s.activePack()?.id).toBe("crypto");
    expect(s.capturedAssets()).toEqual([]); // aapl is not in the active pack's view
    expect(s.progress()?.captured).toBe(0);
    expect(s.hasCaptured("aapl")).toBe(true); // but the fact exists
  });
});
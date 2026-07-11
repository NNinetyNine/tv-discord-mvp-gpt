import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pack } from "./packs.ts";
import { createPersistentWorkspace, PersistenceError } from "./persistence.ts";

const packs: Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth", "sol"] },
  { id: "stocks", display: "Stocks", assets: ["aapl", "nvda"] },
  { id: "indices", display: "Indices", assets: ["spx"] },
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "visionx-workspace-"));
  path = join(dir, "session.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("create fresh working state", () => {
  it("starts empty and writes the file (version 3, captures only)", () => {
    expect(existsSync(path)).toBe(false);
    const ws = createPersistentWorkspace({ packs, path });
    expect(ws.captures()).toEqual([]);
    expect(ws.packState("crypto")).toBe("empty");
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual({ version: 3, captures: [] });
  });

  it("a Workspace over ZERO packs is legal (bidirectional scaling, §5)", () => {
    const ws = createPersistentWorkspace({ packs: [], path });
    // Captures for any asset simply exist as held work (§4.6).
    ws.capture("btc", "t1");
    expect(ws.captureOf("btc")).not.toBeNull();
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captures).toHaveLength(1);
  });
});

describe("restore existing working state", () => {
  it("restores capture facts, including revision counts, across restarts", () => {
    const a = createPersistentWorkspace({ packs, path });
    a.capture("btc", "t1");
    a.capture("btc", "t2"); // revision 2
    a.capture("aapl", "t3");

    const b = createPersistentWorkspace({ packs, path });
    expect(b.captureOf("btc")).toEqual({ assetId: "btc", capturedAt: "t2", revisions: 2 });
    expect(b.captureOf("aapl")).toEqual({ assetId: "aapl", capturedAt: "t3", revisions: 1 });
    // Replacement semantics continue: the next re-capture is revision 3.
    expect(b.capture("btc", "t4").revisions).toBe(3);
  });

  it("derived pack views come back from the restored facts alone", () => {
    const a = createPersistentWorkspace({ packs, path });
    a.capture("spx", "t1"); // indices complete
    a.capture("btc", "t2"); // crypto building

    const b = createPersistentWorkspace({ packs, path });
    expect(b.packState("indices")).toBe("complete");
    expect(b.packState("crypto")).toBe("building");
    expect(b.packState("stocks")).toBe("empty");
    expect(b.pendingAssets("crypto")).toEqual(["eth", "sol"]);
  });

  it("captures for assets in NO pack restore as inert held work (§4.6)", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        captures: [{ assetId: "retired", capturedAt: "t0", revisions: 2 }],
      }),
      "utf8",
    );
    const ws = createPersistentWorkspace({ packs, path });
    expect(ws.captureOf("retired")).toEqual({ assetId: "retired", capturedAt: "t0", revisions: 2 });
    // Counts toward nothing: every pack view is unaffected.
    expect(ws.packState("crypto")).toBe("empty");
    expect(ws.packState("stocks")).toBe("empty");
  });
});

describe("auto-save on mutation (one save discipline)", () => {
  it("saves after a capture (with its revision count)", () => {
    const ws = createPersistentWorkspace({ packs, path });
    ws.capture("btc", "t1");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captures).toEqual([{ assetId: "btc", capturedAt: "t1", revisions: 1 }]);
  });

  it("saves newest-wins replacement (revision count incremented)", () => {
    const ws = createPersistentWorkspace({ packs, path });
    ws.capture("btc", "t1");
    ws.capture("btc", "t2");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captures).toHaveLength(1);
    expect(onDisk.captures[0]).toEqual({ assetId: "btc", capturedAt: "t2", revisions: 2 });
  });

  it("saves after resetPack (that pack's facts cleared on disk; others kept)", () => {
    const ws = createPersistentWorkspace({ packs, path });
    ws.capture("btc", "t1");
    ws.capture("aapl", "t2");
    ws.resetPack("crypto");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captures).toEqual([{ assetId: "aapl", capturedAt: "t2", revisions: 1 }]);
  });

  it("captures for assets outside any pack persist as facts (held work)", () => {
    const ws = createPersistentWorkspace({ packs, path });
    ws.capture("doge", "t1"); // no pack contains doge
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.captures.map((c: { assetId: string }) => c.assetId)).toEqual(["doge"]);
    expect(ws.packState("crypto")).toBe("empty"); // counts toward nothing
  });
});

describe("version-1 migration (one-time, demolition-scheduled)", () => {
  it("migrates a v1 file: captures carry over with revisions 1; cursor DISCARDED", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        completedPackIds: ["crypto"],
        captured: [{ assetId: "aapl", capturedAt: "t3" }],
      }),
      "utf8",
    );

    const ws = createPersistentWorkspace({ packs, path });
    expect(ws.captureOf("aapl")).toEqual({ assetId: "aapl", capturedAt: "t3", revisions: 1 });
    // revisions: 1 is the honest floor — v1 recorded no revision history, so
    // the next re-capture is revision 2 (a replacement).
    expect(ws.capture("aapl", "t4").revisions).toBe(2);

    // The cursor is the dead session model's bookkeeping: dropped, not carried.
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(3);
    expect("completedPackIds" in onDisk).toBe(false);
    expect("captured" in onDisk).toBe(false);
  });

  it("a v1 capture outside the old cursor's active pack is ACCEPTED (replay validation is gone)", () => {
    // Under replay this was rejected as "not valid for the active pack".
    // Seeding replaced replay: the capture restores as an ordinary asset-
    // attached fact, and rejecting it would fire on legitimate definition
    // change — the failure mode this phase removes.
    writeFileSync(
      path,
      JSON.stringify({ version: 1, completedPackIds: [], captured: [{ assetId: "aapl", capturedAt: "t1" }] }),
      "utf8",
    );
    const ws = createPersistentWorkspace({ packs, path });
    expect(ws.captureOf("aapl")).not.toBeNull();
    expect(ws.packState("stocks")).toBe("building"); // it counts toward its pack
  });

  it("immediately rewrites the file in version-3 form and it restores cleanly", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, completedPackIds: [], captured: [{ assetId: "btc", capturedAt: "t1" }] }),
      "utf8",
    );

    createPersistentWorkspace({ packs, path });

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual({ version: 3, captures: [{ assetId: "btc", capturedAt: "t1", revisions: 1 }] });

    const again = createPersistentWorkspace({ packs, path });
    expect(again.captureOf("btc")).not.toBeNull();
  });
});

describe("version-2 migration (one-time, demolition-scheduled)", () => {
  it("migrates a v2 file: captures carry over VERBATIM; cursor DISCARDED", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        completedPackIds: ["crypto"],
        captures: [{ assetId: "aapl", capturedAt: "t1", revisions: 4 }],
      }),
      "utf8",
    );

    const ws = createPersistentWorkspace({ packs, path });
    expect(ws.captureOf("aapl")).toEqual({ assetId: "aapl", capturedAt: "t1", revisions: 4 });

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual({ version: 3, captures: [{ assetId: "aapl", capturedAt: "t1", revisions: 4 }] });
  });

  it("a v2 capture outside any pack migrates as inert held work", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        completedPackIds: [],
        captures: [{ assetId: "doge", capturedAt: "t1", revisions: 1 }],
      }),
      "utf8",
    );
    const ws = createPersistentWorkspace({ packs, path });
    expect(ws.captureOf("doge")).not.toBeNull();
    expect(ws.packState("crypto")).toBe("empty");
  });
});

describe("fail-closed on bad files", () => {
  it("throws on invalid JSON", () => {
    writeFileSync(path, "{ not valid json", "utf8");
    expect(() => createPersistentWorkspace({ packs, path })).toThrow(PersistenceError);
    expect(() => createPersistentWorkspace({ packs, path })).toThrow(/corrupt/i);
  });

  it("throws when the file is not an object", () => {
    writeFileSync(path, JSON.stringify([1, 2, 3]), "utf8");
    expect(() => createPersistentWorkspace({ packs, path })).toThrow(/not an object/i);
  });

  it("throws on an unsupported version", () => {
    writeFileSync(path, JSON.stringify({ version: 99, captures: [] }), "utf8");
    expect(() => createPersistentWorkspace({ packs, path })).toThrow(/version/i);
  });

  it("throws on a malformed v1 captured entry", () => {
    writeFileSync(path, JSON.stringify({ version: 1, completedPackIds: [], captured: [{ assetId: "btc" }] }), "utf8");
    expect(() => createPersistentWorkspace({ packs, path })).toThrow(/captured entry/i);
  });

  it("throws on a malformed v2/v3 captures entry (missing revisions)", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 3, captures: [{ assetId: "btc", capturedAt: "t1" }] }),
      "utf8",
    );
    expect(() => createPersistentWorkspace({ packs, path })).toThrow(/revisions/i);
  });

  it("throws on an invalid revision count", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 3, captures: [{ assetId: "btc", capturedAt: "t1", revisions: 0 }] }),
      "utf8",
    );
    expect(() => createPersistentWorkspace({ packs, path })).toThrow(/revisions/i);
  });

  it("fails loud on duplicate capture entries (workspace seed validation)", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        captures: [
          { assetId: "btc", capturedAt: "t1", revisions: 1 },
          { assetId: "btc", capturedAt: "t2", revisions: 2 },
        ],
      }),
      "utf8",
    );
    expect(() => createPersistentWorkspace({ packs, path })).toThrow(/duplicate/i);
  });
});
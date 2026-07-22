import { describe, it, expect } from "vitest";

import { createWorkspace, WorkspaceError, type AssetCapture } from "./workspace.ts";
import type { Pack } from "./packs.ts";

const PACKS: readonly Pack[] = [
  { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", channel: "stocks", assets: ["aapl"] },
];

/** Compare capture sets without asserting any ordering (none is guaranteed). */
function byAssetId(captures: readonly AssetCapture[]): Map<string, AssetCapture> {
  return new Map(captures.map((c) => [c.assetId, c]));
}

describe("construction — §9.1 disjointness asserted once, loudly", () => {
  it("rejects overlapping pack definitions, naming the asset and both packs", () => {
    const overlapping: readonly Pack[] = [
      { id: "morning", display: "Morning", channel: "crypto", assets: ["btc", "eth"] },
      { id: "evening", display: "Evening", channel: "crypto", assets: ["btc"] },
    ];
    expect(() => createWorkspace(overlapping)).toThrow(WorkspaceError);
    expect(() => createWorkspace(overlapping)).toThrow(/btc/);
    expect(() => createWorkspace(overlapping)).toThrow(/morning/);
    expect(() => createWorkspace(overlapping)).toThrow(/evening/);
    expect(() => createWorkspace(overlapping)).toThrow(/§9\.1/);
  });

  it("accepts disjoint packs and exposes them in canonical order", () => {
    const ws = createWorkspace(PACKS);
    expect(ws.packs().map((p) => p.id)).toEqual(["crypto", "stocks"]);
    expect(ws.pack("crypto")?.display).toBe("Crypto");
    expect(ws.pack("nope")).toBeNull();
  });

  it("seeds initial captures (restore path) preserving revision counts", () => {
    const seed: readonly AssetCapture[] = [{ assetId: "btc", capturedAt: "t1", revisions: 3 }];
    const ws = createWorkspace(PACKS, seed);
    expect(ws.captureOf("btc")).toEqual({ assetId: "btc", capturedAt: "t1", revisions: 3 });
  });

  it("rejects invalid seeds (bad revision count, duplicates, empty fields) — fail loud", () => {
    expect(() =>
      createWorkspace(PACKS, [{ assetId: "btc", capturedAt: "t", revisions: 0 }]),
    ).toThrow(/revision count/);
    expect(() =>
      createWorkspace(PACKS, [{ assetId: "btc", capturedAt: "t", revisions: 1.5 }]),
    ).toThrow(/revision count/);
    expect(() =>
      createWorkspace(PACKS, [
        { assetId: "btc", capturedAt: "t1", revisions: 1 },
        { assetId: "btc", capturedAt: "t2", revisions: 2 },
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      createWorkspace(PACKS, [{ assetId: "", capturedAt: "t", revisions: 1 }]),
    ).toThrow(WorkspaceError);
    expect(() =>
      createWorkspace(PACKS, [{ assetId: "btc", capturedAt: "", revisions: 1 }]),
    ).toThrow(WorkspaceError);
  });
});

describe("capture — asset-attached, no gates (§4.1), returns the updated fact", () => {
  it("accepts a capture for a pack member and returns the stored fact", () => {
    const ws = createWorkspace(PACKS);
    const fact = ws.capture("btc", "t1");
    expect(fact).toEqual({ assetId: "btc", capturedAt: "t1", revisions: 1 });
    expect(ws.packState("crypto")).toBe("building");
  });

  it("accepts a capture for an asset in NO pack — held work simply exists (§4.6)", () => {
    const ws = createWorkspace(PACKS);
    const fact = ws.capture("doge", "t1");
    expect(fact.revisions).toBe(1);
    expect(ws.captureOf("doge")).not.toBeNull();
    // Counts toward nothing: every pack view is unaffected.
    expect(ws.packState("crypto")).toBe("empty");
    expect(ws.packState("stocks")).toBe("empty");
  });

  it("re-capture replaces: newest wins; replacement is DERIVED as revisions > 1", () => {
    const ws = createWorkspace(PACKS);
    const first = ws.capture("btc", "t1");
    expect(first.revisions > 1).toBe(false); // first capture: not a replacement

    const second = ws.capture("btc", "t2");
    expect(second).toEqual({ assetId: "btc", capturedAt: "t2", revisions: 2 });
    expect(second.revisions > 1).toBe(true); // Revision 2+: a replacement, derived
    expect(ws.captureOf("btc")).toEqual({ assetId: "btc", capturedAt: "t2", revisions: 2 });
  });

  it("rejects empty ids/timestamps as programming faults", () => {
    const ws = createWorkspace(PACKS);
    expect(() => ws.capture("", "t")).toThrow(WorkspaceError);
    expect(() => ws.capture("btc", "")).toThrow(WorkspaceError);
  });
});

describe("derived pack views (definitions ∩ captures — nothing stored per pack)", () => {
  it("packState walks empty -> building -> complete from captures alone", () => {
    const ws = createWorkspace(PACKS);
    expect(ws.packState("crypto")).toBe("empty");
    ws.capture("btc", "t1");
    expect(ws.packState("crypto")).toBe("building");
    ws.capture("eth", "t2");
    expect(ws.packState("crypto")).toBe("complete");
    // Independent instances: stocks never moved.
    expect(ws.packState("stocks")).toBe("empty");
  });

  it("pendingAssets and capturedFor are in canonical pack order", () => {
    const ws = createWorkspace(PACKS);
    ws.capture("eth", "t1"); // captured out of canonical order
    expect(ws.pendingAssets("crypto")).toEqual(["btc"]);
    ws.capture("btc", "t2");
    expect(ws.capturedFor("crypto").map((c) => c.assetId)).toEqual(["btc", "eth"]);
    expect(ws.pendingAssets("crypto")).toEqual([]);
  });

  it("packs are INDEPENDENT: captures accumulate for several packs at once", () => {
    const ws = createWorkspace(PACKS);
    ws.capture("btc", "t1");
    ws.capture("aapl", "t2"); // no cursor: nothing forbids capturing for stocks
    expect(ws.packState("crypto")).toBe("building");
    expect(ws.packState("stocks")).toBe("complete");
  });

  it("unknown-asset captures (asset left the registry) sit inert in the facts", () => {
    // The workspace never consults a registry: a capture for any asset id is
    // an ordinary map entry; pack views ignore non-members.
    const ws = createWorkspace(PACKS, [{ assetId: "retired", capturedAt: "t0", revisions: 2 }]);
    expect(ws.captureOf("retired")).toEqual({ assetId: "retired", capturedAt: "t0", revisions: 2 });
    expect(ws.packState("crypto")).toBe("empty");
    expect(ws.packState("stocks")).toBe("empty");
  });

  it("fails loud on an unknown packId in every pack view (coherence)", () => {
    const ws = createWorkspace(PACKS);
    expect(() => ws.packState("nope")).toThrow(/unknown pack/);
    expect(() => ws.pendingAssets("nope")).toThrow(/unknown pack/);
    expect(() => ws.capturedFor("nope")).toThrow(/unknown pack/);
    expect(() => ws.resetPack("nope")).toThrow(/unknown pack/);
  });
});

describe("resetPack — the instance ends, only for that pack (§4.7, §4.5)", () => {
  it("clears the pack's captures INCLUDING revision history; others untouched", () => {
    const ws = createWorkspace(PACKS);
    ws.capture("btc", "t1");
    ws.capture("btc", "t2"); // rev 2
    ws.capture("eth", "t3");
    ws.capture("aapl", "t4"); // other pack
    ws.capture("doge", "t5"); // held work

    ws.resetPack("crypto");

    expect(ws.packState("crypto")).toBe("empty");
    expect(ws.captureOf("btc")).toBeNull();
    expect(ws.captureOf("eth")).toBeNull();
    // A fresh capture after reset starts at revision 1 (history cleared).
    expect(ws.capture("btc", "t6")).toEqual({ assetId: "btc", capturedAt: "t6", revisions: 1 });
    // Untouched: the other pack's instance and the held work.
    expect(ws.packState("stocks")).toBe("complete");
    expect(ws.captureOf("doge")).not.toBeNull();
  });
});

describe("resetAsset — discard one current Analysis (§4.7)", () => {
  it("clears exactly one capture and its revision history", () => {
    const ws = createWorkspace(PACKS);
    ws.capture("btc", "t1");
    ws.capture("btc", "t2");
    ws.capture("eth", "t3");

    expect(ws.resetAsset("btc")).toBe(true);

    expect(ws.captureOf("btc")).toBeNull();
    expect(ws.captureOf("eth")).toEqual({ assetId: "eth", capturedAt: "t3", revisions: 1 });
    expect(ws.capture("btc", "t4")).toEqual({ assetId: "btc", capturedAt: "t4", revisions: 1 });
  });

  it("reports an absent capture without changing other work", () => {
    const ws = createWorkspace(PACKS);
    ws.capture("eth", "t1");

    expect(ws.resetAsset("btc")).toBe(false);
    expect(ws.captures()).toEqual([{ assetId: "eth", capturedAt: "t1", revisions: 1 }]);
    expect(() => ws.resetAsset("")).toThrow(/assetId must be a non-empty string/u);
  });
});

describe("captures() — the complete set of stored facts, no ordering asserted", () => {
  it("returns every fact exactly once, compared as a set", () => {
    const ws = createWorkspace(PACKS);
    ws.capture("eth", "t1");
    ws.capture("aapl", "t2");
    ws.capture("btc", "t3");
    ws.capture("btc", "t4"); // rev 2

    const facts = byAssetId(ws.captures());
    expect(facts.size).toBe(3);
    expect(facts.get("btc")).toEqual({ assetId: "btc", capturedAt: "t4", revisions: 2 });
    expect(facts.get("eth")).toEqual({ assetId: "eth", capturedAt: "t1", revisions: 1 });
    expect(facts.get("aapl")).toEqual({ assetId: "aapl", capturedAt: "t2", revisions: 1 });
  });

  it("held work and unknown-asset work are ordinary facts in the set", () => {
    const ws = createWorkspace(PACKS, [{ assetId: "retired", capturedAt: "t0", revisions: 1 }]);
    ws.capture("doge", "t1"); // held work (no pack)
    ws.capture("btc", "t2"); // pack member

    const facts = byAssetId(ws.captures());
    expect(facts.size).toBe(3);
    expect([...facts.keys()].sort()).toEqual(["btc", "doge", "retired"]); // sorted by the TEST, not the API
  });
});

import { describe, it, expect } from "vitest";

import type { Pack } from "./packs.ts";
import { createSession, SessionError } from "./session.ts";

// Injected packs — independent of config/packs.json.
const packs: Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth", "sol"] },
  { id: "stocks", display: "Stocks", assets: ["aapl", "nvda"] },
  { id: "indices", display: "Indices", assets: ["spx"] },
];

describe("active pack derivation", () => {
  it("starts on the first pack in sequence", () => {
    const s = createSession(packs);
    expect(s.activePack()?.id).toBe("crypto");
    expect(s.isComplete()).toBe(false);
  });

  it("reports the next pack for hinting", () => {
    const s = createSession(packs);
    expect(s.nextPack()?.id).toBe("stocks");
  });

  it("throws if constructed with no packs", () => {
    expect(() => createSession([])).toThrow(SessionError);
  });
});

describe("membership validation", () => {
  it("captures an asset that belongs to the active pack", () => {
    const s = createSession(packs);
    const r = s.capture("btc", "t1");
    expect(r).toEqual({ ok: true, assetId: "btc", replaced: false });
    expect(s.progress()?.captured).toBe(1);
  });

  it("rejects an asset not in the active pack (state unchanged)", () => {
    const s = createSession(packs);
    const r = s.capture("aapl", "t1"); // aapl is in stocks, not the active crypto pack
    expect(r).toEqual({ ok: false, reason: "not_in_active_pack", assetId: "aapl" });
    expect(s.progress()?.captured).toBe(0);
  });

  it("rejects capture when the session is complete", () => {
    const s = createSession([{ id: "only", display: "Only", assets: ["btc"] }]);
    s.capture("btc", "t1");
    s.advance(); // now complete
    expect(s.capture("btc", "t2")).toEqual({ ok: false, reason: "no_active_pack" });
  });
});

describe("newest-wins replacement", () => {
  it("replacing keeps the count and updates the record", () => {
    const s = createSession(packs);
    s.capture("btc", "t1");
    const r2 = s.capture("btc", "t2");
    expect(r2).toEqual({ ok: true, assetId: "btc", replaced: true });
    expect(s.progress()?.captured).toBe(1); // not duplicated
    const rec = s.capturedAssets().find((c) => c.assetId === "btc");
    expect(rec?.capturedAt).toBe("t2"); // newest wins
  });
});

describe("progress + ordering", () => {
  it("captured and pending are reported in canonical pack order", () => {
    const s = createSession(packs);
    s.capture("sol", "t1"); // captured out of pack order
    s.capture("btc", "t2");
    expect(s.capturedAssets().map((c) => c.assetId)).toEqual(["btc", "sol"]); // pack order
    expect(s.pendingAssets()).toEqual(["eth"]);
  });

  it("progress exposes captured/total and position", () => {
    const s = createSession(packs);
    s.capture("btc", "t1");
    expect(s.progress()).toMatchObject({
      packId: "crypto",
      captured: 1,
      total: 3,
      position: 1,
      packCount: 3,
    });
  });
});

describe("publish planning (read-only, no advance)", () => {
  it("flags a partial pack and lists pending assets", () => {
    const s = createSession(packs);
    s.capture("btc", "t1");
    s.capture("eth", "t2");
    const plan = s.publishPack();
    expect(plan).toMatchObject({ packId: "crypto", total: 3, capturedCount: 2, isPartial: true });
    expect(plan.toPublish.map((c) => c.assetId)).toEqual(["btc", "eth"]); // pack order
    expect(plan.pendingAssets).toEqual(["sol"]);
    expect(s.activePack()?.id).toBe("crypto"); // did NOT advance
  });

  it("is not partial when every asset is captured", () => {
    const s = createSession(packs);
    s.capture("btc", "t1");
    s.capture("eth", "t2");
    s.capture("sol", "t3");
    expect(s.publishPack().isPartial).toBe(false);
  });

  it("throws when nothing is captured (no empty publish)", () => {
    const s = createSession(packs);
    expect(() => s.publishPack()).toThrow(/no captured assets/);
  });

  it("throws when the session is complete", () => {
    const s = createSession([{ id: "only", display: "Only", assets: ["btc"] }]);
    s.capture("btc", "t1");
    s.advance();
    expect(() => s.publishPack()).toThrow(/no active pack/);
  });
});

describe("advance — strictly forward", () => {
  it("advances to the next pack and clears captures", () => {
    const s = createSession(packs);
    s.capture("btc", "t1");
    s.advance();
    expect(s.activePack()?.id).toBe("stocks");
    expect(s.progress()?.captured).toBe(0); // cleared for the new pack
    expect(s.completedPackIds()).toEqual(["crypto"]);
  });

  it("a completed pack's asset cannot be captured under the new active pack", () => {
    const s = createSession(packs);
    s.capture("btc", "t1");
    s.advance(); // now on stocks
    expect(s.capture("btc", "t2")).toEqual({ ok: false, reason: "not_in_active_pack", assetId: "btc" });
  });

  it("advancing through all packs completes the session", () => {
    const s = createSession(packs);
    s.advance();
    s.advance();
    s.advance();
    expect(s.isComplete()).toBe(true);
    expect(s.activePack()).toBeNull();
    expect(s.nextPack()).toBeNull();
    expect(s.progress()).toBeNull();
    expect(s.completedPackIds()).toEqual(["crypto", "stocks", "indices"]);
  });

  it("advancing past the end throws", () => {
    const s = createSession([{ id: "only", display: "Only", assets: ["btc"] }]);
    s.advance();
    expect(() => s.advance()).toThrow(/already complete/);
  });
});

describe("full lifecycle integration", () => {
  it("capture -> partial publish plan -> advance, repeated to completion", () => {
    const s = createSession(packs);

    // crypto: capture 2 of 3, plan partial, advance
    s.capture("btc", "t1");
    s.capture("eth", "t2");
    let plan = s.publishPack();
    expect(plan.isPartial).toBe(true);
    expect(plan.toPublish).toHaveLength(2);
    s.advance();

    // stocks: capture all, plan full, advance
    expect(s.activePack()?.id).toBe("stocks");
    s.capture("aapl", "t3");
    s.capture("nvda", "t4");
    plan = s.publishPack();
    expect(plan.isPartial).toBe(false);
    s.advance();

    // indices: capture, plan, advance -> complete
    expect(s.activePack()?.id).toBe("indices");
    s.capture("spx", "t5");
    s.publishPack();
    s.advance();

    expect(s.isComplete()).toBe(true);
    expect(s.completedPackIds()).toEqual(["crypto", "stocks", "indices"]);
  });
});

describe("read-only predicates", () => {
  it("isAssetInActivePack reflects active pack membership", () => {
    const s = createSession(packs);
    expect(s.isAssetInActivePack("btc")).toBe(true); // in active crypto pack
    expect(s.isAssetInActivePack("aapl")).toBe(false); // in stocks, not active
    expect(s.isAssetInActivePack("nope")).toBe(false); // unknown id
  });

  it("isAssetInActivePack is false once the session is complete", () => {
    const s = createSession([{ id: "only", display: "Only", assets: ["btc"] }]);
    s.advance();
    expect(s.isAssetInActivePack("btc")).toBe(false);
  });

  it("hasCaptured reflects captures in the active pack and resets on advance", () => {
    const s = createSession(packs);
    expect(s.hasCaptured("btc")).toBe(false);
    s.capture("btc", "t1");
    expect(s.hasCaptured("btc")).toBe(true);
    s.advance(); // captures cleared for the new pack
    expect(s.hasCaptured("btc")).toBe(false);
  });
});
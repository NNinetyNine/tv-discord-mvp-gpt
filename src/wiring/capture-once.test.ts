import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pack } from "../packs/packs.ts";
import type { CaptureResult, ValidationResult } from "../types.ts";
import type { PackSession } from "../packs/session.ts";
import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import { createSession } from "../packs/session.ts";
import { createPersistentSession } from "../packs/persistence.ts";
import { createStagingStore, type StagingStore } from "./staging.ts";
import { captureOnce, type CaptureOnceDeps } from "./capture-once.ts";

// ---- fixtures (independent of config/*.json) -------------------------------

const channels = { crypto: "", stocks: "", indices: "" };
const registryData = {
  btc:  { tradingView: "BTCUSD", display: "Bitcoin",  channel: "crypto" },
  eth:  { tradingView: "ETHUSD", display: "Ethereum", channel: "crypto" },
  aapl: { tradingView: "AAPL",   display: "Apple",    channel: "stocks" },
};
const resolver = createResolver(buildRegistry(registryData, channels));

const packs: Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", assets: ["aapl"] },
];

// Inline validator stand-ins (no exported abstraction needed).
const passValidator = (): ValidationResult => ({ ok: true, checks: { notBlank: true } });
const failValidator = (): ValidationResult => ({ ok: false, checks: { notBlank: false }, reason: "blank image" });

function fakeCapturer(opts: {
  filename: string;
  imagePath: string;
  capturedAt?: string;
  fail?: boolean;
}): CaptureOnceDeps["capturer"] {
  return {
    async capture(): Promise<CaptureResult> {
      if (opts.fail) throw new Error("capture boom");
      return {
        imagePath: opts.imagePath,
        capturedAt: opts.capturedAt ?? "2026-06-25T01:00:00.000Z",
        suggestedFilename: opts.filename,
      };
    },
  };
}

// ---- shared temp state ------------------------------------------------------

let stagingBase: string;
let srcDir: string;
let imagePath: string; // a real source PNG that exists on disk
let staging: StagingStore;

beforeEach(() => {
  stagingBase = mkdtempSync(join(tmpdir(), "visionx-orch-staging-"));
  srcDir = mkdtempSync(join(tmpdir(), "visionx-orch-src-"));
  imagePath = join(srcDir, "snap.png");
  writeFileSync(imagePath, "PNGDATA", "utf8");
  staging = createStagingStore(stagingBase);
});
afterEach(() => {
  rmSync(stagingBase, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

function deps(
  capturer: CaptureOnceDeps["capturer"],
  validate: CaptureOnceDeps["validate"],
  session: PackSession,
): CaptureOnceDeps {
  return { capturer, resolver, session, staging, validate };
}

/** Snapshot of all observable Session + Staging state, for invariant checks. */
function snap(session: PackSession, packIds: string[]) {
  return {
    completed: [...session.completedPackIds()],
    captured: session.capturedAssets().map((c) => c.assetId),
    staging: Object.fromEntries(packIds.map((p) => [p, staging.list(p).map((s) => s.assetId)])),
  };
}

// ---- accept path ------------------------------------------------------------

describe("captureOnce — accept path", () => {
  it("stages a valid in-pack capture and records it in the session", async () => {
    const session = createSession(packs);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), passValidator, session),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome).toBe("staged");
      expect(r.asset.id).toBe("btc");
      expect(r.packId).toBe("crypto");
      expect(r.replaced).toBe(false);
      expect(existsSync(r.stagedPath)).toBe(true);
    }
    expect(session.capturedAssets().map((c) => c.assetId)).toEqual(["btc"]);
    expect(staging.has("crypto", "btc")).toBe(true);
  });

  it("reports replaced=true on recapture (newest wins) without duplicating", async () => {
    const session = createSession(packs);
    await captureOnce(deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), passValidator, session));
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_02-00-00.png", imagePath }), passValidator, session),
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replaced).toBe(true);
    expect(session.capturedAssets().map((c) => c.assetId)).toEqual(["btc"]); // still one
    expect(staging.list("crypto").map((s) => s.assetId)).toEqual(["btc"]);
  });

  it("auto-persists through the persistent session wrapper", async () => {
    const sessionPath = join(srcDir, "session.json");
    const session = createPersistentSession({ packs, path: sessionPath });
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath, capturedAt: "T-CAP" }), passValidator, session),
    );

    expect(r.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(sessionPath, "utf8"));
    expect(onDisk.captured.map((c: { assetId: string }) => c.assetId)).toEqual(["btc"]);
    expect(onDisk.captured[0].capturedAt).toBe("T-CAP");
  });
});

// ---- operational rejections (result shape) ----------------------------------

describe("captureOnce — operational outcomes (result shape)", () => {
  it("capture_failed when the capturer throws", async () => {
    const session = createSession(packs);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath, fail: true }), passValidator, session),
    );
    expect(r).toMatchObject({ ok: false, outcome: "capture_failed" });
  });

  it("unparseable_filename for an empty filename", async () => {
    const session = createSession(packs);
    const r = await captureOnce(deps(fakeCapturer({ filename: "", imagePath }), passValidator, session));
    expect(r).toMatchObject({ ok: false, outcome: "unparseable_filename" });
  });

  it("unknown_symbol carries the symbol", async () => {
    const session = createSession(packs);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "DOGEUSD_2026-06-25_01-30-00.png", imagePath }), passValidator, session),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "unknown_symbol") expect(r.symbol).toBe("DOGEUSD");
    else throw new Error("expected unknown_symbol");
  });

  it("not_in_active_pack carries the asset and active pack id", async () => {
    const session = createSession(packs); // active = crypto
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "AAPL_2026-06-25_01-21-06.png", imagePath }), passValidator, session),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "not_in_active_pack") {
      expect(r.asset.id).toBe("aapl");
      expect(r.activePackId).toBe("crypto");
    } else throw new Error("expected not_in_active_pack");
  });

  it("no_active_pack when the session is complete", async () => {
    const session = createSession([{ id: "only", display: "Only", assets: ["btc"] }]);
    session.advance(); // complete
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), passValidator, session),
    );
    expect(r).toMatchObject({ ok: false, outcome: "no_active_pack" });
  });

  it("validation_failed carries the asset, reason, and checks", async () => {
    const session = createSession(packs);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), failValidator, session),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "validation_failed") {
      expect(r.asset.id).toBe("btc");
      expect(r.reason).toMatch(/blank/);
      expect(r.checks).toEqual({ notBlank: false });
    } else throw new Error("expected validation_failed");
  });

  it("staging_failed when the source image is missing", async () => {
    const session = createSession(packs);
    const missing = join(srcDir, "does-not-exist.png");
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath: missing }), passValidator, session),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === "staging_failed") expect(r.asset.id).toBe("btc");
    else throw new Error("expected staging_failed");
  });
});

// ---- invariants: every non-success leaves Session AND Staging unchanged ------

describe("captureOnce — invariants (no side effects on non-success)", () => {
  const checkPacks = ["crypto", "stocks"];

  it("capture_failed leaves session and staging unchanged", async () => {
    const session = createSession(packs);
    const before = snap(session, checkPacks);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath, fail: true }), passValidator, session),
    );
    expect(r.ok).toBe(false);
    expect(snap(session, checkPacks)).toEqual(before);
  });

  it("unparseable_filename leaves session and staging unchanged", async () => {
    const session = createSession(packs);
    const before = snap(session, checkPacks);
    const r = await captureOnce(deps(fakeCapturer({ filename: "", imagePath }), passValidator, session));
    expect(r.ok).toBe(false);
    expect(snap(session, checkPacks)).toEqual(before);
  });

  it("unknown_symbol leaves session and staging unchanged", async () => {
    const session = createSession(packs);
    const before = snap(session, checkPacks);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "DOGEUSD_2026-06-25_01-30-00.png", imagePath }), passValidator, session),
    );
    expect(r.ok).toBe(false);
    expect(snap(session, checkPacks)).toEqual(before);
  });

  it("not_in_active_pack leaves session and staging unchanged", async () => {
    const session = createSession(packs);
    const before = snap(session, checkPacks);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "AAPL_2026-06-25_01-21-06.png", imagePath }), passValidator, session),
    );
    expect(r.ok).toBe(false);
    expect(snap(session, checkPacks)).toEqual(before);
  });

  it("validation_failed leaves session and staging unchanged (nothing staged)", async () => {
    const session = createSession(packs);
    const before = snap(session, checkPacks);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), failValidator, session),
    );
    expect(r.ok).toBe(false);
    expect(snap(session, checkPacks)).toEqual(before);
    expect(staging.has("crypto", "btc")).toBe(false);
  });

  it("staging_failed leaves session unchanged (session.capture never reached)", async () => {
    const session = createSession(packs);
    const before = snap(session, checkPacks);
    const missing = join(srcDir, "does-not-exist.png");
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath: missing }), passValidator, session),
    );
    expect(r.ok).toBe(false);
    expect(snap(session, checkPacks)).toEqual(before);
    expect(staging.has("crypto", "btc")).toBe(false);
  });

  it("no_active_pack (complete session) leaves session and staging unchanged", async () => {
    const session = createSession([{ id: "only", display: "Only", assets: ["btc"] }]);
    session.advance(); // complete
    const before = snap(session, ["only"]);
    const r = await captureOnce(
      deps(fakeCapturer({ filename: "BTCUSD_2026-06-25_01-18-55.png", imagePath }), passValidator, session),
    );
    expect(r.ok).toBe(false);
    expect(snap(session, ["only"])).toEqual(before);
  });
});
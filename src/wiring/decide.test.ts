import { describe, it, expect } from "vitest";

import type { Pack } from "../packs/packs.ts";
import { buildRegistry } from "../registry/registry.ts";
import { createResolver } from "../resolver/index.ts";
import { createSession } from "../packs/session.ts";
import { decide } from "./decide.ts";

// Injected fixtures — independent of config/*.json.
const channels = { crypto: "", stocks: "", indices: "" };
const registryData = {
  btc:  { tradingView: "BTCUSD", display: "Bitcoin",  channel: "crypto" },
  eth:  { tradingView: "ETHUSD", display: "Ethereum", channel: "crypto" },
  aapl: { tradingView: "AAPL",   display: "Apple",    channel: "stocks" },
  spx:  { tradingView: "SPX",    display: "S&P 500",  channel: "indices" },
};
const resolver = createResolver(buildRegistry(registryData, channels));

const packs: Pack[] = [
  { id: "crypto", display: "Crypto", assets: ["btc", "eth"] },
  { id: "stocks", display: "Stocks", assets: ["aapl"] },
];

// Helper: resolve a filename then decide (the new resolve -> decide flow).
function decideFilename(filename: string, session: ReturnType<typeof createSession>) {
  return decide(resolver.resolve(filename), session);
}

describe("decide — accept", () => {
  it("accepts a snapshot whose asset is in the active pack", () => {
    const session = createSession(packs);
    const d = decideFilename("BTCUSD_2026-06-25_01-18-55.png", session);
    expect(d.accepted).toBe(true);
    if (d.accepted) {
      expect(d.asset.id).toBe("btc");
      expect(d.activePackId).toBe("crypto");
      expect(d.replacesExisting).toBe(false);
    }
  });

  it("reports replacesExisting when the asset is already captured", () => {
    const session = createSession(packs);
    session.capture("btc", "t1");
    const d = decideFilename("BTCUSD_2026-06-25_02-00-00.png", session);
    expect(d.accepted).toBe(true);
    if (d.accepted) expect(d.replacesExisting).toBe(true);
  });

  it("does not mutate the session (verdict only)", () => {
    const session = createSession(packs);
    decideFilename("BTCUSD_2026-06-25_01-18-55.png", session);
    expect(session.progress()?.captured).toBe(0); // decide did not capture
  });
});

describe("decide — reject", () => {
  it("rejects an unparseable filename", () => {
    const session = createSession(packs);
    const d = decideFilename("", session);
    expect(d.accepted).toBe(false);
    if (!d.accepted) expect(d.reason.kind).toBe("unparseable_filename");
  });

  it("rejects an unknown symbol, carrying the symbol", () => {
    const session = createSession(packs);
    const d = decideFilename("DOGEUSD_2026-06-25_01-30-00.png", session);
    expect(d.accepted).toBe(false);
    if (!d.accepted && d.reason.kind === "unknown_symbol") {
      expect(d.reason.symbol).toBe("DOGEUSD");
    } else {
      throw new Error("expected unknown_symbol");
    }
  });

  it("rejects an asset resolved but not in the active pack", () => {
    const session = createSession(packs);
    const d = decideFilename("AAPL_2026-06-25_01-21-06.png", session);
    expect(d.accepted).toBe(false);
    if (!d.accepted && d.reason.kind === "not_in_active_pack") {
      expect(d.reason.asset.id).toBe("aapl");
      expect(d.reason.activePackId).toBe("crypto");
    } else {
      throw new Error("expected not_in_active_pack");
    }
  });

  it("rejects when the session is complete (no active pack)", () => {
    const session = createSession([{ id: "only", display: "Only", assets: ["btc"] }]);
    session.advance();
    const d = decideFilename("BTCUSD_2026-06-25_01-18-55.png", session);
    expect(d.accepted).toBe(false);
    if (!d.accepted) expect(d.reason.kind).toBe("no_active_pack");
  });
});

describe("decide — determinism", () => {
  it("returns the same verdict for the same inputs", () => {
    const session = createSession(packs);
    const a = decideFilename("BTCUSD_2026-06-25_01-18-55.png", session);
    const b = decideFilename("BTCUSD_2026-06-25_01-18-55.png", session);
    expect(a).toEqual(b);
  });

  it("an asset becomes acceptable only after the session advances to its pack", () => {
    const session = createSession(packs);
    expect(decideFilename("AAPL_2026-06-25_01-21-06.png", session).accepted).toBe(false);
    session.advance();
    expect(decideFilename("AAPL_2026-06-25_01-21-06.png", session).accepted).toBe(true);
  });
});
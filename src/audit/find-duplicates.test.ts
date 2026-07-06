import { describe, it, expect } from "vitest";

import {
  findDuplicates,
  type ResolvedEntry,
  type UnknownEntry,
} from "./find-duplicates.ts";

function resolved(file: string, id: string, display: string): ResolvedEntry {
  return { file, identity: { id, display } };
}
function unknown(file: string, symbol: string): UnknownEntry {
  return { file, symbol };
}

describe("findDuplicates — resolved files group by asset id", () => {
  it("groups two files resolving to the same asset, labeled 'id (Display)'", () => {
    const groups = findDuplicates(
      [resolved("MSFT_a.png", "msft", "Microsoft"), resolved("MSFT_b.png", "msft", "Microsoft")],
      [],
    );
    expect(groups).toEqual([
      { kind: "resolved", label: "msft (Microsoft)", files: ["MSFT_a.png", "MSFT_b.png"] },
    ]);
  });

  it("does NOT group a single resolved file", () => {
    const groups = findDuplicates([resolved("MSFT_a.png", "msft", "Microsoft")], []);
    expect(groups).toEqual([]);
  });

  it("groups by asset id even when the two files had different filenames/symbols", () => {
    // Two different TradingView symbols that resolve to the same asset (e.g. a
    // canonical export and an alias export) still collide on identity.
    const groups = findDuplicates(
      [resolved("BTC_a.png", "btc", "Bitcoin"), resolved("BTCUSD_b.png", "btc", "Bitcoin")],
      [],
    );
    expect(groups).toEqual([
      { kind: "resolved", label: "btc (Bitcoin)", files: ["BTC_a.png", "BTCUSD_b.png"] },
    ]);
  });
});

describe("findDuplicates — unknown-symbol files group by symbol", () => {
  it("groups two unknown files with the same symbol, labeled with the SYMBOL", () => {
    const groups = findDuplicates([], [unknown("BRKB_a.png", "BRKB"), unknown("BRKB_b.png", "BRKB")]);
    expect(groups).toEqual([
      { kind: "unknown", label: "BRKB", files: ["BRKB_a.png", "BRKB_b.png"] },
    ]);
  });

  it("groups unknown symbols case-insensitively", () => {
    const groups = findDuplicates([], [unknown("a.png", "BRKB"), unknown("b.png", "brkb")]);
    expect(groups).toEqual([
      { kind: "unknown", label: "BRKB", files: ["a.png", "b.png"] },
    ]);
  });

  it("does NOT group distinct unknown symbols", () => {
    const groups = findDuplicates([], [unknown("a.png", "BRKB"), unknown("b.png", "HG1")]);
    expect(groups).toEqual([]);
  });
});

describe("findDuplicates — resolved and unknown namespaces do not cross", () => {
  it("a resolved asset id and an unknown symbol with the same text are separate keys", () => {
    // Even if an unknown symbol's text coincided with a resolved asset id, they
    // are keyed in different namespaces (id: vs sym:) and never merge.
    const groups = findDuplicates(
      [resolved("x1.png", "btc", "Bitcoin")],
      [unknown("x2.png", "btc")],
    );
    // Neither has 2+ members on its own -> no duplicate groups.
    expect(groups).toEqual([]);
  });
});

describe("findDuplicates — ordering policy (localeCompare, base sensitivity)", () => {
  it("sorts groups by label and files within each group, case-insensitively", () => {
    const groups = findDuplicates(
      [
        resolved("z.png", "msft", "Microsoft"),
        resolved("a.png", "msft", "Microsoft"),
        resolved("m.png", "aapl", "Apple"),
        resolved("b.png", "aapl", "Apple"),
      ],
      [unknown("q.png", "ZZZ"), unknown("p.png", "ZZZ")],
    );
    // Group order: "aapl (Apple)" < "msft (Microsoft)" < "ZZZ" under base
    // sensitivity (case-insensitive), NOT raw code-unit order where "ZZZ" leads.
    expect(groups).toEqual([
      { kind: "resolved", label: "aapl (Apple)", files: ["b.png", "m.png"] },
      { kind: "resolved", label: "msft (Microsoft)", files: ["a.png", "z.png"] },
      { kind: "unknown", label: "ZZZ", files: ["p.png", "q.png"] },
    ]);
  });

  it("returns an empty array when there are no duplicates at all", () => {
    const groups = findDuplicates(
      [resolved("a.png", "btc", "Bitcoin")],
      [unknown("b.png", "HG1")],
    );
    expect(groups).toEqual([]);
  });
});
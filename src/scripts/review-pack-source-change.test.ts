import { describe, expect, it } from "vitest";

import { main, parseReviewPackSourceChangeArguments } from "./review-pack-source-change.ts";

const valid = ["node", "script", "--repository-root", "/repo", "--workspace-root", "/workspace", "--promotion-request", "/request", "--proposal", "/proposal", "--planning-authorization", "/planning", "--plan", "/plan", "--patch", "/patch", "--source-change", "/change", "--decision", "/decision", "--output", "/output"];

describe("review-pack-source-change CLI", () => {
  it("requires every explicit named path", () => expect(parseReviewPackSourceChangeArguments(valid)).toMatchObject({ ok: true }));
  it.each([
    [[...valid, "positional"], "invalid_arguments"],
    [[...valid.slice(0, -2), "--unknown", "x"], "invalid_arguments"],
    [[...valid, "--output", "again"], "invalid_arguments"],
    [["node", "script"], "invalid_arguments"],
  ] as const)("rejects invalid arguments", (argv, reason) => expect(parseReviewPackSourceChangeArguments(argv)).toMatchObject({ ok: false, reason }));
  it("prints exactly one structured success result", async () => {
    const out: string[] = []; const err: string[] = [];
    const code = await main(valid, (value) => out.push(value), (value) => err.push(value), async () => ({ ok: true, outputBasename: "review.json", receiptSha256: "a".repeat(64), receipt: {} as never }));
    expect(code).toBe(0); expect(out).toHaveLength(1); expect(err).toHaveLength(0); expect(JSON.parse(out[0] ?? "{}")).toMatchObject({ ok: true });
  });
});

import { describe, expect, it } from "vitest";

import { main, parseApplyPackSourceChangeArguments } from "./apply-pack-source-change.ts";

const valid = ["node", "script", "--repository-root", "/repo", "--workspace-root", "/workspace", "--promotion-request", "/request", "--proposal", "/proposal", "--planning-authorization", "/planning", "--plan", "/plan", "--patch", "/patch", "--source-change", "/change", "--review-decision", "/review-decision", "--review", "/review", "--application-authorization", "/authorization", "--receipt-output", "/receipt"];

describe("apply-pack-source-change CLI", () => {
  it("requires every explicit named path", () => expect(parseApplyPackSourceChangeArguments(valid)).toMatchObject({ ok: true }));
  it.each([
    [[...valid, "positional"], "invalid_arguments"],
    [[...valid.slice(0, -2), "--unknown", "x"], "invalid_arguments"],
    [[...valid, "--receipt-output", "again"], "invalid_arguments"],
    [["node", "script"], "invalid_arguments"],
  ] as const)("rejects invalid arguments", (argv, reason) => expect(parseApplyPackSourceChangeArguments(argv)).toMatchObject({ ok: false, reason }));
  it("prints exactly one structured success result", async () => {
    const out: string[] = []; const err: string[] = [];
    const code = await main(valid, (value) => out.push(value), (value) => err.push(value), async () => ({ ok: true, outputBasename: "application.json", receiptSha256: "a".repeat(64), receiptBytes: 1, receipt: {} as never }));
    expect(code).toBe(0); expect(out).toHaveLength(1); expect(err).toHaveLength(0); expect(JSON.parse(out[0] ?? "{}")).toMatchObject({ ok: true });
  });
});

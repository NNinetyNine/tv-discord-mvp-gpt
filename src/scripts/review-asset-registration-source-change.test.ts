import { describe, expect, test, vi } from "vitest";

import {
  REVIEW_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE,
  main,
  parseReviewAssetRegistrationSourceChangeArguments,
} from "./review-asset-registration-source-change.ts";

describe("review-asset-registration-source-change CLI", () => {
  test("requires all explicit flags", () => {
    const parsed = parseReviewAssetRegistrationSourceChangeArguments([
      "node", "script",
      "--proposal", "proposal.json",
      "--planning-authorization", "auth.json",
      "--plan", "plan.json",
      "--patch", "change.patch",
      "--source-change-receipt", "change.json",
      "--decision", "decision.json",
      "--output", "review.json",
    ]);
    expect(parsed).toMatchObject({ ok: true, options: { outputPath: "review.json" } });
  });

  test.each([
    [["node", "script", "positional"], "positional"],
    [["node", "script", "--unknown", "x"], "unknown flag"],
    [["node", "script", "--proposal", "a", "--proposal", "b"], "duplicate flag"],
    [["node", "script", "--proposal"], "missing value"],
    [["node", "script"], "missing required"],
  ] as const)("rejects invalid arguments", (argv, detail) => {
    const result = parseReviewAssetRegistrationSourceChangeArguments(argv);
    expect(result).toMatchObject({ ok: false, reason: "invalid_arguments" });
    if (!result.ok) expect(result.detail).toContain(detail);
  });

  test("main emits one structured success result", async () => {
    const stdout: string[] = []; const stderr: string[] = [];
    const run = vi.fn(async () => Object.freeze({ ok: true as const, outputBasename: "review.json", receiptSha256: "0".repeat(64), receipt: Object.freeze({ reviewStatus: "approved" }) as never }));
    const args = ["node", "script", "--proposal", "p", "--planning-authorization", "a", "--plan", "l", "--patch", "x", "--source-change-receipt", "s", "--decision", "d", "--output", "o"];
    expect(await main(args, (text) => stdout.push(text), (text) => stderr.push(text), run)).toBe(0);
    expect(stdout).toHaveLength(1); expect(stderr).toEqual([]); expect(run).toHaveBeenCalledOnce();
  });

  test("argument errors include usage", async () => {
    const stderr: string[] = [];
    expect(await main(["node", "script"], () => undefined, (text) => stderr.push(text))).toBe(2);
    expect(stderr.at(-1)).toBe(REVIEW_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE);
  });
});

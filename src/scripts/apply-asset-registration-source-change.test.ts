import { describe, expect, test, vi } from "vitest";

import {
  APPLY_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE,
  main,
  parseApplyAssetRegistrationSourceChangeArguments,
} from "./apply-asset-registration-source-change.ts";

describe("apply-asset-registration-source-change CLI", () => {
  const valid = [
    "node", "script",
    "--proposal", "proposal.json",
    "--planning-authorization", "planning.json",
    "--plan", "plan.json",
    "--patch", "change.patch",
    "--source-change-receipt", "change.json",
    "--review", "review.json",
    "--application-authorization", "apply-auth.json",
    "--repository-root", "repo",
    "--application-receipt-output", "application.json",
  ];

  test("requires explicit repository root and every artifact path", () => {
    expect(parseApplyAssetRegistrationSourceChangeArguments(valid)).toMatchObject({ ok: true, options: { repositoryRoot: "repo" } });
  });

  test.each([
    [["node", "script", "positional"], "positional"],
    [["node", "script", "--unknown", "x"], "unknown flag"],
    [["node", "script", "--proposal", "a", "--proposal", "b"], "duplicate flag"],
    [["node", "script", "--proposal"], "missing value"],
    [["node", "script"], "missing required"],
  ] as const)("rejects invalid arguments", (argv, detail) => {
    const result = parseApplyAssetRegistrationSourceChangeArguments(argv);
    expect(result).toMatchObject({ ok: false, reason: "invalid_arguments" });
    if (!result.ok) expect(result.detail).toContain(detail);
  });

  test("main emits one structured success result", async () => {
    const stdout: string[] = []; const stderr: string[] = [];
    const run = vi.fn(async () => Object.freeze({ ok: true as const, outputBasename: "application.json", receiptSha256: "0".repeat(64), receipt: Object.freeze({ applicationStatus: "applied" }) as never }));
    expect(await main(valid, (text) => stdout.push(text), (text) => stderr.push(text), run)).toBe(0);
    expect(stdout).toHaveLength(1); expect(stderr).toEqual([]); expect(run).toHaveBeenCalledOnce();
  });

  test("argument errors include usage", async () => {
    const stderr: string[] = [];
    expect(await main(["node", "script"], () => undefined, (text) => stderr.push(text))).toBe(2);
    expect(stderr.at(-1)).toBe(APPLY_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE);
  });
});

import { describe, expect, it } from "vitest";
import { main, parsePlanPackSourceChangeArguments } from "./plan-pack-source-change.ts";

describe("plan-pack-source-change CLI", () => {
  const args = ["node", "script", "--repository-root", "/repo", "--workspace-root", "/workspace", "--request", "/request.json", "--proposal", "/proposal.json", "--authorization", "/auth.json", "--output", "/plan.json"];
  it("requires every explicit path", () => expect(parsePlanPackSourceChangeArguments(args)).toMatchObject({ ok: true }));
  const invalidCases: readonly (readonly string[])[] = [[...args, "positional"], [...args, "--bogus", "x"], args.slice(0, -2)];
  invalidCases.forEach((argv, index) => it(`rejects malformed arguments ${index + 1}`, () => expect(parsePlanPackSourceChangeArguments(argv)).toMatchObject({ ok: false, reason: "invalid_arguments" })));
  it("prints one structured failure", async () => { const errors: string[] = []; const code = await main(args, () => undefined, (text) => errors.push(text), async () => ({ ok: false, reason: "planning_authorization_rejected", detail: "rejected" })); expect(code).toBe(1); expect(errors).toHaveLength(1); expect(JSON.parse(errors[0] ?? "").reason).toBe("planning_authorization_rejected"); });
});

import { describe, expect, it } from "vitest";
import { main, parseGeneratePackSourceChangeArguments } from "./generate-pack-source-change.ts";

describe("generate-pack-source-change CLI", () => {
  const args = ["node", "script", "--repository-root", "/repo", "--workspace-root", "/workspace", "--request", "/request.json", "--proposal", "/proposal.json", "--authorization", "/auth.json", "--plan", "/plan.json", "--patch-output", "/out.patch", "--receipt-output", "/out.json"];
  it("requires all explicit inputs and outputs", () => expect(parseGeneratePackSourceChangeArguments(args)).toMatchObject({ ok: true }));
  it("accepts an optional future Packs review artifact", () => expect(parseGeneratePackSourceChangeArguments([...args, "--packs-after-output", "/packs-after.json"])).toMatchObject({ ok: true, options: { packsAfterOutputPath: "/packs-after.json" } }));
  const invalidCases: readonly (readonly string[])[] = [[...args, "position"], [...args, "--unknown", "x"], [...args, "--plan", "/again"]];
  invalidCases.forEach((argv, index) => it(`rejects positional, unknown, and duplicate arguments ${index + 1}`, () => expect(parseGeneratePackSourceChangeArguments(argv)).toMatchObject({ ok: false, reason: "invalid_arguments" })));
  it("prints one structured success result", async () => { const out: string[] = []; const code = await main(args, (text) => out.push(text), () => undefined, async () => ({ ok: true, value: { patch: Buffer.from("patch\n"), receipt: {} as never, receiptBytes: Buffer.from("{}\n"), packsAfter: Buffer.from("[]") } })); expect(code).toBe(0); expect(out).toHaveLength(1); expect(JSON.parse(out[0] ?? "").ok).toBe(true); });
});

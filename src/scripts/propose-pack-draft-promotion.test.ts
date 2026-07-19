import { describe, expect, it } from "vitest";
import { main, parseProposePackDraftPromotionArguments } from "./propose-pack-draft-promotion.ts";

describe("propose-pack-draft-promotion CLI", () => {
  const args = ["node", "script", "--repository-root", "/repo", "--workspace-root", "/workspace", "--request", "/request.json", "--output", "/proposal.json"];
  it("requires explicit named paths", () => expect(parseProposePackDraftPromotionArguments(args)).toMatchObject({ ok: true, options: { repositoryRoot: "/repo", workspaceRoot: "/workspace" } }));
  const invalidCases: readonly (readonly string[])[] = [[...args, "extra"], [...args, "--unknown", "x"], [...args, "--output", "again"]];
  invalidCases.forEach((argv, index) => it(`rejects positional, unknown, or duplicate arguments ${index + 1}`, () => expect(parseProposePackDraftPromotionArguments(argv)).toMatchObject({ ok: false, reason: "invalid_arguments" })));
  it("prints one structured success result", async () => {
    const out: string[] = []; const code = await main(args, (text) => out.push(text), () => undefined, async () => ({ ok: true, value: { proposal: {} as never, bytes: Buffer.from("{}\n"), sha256: "a".repeat(64) } }));
    expect(code).toBe(0); expect(out).toHaveLength(1); expect(JSON.parse(out[0] ?? "").ok).toBe(true);
  });
});

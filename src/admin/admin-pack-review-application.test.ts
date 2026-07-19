import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { validatePackSourceApplicationAuthorization } from "../packs/pack-source-application-authorization.ts";
import { validatePackSourceChangeReviewDecision } from "../packs/pack-source-change-review.ts";
import { makePackSourceReviewApplicationFixture } from "../packs/pack-source-review-application.test-fixture.ts";


describe("Administration Pack review/application UI boundary", () => {
  it("contains separate review, authorization, and explicit Apply sections", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    expect(html).toContain("Review prepared Pack source change");
    expect(html).toContain("Review approval does not authorize application.");
    expect(html).toContain("Authorize Pack source application");
    expect(html).toContain("Authorization does not apply it automatically.");
    expect(html).toContain("Apply authorized Pack source change");
    expect(html).toContain("APPLY PACK SOURCE CHANGE");
    expect(html).toContain("This operation modifies definitions/packs.json.");
    expect(html).not.toMatch(/<button[^>]*>[^<]*(?:release|publish)[^<]*<\/button>/iu);
  });

  it("keeps Apply disabled until approved review, authorization, and exact confirmation", async () => {
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).toContain('exactConfirmation = qs("#pack-application-confirmation").value === "APPLY PACK SOURCE CHANGE"');
    expect(js).toContain("reviewApproved && state.authorizationApproved");
    expect(js).toContain('body: JSON.stringify({ confirmation })');
  });

  it("uses strict server-side decision and authorization validators", () => {
    const f = makePackSourceReviewApplicationFixture();
    expect(validatePackSourceChangeReviewDecision(f.reviewDecision)).toMatchObject({ ok: true });
    expect(validatePackSourceApplicationAuthorization(f.applicationAuthorization)).toMatchObject({ ok: true });
  });
});

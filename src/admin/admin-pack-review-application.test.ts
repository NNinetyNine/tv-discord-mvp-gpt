import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { validatePackSourceApplicationAuthorization } from "../packs/pack-source-application-authorization.ts";
import { validatePackSourceChangeReviewDecision } from "../packs/pack-source-change-review.ts";
import { makePackSourceReviewApplicationFixture } from "../packs/pack-source-review-application.test-fixture.ts";

describe("Administration Pack review/application UI boundary", () => {
  it("uses Create Pack as the primary operator workflow and hides legacy custody stages", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");

    expect(html).toContain("PACK BUILDER");
    expect(html).toContain("CREATE PACK");
    expect(html).toContain("TECHNICAL DETAILS");
    expect(html).toContain("Nothing will be rendered, published, released, or sent to Discord.");

    expect(html).not.toContain("Review prepared Pack source change");
    expect(html).not.toContain("Authorize Pack source application");
    expect(html).not.toContain("Apply authorized Pack source change");
    expect(html).not.toContain("APPLY PACK SOURCE CHANGE");
    expect(html).not.toMatch(/<button[^>]*>[^<]*(?:release|publish)[^<]*<\/button>/iu);
  });

  it("creates from a validated preview without a confirmation phrase or browser-supplied custody authority", async () => {
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(js).toContain('api("/api/v1/packs/create/preview"');
    expect(js).toContain('api("/api/v1/packs/create"');
    expect(js).toContain("packId: state.preview.pack.id");
    expect(js).toContain("previewId: state.preview.previewId");

    expect(js).not.toContain("APPLY PACK SOURCE CHANGE");
    expect(js).not.toContain("pack-application-confirmation");
    expect(js).not.toContain("reviewApproved && state.authorizationApproved");
    expect(js).not.toContain("JSON.stringify({ confirmation })");
  });

  it("retains strict server-side legacy decision and authorization validators", () => {
    const f = makePackSourceReviewApplicationFixture();

    expect(validatePackSourceChangeReviewDecision(f.reviewDecision)).toMatchObject({
      ok: true,
    });
    expect(
      validatePackSourceApplicationAuthorization(f.applicationAuthorization),
    ).toMatchObject({ ok: true });
  });
});

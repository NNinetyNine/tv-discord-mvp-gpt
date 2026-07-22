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

  it("keeps standalone rendering visibly outside Pack publication authority", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("STANDALONE RENDERER");
    expect(html).toContain("This does not change a Pack, stage a publication, create a Release, or contact Discord.");
    expect(js).toContain('api(`/api/v1/standalone-renders?${query.toString()}`');
    expect(js).not.toContain("publishPack(");
    expect(js).not.toContain("capturePackChartFromFile(");
  });

  it("requires explicit Pack preview acceptance while keeping publication unavailable", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("PACK WORKSPACE");
    expect(html).toContain("CURRENT ANALYSES &amp; REMAINING REQUIRED");
    expect(html).toContain("PUBLISH UNAVAILABLE");
    expect(html).toContain("ACCEPT REVISION");
    expect(js).toContain('api(`/api/v1/pack-workspace/previews?${query.toString()}`');
    expect(js).toContain('api(`/api/v1/pack-workspace/previews/${encodeURIComponent(preview.previewId)}/accept`');
    expect(js).toContain('method: "DELETE"');
    expect(html).not.toMatch(/<button[^>]*>[^<]*(?:release|publish)[^<]*<\/button>/iu);
    expect(js).not.toContain("/publish");
    expect(js).not.toContain("publishPack(");
  });

  it("keeps confirmed reset controls inside current Workspace custody", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("RESET PACK");
    expect(js).toContain("window.confirm(");
    expect(js).toContain('confirmation: "reset_asset"');
    expect(js).toContain('confirmation: "reset_pack"');
    expect(js).toContain("expectedRevisions: asset.revisions");
    expect(js).toContain("expectedCapturedAssetIds: capturedAssetIds");
    expect(js).toContain("The Archive is not affected.");
    expect(js).not.toContain("/api/v1/pack-workspace/reset");
    expect(js).not.toContain("/api/v1/releases");
    expect(js).not.toContain("/publish");
  });

  it("limits the Threads room to confirmed adoption of existing posts", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("DISCORD THREAD ROUTING");
    expect(html).toContain("ADOPTION ONLY");
    expect(html).toContain("INSPECT &amp; ADOPT");
    expect(html).toContain("PROVISIONING UNAVAILABLE");
    expect(html).toContain("NO CONTENT EDIT · NO PUBLICATION");
    expect(js).toContain('api("/api/v1/thread-management")');
    expect(js).toContain('api("/api/v1/thread-management/adopt"');
    expect(js).toContain('confirmation: "adopt_existing_thread"');
    expect(js).toContain("window.confirm(");
    expect(js).not.toContain("/api/v1/thread-management/provision");
    expect(js).not.toContain("/api/v1/thread-management/publish");
  });
});

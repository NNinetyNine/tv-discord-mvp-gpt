import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { validatePackSourceApplicationAuthorization } from "../packs/pack-source-application-authorization.ts";
import { validatePackSourceChangeReviewDecision } from "../packs/pack-source-change-review.ts";
import { makePackSourceReviewApplicationFixture } from "../packs/pack-source-review-application.test-fixture.ts";

describe("Administration Pack review/application UI boundary", () => {
  it("uses Create Pack as the primary operator workflow and hides legacy custody stages", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const packsView = html.match(/<section[^>]*data-view-panel="packs"[^>]*>([\s\S]*?)<section[^>]*data-view-panel="renderer"[^>]*>/u)?.[1] ?? "";

    expect(packsView).toContain("PACK BUILDER");
    expect(packsView).toContain("CREATE PACK");
    expect(packsView).toContain("TECHNICAL DETAILS");
    expect(packsView).toContain("Nothing will be rendered, published, released, or sent to Discord.");

    expect(packsView).not.toContain("Review prepared Pack source change");
    expect(packsView).not.toContain("Authorize Pack source application");
    expect(packsView).not.toContain("Apply authorized Pack source change");
    expect(packsView).not.toContain("APPLY PACK SOURCE CHANGE");
    expect(packsView).not.toMatch(/<button[^>]*>[^<]*(?:release|publish)[^<]*<\/button>/iu);
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
    expect(js).toContain('watermark: state.renderWatermarkEnabled ? "enabled" : "disabled"');
    expect(js).toContain('"-NO-WATERMARK"');
    expect(js).not.toContain("publishPack(");
    expect(js).not.toContain("capturePackChartFromFile(");
  });

  it("stages capture revisions automatically while publication remains separately governed", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("PACK WORKSPACE");
    expect(html).toContain("CURRENT ANALYSES &amp; REMAINING REQUIRED");
    expect(html).toContain("PUBLICATION QUEUE");
    expect(html).toContain("Capture-session review remains optional.");
    expect(html).toContain("REVIEW PUBLICATION");
    expect(html).toContain("PUBLISH SELECTED PACKS");
    expect(html).not.toContain('id="workspace-streamlined-confirmation"');
    expect(js).not.toContain("streamlinedRevisionConfirmation");
    expect(js).toContain("stageCaptureCandidates");
    expect(js).toContain("verified and staged automatically");
    expect(js).toContain('api(`/api/v1/pack-workspace/previews?${query.toString()}`');
    expect(js).toContain('api(`/api/v1/pack-workspace/previews/${encodeURIComponent(preview.previewId)}/accept`');
    expect(js).toContain('api("/api/v1/pack-workspace/publication/preview"');
    expect(js).toContain('api(`/api/v1/pack-workspace/publication/${encodeURIComponent(preview.previewId)}`');
    expect(js).toContain('method: "DELETE"');
    expect(js).not.toContain("publishPack(");
  });

  it("makes configurable folder synchronization primary while preserving collapsible manual import", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("AUTOMATED PACK CAPTURE");
    expect(html).toContain("SYNC DOWNLOADS &amp; UPDATE PACK");
    expect(html).toContain('id="workspace-configure-downloads"');
    expect(html).toContain('id="workspace-downloads-input"');
    expect(html).toMatch(/id="workspace-start-session"[\s\S]*id="workspace-scan-session"[\s\S]*id="workspace-manual-fallback"/u);
    expect(html).toContain('id="workspace-import"');
    expect(html).not.toContain('<details class="workspace-import">');
    expect(js).toContain("setManualFallbackOpen");
    expect(html).toContain("IMPORT &amp; REVIEW ONE PNG");
    expect(js).toContain('api("/api/v1/pack-workspace/capture-session/downloads-folder"');
    expect(js).toContain('method: "PUT"');
    expect(js).toContain('api("/api/v1/pack-workspace/capture-session/start"');
    expect(js).toContain('api("/api/v1/pack-workspace/capture-session/scan"');
    expect(js).toContain("No newer or changed chart exports were found, so no revisions were created.");
    expect(js).toContain("stageCaptureCandidates");
    expect(js).not.toContain("/publish");
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

    const resetControls = js.slice(
      js.indexOf("async function resetWorkspaceAsset"),
      js.indexOf("function serverRouteValues"),
    );
    expect(resetControls).not.toContain("/api/v1/releases");
    expect(resetControls).not.toContain("/publish");
  });

  it("opens Pack Progress previews directly in navigable Quick Look with one-revision deletion", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("ASSET &amp; PREVIEW");
    expect(html).toContain("REVISION HISTORY");
    expect(html).toContain("Choose PREVIEW beside an Asset to open Quick Look immediately.");
    expect(html).toContain("Delete removes exactly one Workspace revision");
    expect(html).toContain('id="workspace-quick-look"');
    expect(html).toContain('id="workspace-quick-look-previous-asset"');
    expect(html).toContain('id="workspace-quick-look-next-asset"');
    expect(html).toContain('id="workspace-quick-look-action"');
    expect(js).toContain("data-workspace-quick-look");
    expect(js).toContain("revision-count-pill");
    expect(js).toContain("moveWorkspaceQuickLookAsset");
    expect(js).toContain("moveWorkspaceQuickLookRevision");
    expect(js).toContain("applyWorkspaceQuickLookAction");
    expect(js).not.toContain("data-toggle-workspace-history");
    expect(js).not.toContain(" KEPT");
    expect(js).toContain('confirmation: "delete_revision"');
    expect(js).toContain("expectedCurrentRevision: asset.revisions");
    expect(js).toContain("Only this revision will be removed.");

    const revisionDeletion = js.slice(
      js.indexOf("async function deleteWorkspaceRevision"),
      js.indexOf("function renderPackWorkspace"),
    );
    expect(revisionDeletion).not.toContain("/api/v1/releases");
    expect(revisionDeletion).not.toContain("/publish");
  });

  it("governs existing-post adoption and explicitly confirmed new-post provisioning", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("DISCORD THREAD ROUTING");
    expect(html).toContain("BINDING MANAGEMENT");
    expect(html).toContain("INSPECT &amp; ADOPT");
    expect(html).toContain("REMOVE BINDING");
    expect(html).toContain("CREATE NEW FORUM POST");
    expect(html).toContain("TAGS OPTIONAL · UP TO 20 CONFIGURED · APPLY UP TO 5");
    expect(html).toContain('id="thread-existing-post"');
    expect(html).toContain("EXPLICIT CONFIRMATION REQUIRED");
    expect(html).toContain("NO DISCORD CONTENT CHANGE");
    expect(js).toContain('api("/api/v1/thread-management")');
    expect(js).toContain('"/api/v1/thread-management/adopt"');
    expect(js).toContain('confirmation: "adopt_existing_thread"');
    expect(js).toContain('"/api/v1/thread-management/binding/inspect"');
    expect(js).toContain('"/api/v1/thread-management/binding/replace"');
    expect(js).toContain('confirmation: "remove_thread_binding"');
    expect(js).toContain("/api/v1/thread-management/provision");
    expect(js).toContain('confirmation: "inspect_forum_tags"');
    expect(js).toContain('confirmation: "provision_new_thread"');
    expect(js).toContain("logo.evidence.sha256");
    expect(js).toContain("result.forum.requiresTag");
    expect(js).toContain('destination.scrollIntoView({ behavior: "smooth", block: "start" })');
    expect(js).toContain("window.confirm(");
    expect(js).not.toContain("/api/v1/thread-management/publish");
  });

  it("exposes a confirmed read-only Pack routing gate without publication authority", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");

    expect(html).toContain("PACK ROUTING READINESS");
    expect(html).toContain("VERIFY PACK ROUTING");
    expect(html).toContain("READ-ONLY DISCORD INSPECTION · PUBLICATION REMAINS DISABLED");
    expect(js).toContain("/api/v1/thread-management/packs/${encodeURIComponent(pack.id)}/verify");
    expect(js).toContain('confirmation: "verify_pack_routing"');
    expect(js).toContain("pack.verificationEligible !== true");
    expect(js).toContain("state.threadVerification = null");
    expect(js).not.toContain("/api/v1/thread-management/publish");
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Operational Registry UI", () => {
  it("uses the canonical q search contract with bounded pagination and stale-response protection", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    for (const id of ["registry-search", "registry-previous", "registry-next", "registry-page-state", "registry-refresh"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(js).toContain("parameters.set(\"pack\", state.registryPackId)");
    expect(js).toContain("/api/v1/assets?${parameters.toString()}");
    expect(js).not.toContain("/api/v1/assets?query=");
    expect(js).toContain("registrySearchGeneration");
    expect(js).toContain("generation !== state.registrySearchGeneration");
  });

  it("offers Pack pills that combine with text search and governed CSV review before application", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    for (const id of [
      "registry-pack-filters", "registry-import-csv", "registry-import-dialog", "registry-import-file",
      "registry-review-import", "registry-apply-import", "registry-import-issues", "registry-download-template",
    ]) expect(html).toContain(`id="${id}"`);
    expect(js).toContain("renderRegistryPackFilters");
    expect(js).toContain("state.registryPackId");
    expect(js).toContain("/api/v1/registry/csv-import/preview?filename=");
    expect(js).toContain('"Content-Type": "text/csv"');
    expect(js).toContain('confirmation: "APPLY REGISTRY CSV IMPORT"');
    expect(html).toContain("Current architecture permits at most one Pack membership per Asset");
  });

  it("revalidates exact Asset IDs and exposes the most important canonical metadata", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(html).toContain("DISPLAY NAME</th><th>TRADINGVIEW</th><th>CURRENCY</th><th>CHANNEL</th>");
    expect(html).toContain('id="registry-asset-facts"');
    expect(js).toContain("VERIFYING CURRENT ID");
    expect(js).toContain("/api/v1/assets/${encodeURIComponent(assetId)}");
    expect(js).toContain("registrySelectionGeneration");
    expect(js).toContain("<dt>INTERNAL ID</dt>");
    expect(html).toContain("Pack memberships, revisions, archive filenames, logos, and thread routes reference it");
  });

  it("provides governed add, edit, logo, and retirement controls", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    for (const id of [
      "registry-add-asset", "registry-edit-asset", "registry-logo-input", "registry-remove-logo",
      "registry-retire-asset", "registry-editor", "registry-review-change", "registry-apply-change",
      "registry-field-display", "registry-field-tradingview", "registry-field-currency", "registry-field-channel", "registry-field-id",
    ]) expect(html).toContain(`id="${id}"`);
    expect(js).toContain('/api/v1/registry/asset-changes/preview');
    expect(js).toContain('confirmation: "APPLY REGISTRY ASSET CHANGE"');
    expect(js).toContain('confirmation: "STORE REGISTRY ASSET LOGO"');
    expect(js).toContain('confirmation: "REMOVE REGISTRY ASSET LOGO"');
    expect(js).toContain("retirement-preview");
    expect(js).toContain("blockingPackIds");
    expect(js).toContain("blockingThreadRoutes");
  });

  it("routes current Registry Assets into Pack, Render, and Thread workspaces without automatic downstream action", async () => {
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).toContain('activateView("packs")');
    expect(js).toContain('activateView("renderer")');
    expect(js).toContain('activateView("threads")');
    expect(js).toContain("addMember({ id: asset.id })");
    expect(js).toContain("selectRendererAsset(renderAsset)");
    expect(js).toContain('qs("#thread-asset").value = asset.id');
  });

  it("reuses canonical Registry logos for thread provisioning and explains tag limits", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(html).not.toContain('id="thread-logo"');
    expect(html).toContain('id="thread-logo-state"');
    expect(html).toContain("UP TO 20 AVAILABLE TAGS · APPLY UP TO 5");
    expect(html).toContain("Manage or replace the logo in Registry");
    expect(js).toContain("/provisioning-logo/canonical");
    expect(js).toContain("ADD CANONICAL LOGO IN REGISTRY");
    expect(js).toContain("this canonical Registry logo as its starter message");
  });

  it("keeps the Registry editor above an explicit recoverable backdrop with keyboard and pointer escape paths", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const css = await readFile(resolve("src/admin-ui/styles.css"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(html).toContain('id="pack-asset-search"');
    expect(html).toContain('id="renderer-asset-search"');
    expect(html).toContain('id="registry-editor-backdrop"');
    expect(html).toContain('id="registry-editor-cancel"');
    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html.indexOf("</main>")).toBeLessThan(html.indexOf('id="registry-editor-backdrop"'));
    expect(html.indexOf('id="registry-editor-backdrop"')).toBeLessThan(html.indexOf('id="registry-editor"'));
    expect(css).toContain(".registry-editor {");
    expect(css).toContain(".registry-editor-backdrop {");
    expect(css).not.toContain("body.registry-editor-open::after");
    expect(js).toContain('event.key === "Escape"');
    expect(js).toContain("registryEditorFocusableElements");
    expect(js).toContain('qs("#registry-editor-backdrop").addEventListener("click", closeRegistryEditor)');
    expect(js).toContain("registryEditorReturnFocus");
  });

  it("keeps all Registry categories discoverable in Render and explains metadata blockers", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(html).toContain('id="renderer-open-registry"');
    expect(js).toContain("result.renderableAssetCount");
    expect(js).toContain("result.reconciliationRequiredCount");
    expect(js).toContain("asset.logicalChannel");
    expect(js).toContain("asset.reconciliationIssues.map(rendererIssueLabel)");
    expect(js).toContain('NO REGISTRY ASSETS MATCH.');
    expect(js).not.toContain('NO RENDERABLE REGISTRY ASSETS MATCH.');
    expect(js).toContain('activateView("registry")');
  });
});

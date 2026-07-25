import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Step 551 Pack workflow and proprietary controls", () => {
  it("keeps publication eligibility scoped to the deliberately selected subset", async () => {
    const [html, js, serviceTest] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
      readFile(resolve("src/admin/admin-pack-publication.test.ts"), "utf8"),
    ]);
    expect(html).toContain("Only the selected Packs are evaluated; unselected Packs never affect publication eligibility.");
    expect(js).toContain("const selectedPacks = workspace.packs.filter");
    expect(js).toContain("Unselected Packs are not evaluated and cannot block publication.");
    expect(js).toContain("ONE OR MORE SELECTED PACKS ARE INCOMPLETE");
    expect(js).not.toContain("publicationBlockerExplanation");
    expect(serviceTest).toContain("publishes only that subset in canonical order");
    expect(serviceTest).toContain("unselectedPacksChanged: false");
  });

  it("restores Manual Fallback before the two primary capture controls", async () => {
    const [html, css] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
    ]);
    expect(html).toMatch(/class="workspace-session-actions"[\s\S]*workspace-manual-fallback[\s\S]*workspace-start-session[\s\S]*workspace-scan-session[\s\S]*<\/div>[\s\S]*id="workspace-import"/u);
    expect(html).toContain('class="manual-fallback-control"');
    expect(html).not.toContain('id="workspace-manual-fallback" class="outline-action"');
    expect(css).toMatch(/\.manual-fallback-control\s*\{[\s\S]*border-radius:\s*\.65rem;[\s\S]*background:\s*var\(--window-subtle\);/u);
    expect(css).toMatch(/\.manual-fallback-control\[aria-expanded="true"\][\s\S]*background:\s*var\(--window-subtle\);/u);
  });

  it("progressively enhances every select with one viewport-aware VisionX component", async () => {
    const [html, css, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html.match(/<select\b/gu)?.length).toBeGreaterThan(8);
    expect(js).toContain("function enhanceVisionxSelect(select)");
    expect(js).toContain('qsa("select").forEach(enhanceVisionxSelect)');
    expect(js).toContain('menu.setAttribute("role", "listbox")');
    expect(js).toContain("positionVisionxSelectMenu");
    expect(js).toContain('select.dispatchEvent(new Event("change", { bubbles: true }))');
    expect(css).toContain(".visionx-select-button");
    expect(css).toContain(".visionx-select-menu");
    expect(css).toContain(".visionx-select-option.selected");
  });

  it("makes Current Pack standalone and keeps Pack order visibly editable", async () => {
    const [html, css, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).toContain('class="pack-maintenance-pack-selector"');
    expect(html).toContain('id="pack-maintenance-order-preview"');
    expect(js).toContain("const visiblePacks = orderedPacks.length === data.packs.length ? orderedPacks : data.packs");
    expect(js).toContain('class="pack-order-position${current ? " current" : ""}"');
    expect(js).toContain("state.packMaintenanceOrder.splice(target, 0, id)");
    expect(css).toContain(".pack-order-position.current");
  });

  it("populates Logical Channel and preserves it during membership-only changes", async () => {
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).toContain("data.logicalChannels");
    expect(js).toContain("state.packMaintenanceLogicalChannel = canonicalChannel");
    expect(js).toContain("logicalChannel: state.packMaintenanceLogicalChannel || pack.logicalChannel");
    expect(js).toContain("state.packMaintenanceAssetIds.push(assetId)");
    expect(js).toContain("removeMaintenanceMember");
  });

  it("anchors Renderer search to its field and stretches Registry results with Manage", async () => {
    const [css, js] = await Promise.all([
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(css).toMatch(/\.renderer-asset-search \.asset-search-results\s*\{[\s\S]*position:\s*absolute;/u);
    expect(js).toContain('const container = input.closest(".renderer-asset-search")');
    expect(js).toContain("rect.bottom - containerRect.top + gap");
    expect(css).toMatch(/\.registry-results\s*\{[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/u);
    expect(css).toMatch(/\.table-wrap\.registry-table-wrap\s*\{[\s\S]*height:\s*100%;[\s\S]*max-height:\s*none;/u);
  });

  it("places Packs before Server in workflow navigation", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    expect(html.indexOf('id="nav-packs"')).toBeLessThan(html.indexOf('id="nav-server"'));
  });
});

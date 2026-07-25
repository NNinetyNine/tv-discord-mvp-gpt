import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Step 550 UI and workflow adjustments", () => {
  it("uses one non-interactive light blur treatment for Registry and preview backdrops", async () => {
    const [html, css] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
    ]);
    for (const id of ["registry-editor-backdrop", "registry-import-backdrop", "workspace-quick-look-backdrop"]) {
      expect(html).toContain(`id="${id}" class="registry-editor-backdrop"`);
    }
    expect(css).toContain(".registry-editor-backdrop:hover:not(:disabled)");
    expect(css).toContain("backdrop-filter: blur(12px) saturate(102%)");
    expect(css).toContain("background: rgba(24, 25, 21, .16)");
    const step550 = css.slice(css.indexOf("/* Step 550"));
    expect(step550).not.toMatch(/registry-editor-backdrop[^}]*gold/iu);
  });

  it("keeps notifications fixed below the header and above modal backdrops", async () => {
    const css = await readFile(resolve("src/admin-ui/styles.css"), "utf8");
    const step550 = css.slice(css.indexOf("/* Step 550"));
    expect(step550).toMatch(/\.message\s*\{[\s\S]*position:\s*fixed;[\s\S]*z-index:\s*40;[\s\S]*top:\s*10rem;/u);
    expect(step550).toContain("max-height: calc(100dvh - 11rem)");
    expect(step550).toMatch(/@media \(max-width: 900px\)[\s\S]*\.message \{ top: 8\.65rem;/u);
  });

  it("offers a VisionX switch for the standalone V watermark and preserves Pack publication authority", async () => {
    const [html, css, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).toContain('id="renderer-watermark"');
    expect(html).toContain('class="visionx-switch"');
    expect(html).toContain("Watermark-free output remains standalone and cannot enter governed Pack publication.");
    expect(css).toContain(".visionx-switch-input:checked + .visionx-switch");
    expect(js).toContain('watermark: state.renderWatermarkEnabled ? "enabled" : "disabled"');
    expect(js).toContain('V WATERMARK ${result.watermarkEnabled ? "ON" : "OFF"}');
  });

  it("renders every publication blocker with an exact destination and action", async () => {
    const [html, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).toContain('id="publication-diagnostics"');
    for (const code of [
      "pack_incomplete",
      "missing_staged_images",
      "channel_unresolved",
      "asset_threads_unresolved",
      "interrupted_release_exists",
      "published_release_cleanup_required",
      "discord_unavailable",
    ]) expect(js).toContain(`case "${code}"`);
    for (const destination of ["workspace", "server", "threads", "archive", "registry"]) {
      expect(js).toContain(`view: "${destination}"`);
    }
    expect(js).toContain("LIVE DISCORD PREFLIGHT");
    expect(js).toContain("Test Current Server");
    expect(js).toContain("Verify Pack Routing");
  });

  it("keeps renderer search results above surrounding panels and repositions them within the viewport", async () => {
    const [css, js] = await Promise.all([
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(css).toMatch(/\.renderer-asset-search \.asset-search-results\s*\{[\s\S]*position:\s*fixed;[\s\S]*z-index:\s*60;/u);
    expect(js).toContain("function positionRendererAssetResults()");
    expect(js).toContain("availableBelow < 180 && availableAbove > availableBelow");
    expect(js).toContain('panel.dataset.placement = useAbove ? "above" : "below"');
    expect(js).toContain('window.addEventListener("scroll"');
  });

  it("uses fixed file controls, keeps Manual Fallback on the primary row, and aligns Pack maintenance facts", async () => {
    const [html, css, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html.match(/class="file-picker-button"/gu)?.length).toBe(4);
    expect(html.match(/class="file-picker-name"/gu)?.length).toBe(4);
    expect(css).toContain("grid-template-columns: 9rem minmax(0, 1fr)");
    expect(css).toContain("text-overflow: ellipsis");
    expect(html).toMatch(/class="workspace-session-actions"[\s\S]*id="workspace-start-session"[\s\S]*id="workspace-scan-session"[\s\S]*id="workspace-manual-fallback"[\s\S]*<\/div>[\s\S]*id="workspace-import"/u);
    expect(js).toContain("setManualFallbackOpen");
    expect(html).toMatch(/class="pack-maintenance-fields"[\s\S]*CURRENT PACK[\s\S]*DISPLAY NAME[\s\S]*LOGICAL CHANNEL[\s\S]*WORKSPACE[\s\S]*THREAD BINDINGS[\s\S]*RELEASES/u);
    expect(css).toContain("grid-template-columns: repeat(6, minmax(9.5rem, 1fr))");
  });

  it("removes typed Server confirmation while retaining validated review and standard confirmation", async () => {
    const [html, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    const serverView = html.match(/<section[^>]*data-view-panel="server"[^>]*>([\s\S]*?)<section[^>]*data-view-panel="packs"[^>]*>/u)?.[1] ?? "";
    expect(serverView).not.toContain('id="server-confirmation"');
    expect(serverView).not.toContain("TYPE EXACT CONFIRMATION");
    expect(serverView).toContain("APPLY SERVER CONFIGURATION");
    expect(js).toContain("preview === null || !preview.valid || state.serverBusy");
    expect(js).toContain("window.confirm(`Apply the reviewed server configuration?");
    expect(js).toContain("confirmation: preview.confirmation");
  });
});

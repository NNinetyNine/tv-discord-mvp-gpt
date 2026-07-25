import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Step 551 website-review corrections", () => {
  it("publishes one or many selected Packs without a typed phrase", async () => {
    const [html, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).not.toContain("TYPE EXACT CONFIRMATION");
    expect(html).not.toContain('id="publication-confirmation"');
    expect(html).toContain('id="publication-apply-guidance"');
    expect(js).toContain('return packCount === 1 ? "PUBLISH PACK" : "PUBLISH SELECTED PACKS"');
    expect(js).toContain("window.confirm(confirmationMessage)");
    expect(js).toContain("body: JSON.stringify({ confirmation: preview.confirmation })");
    expect(js).not.toContain("TO ENABLE THE ONE PUBLICATION ACTION");
  });

  it("removes user-typed exact confirmation from every remaining website workflow", async () => {
    const [html, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).not.toContain("TYPE EXACT CONFIRMATION");
    expect(html).not.toContain('id="pack-maintenance-confirmation"');
    expect(js).not.toContain("window.prompt(");
    expect(js).toContain("Retire ${asset.displayName} from the canonical Registry?");
    expect(js).toContain("Apply the reviewed changes to Pack ${preview.packDisplayName.toUpperCase()}?");
    expect(js).toContain("confirmation: phrase");
  });

  it("restores the non-pill Manual Fallback control in the primary action row", async () => {
    const [html, css] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
    ]);
    expect(html).toMatch(/workspace-session-actions[\s\S]*manual-fallback-control[\s\S]*workspace-start-session[\s\S]*workspace-scan-session/u);
    expect(html).toContain('<span class="manual-fallback-state" aria-hidden="true"></span>');
    expect(css).toMatch(/\.manual-fallback-control\s*\{[^}]*border-radius:\s*\.65rem;/u);
    expect(css).not.toMatch(/#workspace-manual-fallback\[aria-expanded="true"\][^}]*linear-gradient/u);
    expect(css).toContain('.manual-fallback-control[aria-expanded="true"] .manual-fallback-state::before { content: "COLLAPSE"; }');
  });

  it("limits Registry pagination to twenty assets", async () => {
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).toContain("registryLimit: 20");
    expect(js).toContain("offset: state.registryOffset + state.registryLimit");
  });
});

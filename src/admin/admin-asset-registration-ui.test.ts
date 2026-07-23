import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Registry-owned Pack-builder UI", () => {
  it("provides one Pack builder and one operational Registry front door", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    expect(html).toContain("PACK BUILDER");
    expect(html).toContain("CREATE PACK");
    expect(html).toContain('data-view="packs"');
    expect(html).toContain('data-view="registry"');
    expect(html).not.toContain('data-view="asset-registrations"');
    expect(html).not.toContain('data-view="pack-drafts"');
    expect(html).toContain("Registry owns the stable Asset ID");
    expect(html).toContain("ADD ASSET");
    expect(html).toContain("EDIT METADATA");
  });

  it("limits Pack membership entry to searchable current Registry Assets", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    for (const id of ["pack-id", "pack-display", "pack-channel", "member-list", "pack-asset-search", "pack-asset-results", "create-pack"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("REGISTRY ASSETS ONLY");
    expect(html).toContain("Discord Channel IDs remain owned by channel configuration");
    expect(js).toContain("/api/v1/assets?q=${encodeURIComponent(query)}&offset=0&limit=12");
    expect(js).toContain("Select a current Registry Asset.");
    expect(js).not.toContain("TRADINGVIEW TOKEN");
    expect(js).not.toContain("ASSET LOGO · PNG · REQUIRED");
    expect(html).not.toContain('id="add-member"');
  });

  it("stores only stable Asset IDs in the Pack draft", async () => {
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).toContain("members: state.members.map((member) => ({ id: member.id }))");
    expect(js).toContain('/api/v1/packs/create/preview');
    expect(js).toContain("localStorage.setItem");
    expect(js).toContain("localStorage.getItem");
    expect(js).toContain("addMember({ id: button.dataset.addPackAsset })");
  });

  it("keeps technical evidence collapsed and downstream non-effects explicit", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    expect(html).toContain('<details id="technical-details"');
    expect(html).not.toContain('<details id="technical-details" open');
    expect(html).toContain("Nothing will be rendered, published, released, or sent to Discord.");
  });

  it("preserves one coherent layered visual language and a motion-safe sliding panel", async () => {
    const css = await readFile(resolve("src/admin-ui/styles.css"), "utf8");
    const radialGradients = css.match(/radial-gradient\(/gu) ?? [];
    expect(radialGradients.length).toBeGreaterThanOrEqual(2);
    expect(radialGradients.length).toBeLessThanOrEqual(12);
    expect(css).toContain(".ambient-layer");
    expect(css).toContain("backdrop-filter: blur(");
    expect(css).toContain(".registry-editor");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
  });
});

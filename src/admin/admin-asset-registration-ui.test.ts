import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Constitutional Pack-builder UI", () => {
  it("provides one Create Pack front door while keeping Registry read-only", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    expect(html).toContain("PACK BUILDER");
    expect(html).toContain("CREATE PACK");
    expect(html).toContain('data-view="packs"');
    expect(html).toContain('data-view="registry"');
    expect(html).not.toContain('data-view="asset-registrations"');
    expect(html).not.toContain('data-view="pack-drafts"');
    expect(html).toContain("Registry source is canonical and read-only in this interface.");
    const registry = html.slice(html.indexOf('data-view-panel="registry"'));
    expect(registry).not.toContain("contenteditable");
    expect(registry).not.toMatch(/<textarea/iu);
  });

  it("shows only operator-owned Pack and inline missing-Asset fields", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    for (const id of ["pack-id", "pack-display", "pack-channel", "member-list", "add-member", "create-pack"]) {
      expect(html).toContain(`id="${id}"`);
    }
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).toContain("<span>CURRENCY</span>");
    expect(js).toContain("TRADINGVIEW TOKEN");
    expect(js).toContain("MARKET ");
    expect(js).toContain("SYMBOL ");
    expect(js).toContain("ASSET CHANNEL ");
    expect(js).toContain("localStorage.setItem");
    expect(js).toContain("localStorage.getItem");
    expect(js).not.toContain("publication currency");
  });

  it("removes ordinary custody ceremony and keeps technical evidence read-only and collapsed", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    for (const text of [
      "Prepare Asset registration proposal", "Planning authorization", "Independent review",
      "Application authorization", "APPLY ASSET SOURCE CHANGE", "APPLY PACK SOURCE CHANGE",
      "Reviewer ID", "Reference ID", "Decision timestamp",
    ]) expect(html).not.toContain(text);
    expect(html).toContain('<details id="technical-details"');
    expect(html).not.toContain('<details id="technical-details" open');
    const technical = html.slice(html.indexOf('<details id="technical-details"'), html.indexOf("</details>", html.indexOf('<details id="technical-details"')));
    expect(technical).not.toContain("<button");
    expect(html).toContain("Nothing will be rendered, published, released, or sent to Discord.");
  });

  it("supports keyboard ordering, inline validation, and one dominant Create action", async () => {
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).toContain('aria-label="Move');
    expect(js).toContain('aria-label="Remove');
    expect(js).toContain("field-error");
    expect(js).toContain("document.activeElement");
    expect(js).toContain("restored.setSelectionRange");
    expect(js).toContain('qs("#create-pack").disabled = true');
    expect(js).toContain('qs("#create-pack").disabled = false');
    expect(js).toContain('/api/v1/packs/create/preview');
    expect(js).toContain('/api/v1/packs/create');
    expect(js).not.toContain("asset-registration/proposal");
  });

  it("translates the first-party VisionX visual language without card-level competing gradients", async () => {
    const css = await readFile(resolve("src/admin-ui/styles.css"), "utf8");
    expect(css.match(/radial-gradient\(/gu)).toHaveLength(1);
    expect(css).toContain(".ambient-layer");
    expect(css).toContain("--window: rgba(");
    expect(css).toContain("backdrop-filter: blur(");
    expect(css).toContain("@supports not (backdrop-filter");
    expect(css).toContain("border: 1px solid var(--border)");
    expect(css).toContain(".primary-action");
    expect(css).toContain("var(--gold-strong)");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(css).not.toMatch(/h1[^}]*color:\s*var\(--gold/iu);
  });
});

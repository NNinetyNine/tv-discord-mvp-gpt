import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("VisionX Administration design language", () => {
  it("uses local shell metadata and preserves the existing application entry points", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");

    expect(html).toContain('<meta name="theme-color" content="#070806">');
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html).toContain('<body class="visionx-shell">');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html).not.toMatch(/https?:\/\//u);
  });

  it("defines the layered VisionX system, readable controls, and narrow-screen reflow", async () => {
    const css = await readFile(resolve("src/admin-ui/styles.css"), "utf8");

    expect(css).toContain("/* Step 542 — VisionX full design language */");
    expect(css).toContain("--font-condensed:");
    expect(css).toContain("body.visionx-shell");
    expect(css).toContain("html {\n  min-width: 0;");
    expect(css).toContain("backdrop-filter: blur(22px) saturate(118%);");
    expect(css).toContain("min-height: 2.75rem;");
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain(".registry-layout { grid-template-columns: 1fr; }");
    expect(css).toContain("table { min-width: 46rem; }");
    expect(css).not.toMatch(/@import\s|url\(["']?https?:/u);
  });

  it("uses a lighter warm-charcoal label on gold primary actions without reducing contrast", async () => {
    const css = await readFile(resolve("src/admin-ui/styles.css"), "utf8");

    expect(css.match(/--primary-action-ink: #28251f;/gu)).toHaveLength(2);
    expect(css.match(/color: var\(--primary-action-ink\);/gu)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
    expect(css).toMatch(
      /#workspace-manual-fallback\[aria-expanded="true"\]\s*\{[^}]*color: var\(--primary-action-ink\);/u,
    );
    expect(css).toContain("linear-gradient(135deg, #f3d573 0%, #d7aa3b 54%, #b98220 100%)");

    const luminance = (hex: string): number => {
      const channels = hex.match(/[0-9a-f]{2}/giu)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
      const linear = channels.map((channel) => channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4);
      return (0.2126 * linear[0]!) + (0.7152 * linear[1]!) + (0.0722 * linear[2]!);
    };
    const contrast = (foreground: string, background: string): number => {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    };

    const goldStops = ["f3d573", "d7aa3b", "b98220", "ffe58c", "e3b94d", "c58f27"];
    expect(Math.min(...goldStops.map((stop) => contrast("28251f", stop)))).toBeGreaterThanOrEqual(4.5);
  });

  it("gates decorative motion and explicitly neutralizes it for reduced-motion users", async () => {
    const css = await readFile(resolve("src/admin-ui/styles.css"), "utf8");

    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(css).toContain("@keyframes visionx-panel-in");
    expect(css).toContain("@keyframes visionx-shimmer");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-duration: .001ms !important;");
    expect(css).toContain("transition-duration: .001ms !important;");
  });
});

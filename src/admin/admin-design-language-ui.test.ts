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

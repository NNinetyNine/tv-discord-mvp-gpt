import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readUi = async (name: "index.html" | "app.js" | "styles.css") =>
  readFile(resolve("src/admin-ui", name), "utf8");

describe("VisionX Administration UX and accessibility shell", () => {
  it("provides URL-restorable, keyboard-operable workspace navigation", async () => {
    const [html, js] = await Promise.all([readUi("index.html"), readUi("app.js")]);

    for (const view of ["workspace", "threads", "server", "packs", "archive", "renderer", "registry"]) {
      expect(html).toContain(`id="nav-${view}"`);
      expect(html).toContain(`aria-controls="view-${view}"`);
      expect(html).toContain(`id="view-${view}"`);
      expect(html).toContain(`data-view-panel="${view}"`);
    }
    expect(js).toContain("function requestedViewFromHash()");
    expect(js).toContain('window.addEventListener("hashchange"');
    expect(js).toContain('window.history.pushState({ view: nextView }, "", nextHash)');
    expect(js).toContain('["ArrowLeft", "ArrowRight", "Home", "End"]');
    expect(js).toContain('item.tabIndex = current ? 0 : -1;');
    expect(js).toContain('panel.setAttribute("aria-busy", String(busy));');
    expect(js).toContain("Restricted browser storage must not block the governed in-memory workflow.");
  });

  it("separates assertive errors from polite success and isolates Registry dialogs", async () => {
    const [html, js] = await Promise.all([readUi("index.html"), readUi("app.js")]);

    expect(html).toContain('id="message-text"');
    expect(html).toContain('id="message-dismiss"');
    expect(html).toContain('id="view-status"');
    expect(js).toContain('box.setAttribute("role", error ? "alert" : "status")');
    expect(js).toContain('if (error && !modalOpen) requestAnimationFrame(() => box.focus())');
    expect(js).toContain('qs("#message-dismiss").addEventListener("click", clearMessage)');
    expect(js).toContain("function setModalIsolation(active)");
    expect(js).toContain("element.inert = active;");
    expect(js).toContain('qs("#registry-editor").setAttribute("aria-busy", "true")');
    expect(js).toContain('qs("#registry-import-dialog").setAttribute("aria-busy", "true")');
  });

  it("makes every wide operational table a named keyboard-scrollable region", async () => {
    const html = await readUi("index.html");

    expect(html.match(/<caption class="visually-hidden">/gu)).toHaveLength(6);
    expect(html.match(/<th scope="col">/gu)?.length).toBeGreaterThan(30);
    expect(html.match(/class="table-wrap[^"]*" role="region" aria-labelledby="[^"]+" tabindex="0"/gu)).toHaveLength(6);
  });

  it("preserves capability across motion, contrast, forced-colors, touch, and narrow layouts", async () => {
    const css = await readUi("styles.css");

    expect(css).toContain("/* Step 543 — operator UX, responsive behavior, and accessibility */");
    expect(css).toContain('.view[aria-busy="true"]::before');
    expect(css).toContain('.table-wrap[role="region"]:focus-visible');
    expect(css).toContain("@media (prefers-contrast: more)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("touch-action: manipulation;");
    expect(css).toContain(".table-wrap { width: 100%; }");
    expect(css).toContain("env(safe-area-inset-left)");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

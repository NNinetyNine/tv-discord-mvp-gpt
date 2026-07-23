import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Administration hidden operator-function UI", () => {
  it("exposes current Pack maintenance, Release archive, Registry aliases, and read-only audits", async () => {
    const [html, script] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    for (const text of [
      "MANAGE CURRENT PACKS",
      "RELEASE ARCHIVE",
      "TRADINGVIEW ALIASES",
      "STATUS &amp; AUDITS",
      "development and recovery tooling",
    ]) expect(html).toContain(text);
    for (const selector of [
      "#pack-maintenance-review",
      "#archive-pack-filter",
      "#registry-alias-review-add",
      "#operator-run-export-audit",
    ]) expect(script).toContain(selector);
    expect(html).not.toContain("TRADINGVIEW LOGIN");
    expect(html).not.toContain("POST FIXTURE");
  });
});

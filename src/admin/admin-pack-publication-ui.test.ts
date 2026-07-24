import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Multi-Pack publication UI", () => {
  it("offers deliberate Pack selection, exact combined review, and one confirmation action", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    for (const id of [
      "publication-pack-pills",
      "publication-review",
      "publication-preview",
      "publication-preview-packs",
      "publication-confirmation",
      "publication-apply",
      "publication-result",
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('id="publication-select-ready"');
    expect(html).not.toContain('id="publication-clear"');
    expect(html).toContain("SELECT OR DESELECT EACH PACK DIRECTLY");
    expect(html).toContain("All selected Packs are revalidated immediately before the first Discord action");
    expect(js).toContain("publicationSelectedPackIds");
    expect(js).toContain("publicationSupersedePackIds");
    expect(js).toContain("/api/v1/pack-workspace/publication/preview");
    expect(js).toContain("preview.confirmation");
    expect(html).toContain("PUBLISH SELECTED PACKS");
  });

  it("surfaces blockers, interrupted Release policies, partial completion, and cleanup warnings", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).not.toContain('case "capture_session_not_ready"');
    expect(html).toContain("Capture-session review remains optional.");
    expect(js).toContain('case "interrupted_release_exists"');
    expect(js).toContain('case "published_release_cleanup_required"');
    expect(js).toContain("ALLOW SUPERSEDE");
    expect(js).toContain("RESUME");
    expect(js).toContain("notAttemptedPackIds");
    expect(js).toContain("cleanupWarnings");
    expect(html).toContain("a later external failure can leave earlier Packs published and the remaining Packs unattempted");
  });

  it("keeps publication disabled when Discord is unavailable without hiding local readiness evidence", async () => {
    const js = await readFile(resolve("src/admin-ui/app.js"), "utf8");
    expect(js).toContain('"DISCORD DISABLED"');
    expect(js).toContain('case "discord_unavailable"');
    expect(js).toContain("START ADMINISTRATION WITH A DISCORD BOT TOKEN TO ENABLE PUBLISHING");
    expect(js).toContain("publication.capturedCount");
    expect(js).toContain("publication.stagedCount");
    expect(js).toContain("publication.resolvedThreadCount");
  });
});

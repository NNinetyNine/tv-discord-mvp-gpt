import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Step 547 Administration workflow refinements", () => {
  it("makes staged revisions publication-ready without a review confirmation gate", async () => {
    const [html, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).not.toContain('id="workspace-streamlined-confirmation"');
    expect(html).toContain("Capture-session review remains optional.");
    expect(js).not.toContain("streamlinedCaptureSessionId");
    expect(js).toContain("stageCaptureCandidates");
    expect(js).toContain("Review is optional in Quick Look");
    expect(js).toContain("window.confirm(`Start a new");
    expect(js).toContain("Delete ${asset.id.toUpperCase()} revision");
    expect(js).toContain("Reset ${asset.id.toUpperCase()}");
    expect(js).toContain("preview.confirmation");
  });

  it("nests manual import, removes publication bulk controls, and exposes revision Quick Look", async () => {
    const [html, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).toMatch(/AUTOMATED PACK CAPTURE[\s\S]*<details class="workspace-import">[\s\S]*IMPORT &amp; REVIEW ONE PNG/u);
    expect(html).not.toContain('id="publication-select-ready"');
    expect(html).not.toContain('id="publication-clear"');
    expect(html).not.toContain('<th scope="col">CAPTURED</th>');
    expect(html).toContain('id="workspace-quick-look"');
    expect(html).toContain('id="workspace-quick-look-previous-asset"');
    expect(html).toContain('id="workspace-quick-look-action"');
    expect(js).toContain("openWorkspaceQuickLook");
    expect(js).toContain("moveWorkspaceQuickLookAsset");
    expect(js).toContain("revision-count-pill");
    expect(js).not.toContain("revision.sourceBasename");
    expect(js).not.toContain("pending.filename)} · SOURCE");
  });

  it("surfaces tag capacity, route ownership, Archive emptiness, and renderer alignment", async () => {
    const [html, css, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).toContain("Tags are optional in VisionX");
    expect(html).toContain('id="thread-tag-count"');
    expect(html).toContain('id="server-new-route-name"');
    expect(html).toContain('id="server-new-route-channel"');
    expect(html).toContain("DISCORD CHANNEL ID");
    expect(html).not.toContain("SERVER MIGRATION");
    expect(html).toContain('id="workspace-configure-downloads"');
    expect(js).toContain("routeRemovalBlocker");
    expect(html).toContain("No archived Releases are available.");
    expect(js).toContain('qs("#archive-table-wrap").hidden = empty');
    expect(html.match(/class="[^"]*renderer-control[^"]*"/gu)?.length).toBe(3);
    expect(css).toContain(".renderer-control input");
  });

  it("removes generic Pack guidance and operator-visible alias workflows", async () => {
    const [html, js] = await Promise.all([
      readFile(resolve("src/admin-ui/index.html"), "utf8"),
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
    ]);
    expect(html).not.toContain("WHAT A PACK DOES");
    expect(html).not.toContain("TRADINGVIEW ALIASES");
    expect(html).not.toContain('id="registry-alias-management"');
    expect(js).not.toContain("reviewAliasChange");
    expect(js).not.toContain("<dt>ALIASES</dt>");
    expect(html).toContain("canonical MARKET:SYMBOL identities");
  });
});

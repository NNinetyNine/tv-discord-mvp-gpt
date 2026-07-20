import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Administration Asset registration UI", () => {
  it("adds a separate primary Asset registrations workflow while Registry remains read-only", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    expect(html).toContain('data-view="asset-registrations"');
    expect(html).toContain("Asset registrations");
    expect(html).toContain("Controlled noncanonical workspace");
    expect(html).toContain("Registry source is canonical and read-only in this interface");
    const registryStart = html.indexOf('data-view-panel="registry"');
    const registryEnd = html.indexOf('data-view-panel="asset-registrations"');
    const registryView = html.slice(registryStart, registryEnd);
    expect(registryView).not.toContain("<textarea");
    expect(registryView).not.toContain("contenteditable");
    expect(registryView).not.toMatch(/(?:save|edit|register) Asset/iu);
  });

  it("renders every required schema-v2 input with explicit logical channel selection", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    for (const id of [
      "asset-registration-id", "asset-registration-display-name", "asset-registration-symbol",
      "asset-registration-market", "asset-registration-trading-view-symbol", "asset-registration-currency",
      "asset-registration-channel", "asset-registration-curator-id", "asset-registration-decided-at",
      "asset-registration-reference-id", "asset-registration-notes",
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("Select explicitly");
    expect(html).toContain("Target Pack IDs");
    expect(html).toContain("[] — Packs are not modified");
  });

  it("keeps proposal, planning, source generation, review, authorization, and Apply as separate controls", async () => {
    const html = await readFile(resolve("src/admin-ui/index.html"), "utf8");
    for (const heading of [
      "Prepare Asset registration proposal", "Authorize Asset application planning",
      "Generate Registry source patch and receipt", "Review prepared Asset source change",
      "Authorize Asset source application", "Apply authorized Asset source change",
    ]) expect(html).toContain(heading);
    expect(html).toContain("Proposal creation does not authorize planning or application.");
    expect(html).toContain("Planning authorization permits deterministic planning only.");
    expect(html).toContain("Review approval does not authorize application.");
    expect(html).toContain("Authorization does not apply it automatically.");
    expect(html).toContain("APPLY ASSET SOURCE CHANGE");
  });

  it("uses normalized saved-revision comparison for Pack dirty state and honors hidden state", async () => {
    const [js, css] = await Promise.all([
      readFile(resolve("src/admin-ui/app.js"), "utf8"),
      readFile(resolve("src/admin-ui/styles.css"), "utf8"),
    ]);
    expect(js).toContain("savedDraftSnapshot");
    expect(js).toContain("normalizeDraftForDirty(draftSnapshot()) !== state.savedDraftSnapshot");
    expect(js).toContain("state.savedDraftSnapshot = savedBytes === null ? null : normalizeDraftForDirty(draft)");
    expect(js).toContain("renderDraftAssets(); updateDraftDirtyState()");
    expect(css).toContain("[hidden]");
    expect(css).toContain("display: none !important");
  });
});

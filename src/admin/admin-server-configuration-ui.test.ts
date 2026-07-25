import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Administration server configuration UI", () => {
  it("exposes secure bot status, route testing, and governed configuration without migration controls", async () => {
    const html = await readFile(new URL("../admin-ui/index.html", import.meta.url), "utf8");
    const js = await readFile(new URL("../admin-ui/app.js", import.meta.url), "utf8");
    expect(html).toContain('data-view="server"');
    expect(html).toContain("SERVER CONFIGURATION");
    expect(html).toContain("TEST CURRENT SERVER");
    expect(html).toContain("ROUTING &amp; DESTINATIONS");
    expect(html).toContain("DISCORD CHANNEL ID");
    expect(html).not.toContain("DISCORD FORUM ID");
    expect(html).toContain('id="server-add-route"');
    expect(html).toContain('id="server-new-route-name"');
    expect(js).toContain("addServerRouteDraft");
    expect(js).toContain("routeRemovalBlocker");
    expect(html).not.toContain("SERVER MIGRATION");
    expect(html).not.toContain('id="server-review-migration"');
    expect(html).toContain("Credentials remain process-environment secrets");
    expect(html).toContain("WEBHOOKS");
    expect(js).toContain('api("/api/v1/server-configuration/test"');
    expect(js).not.toContain('"/api/v1/server-migration/preview"');
    expect(html).not.toContain('id="server-confirmation"');
    expect(html).toContain('id="server-apply-guidance"');
    expect(html).toContain("APPLY SERVER CONFIGURATION");
    expect(js).toContain("if (!window.confirm(`Apply the reviewed server configuration?");
    expect(js).toContain("confirmation: preview.confirmation");
  });
});

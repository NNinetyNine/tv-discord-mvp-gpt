import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Administration server configuration UI", () => {
  it("exposes secure bot status, route testing, governed configuration, and migration", async () => {
    const html = await readFile(new URL("../admin-ui/index.html", import.meta.url), "utf8");
    const js = await readFile(new URL("../admin-ui/app.js", import.meta.url), "utf8");
    expect(html).toContain('data-view="server"');
    expect(html).toContain("SERVER CONFIGURATION");
    expect(html).toContain("TEST CURRENT SERVER");
    expect(html).toContain("ROUTING &amp; DESTINATIONS");
    expect(html).toContain("REVIEW AS SERVER MIGRATION");
    expect(html).toContain("Credentials remain process-environment secrets");
    expect(html).toContain("WEBHOOKS");
    expect(js).toContain('api("/api/v1/server-configuration/test"');
    expect(js).toContain('"/api/v1/server-migration/preview"');
    expect(js).toContain("preview.confirmation");
  });
});

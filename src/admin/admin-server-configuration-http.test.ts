import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DiscordServerAdministrationSession } from "../publish/discord-server-session.ts";
import { startAdminHttpServer, type RunningAdminHttpServer } from "./admin-http-server.ts";
import { AdminService } from "./admin-service.ts";

const cleanup: string[] = [];
const servers: RunningAdminHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function start() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "visionx-server-http-repo-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-server-http-workspace-"));
  cleanup.push(repositoryRoot, workspaceRoot);
  await Promise.all([
    cp(resolve("definitions"), join(repositoryRoot, "definitions"), { recursive: true }),
    cp(resolve("config"), join(repositoryRoot, "config"), { recursive: true }),
  ]);
  const openDiscordServerSession = async (): Promise<DiscordServerAdministrationSession> => Object.freeze({
    bot: Object.freeze({ userId: "188888888888888888", username: "visionx-http" }),
    async inspectForum(channelId: string) {
      return Object.freeze({
        channelId,
        channelName: `forum-${channelId.slice(-4)}`,
        channelType: "guild_forum" as const,
        guildId: "199999999999999999",
        guildName: "VisionX HTTP",
        availableTagCount: 3,
    availableTags: Object.freeze([Object.freeze({ id: "155555555555555555", name: "Analysis", moderated: false })]),
        roleNames: Object.freeze(["VisionX Bot"]),
        permissions: Object.freeze({
          viewChannel: true,
          sendMessages: true,
          sendMessagesInThreads: true,
          createPublicThreads: true,
          manageThreads: true,
          attachFiles: true,
          readMessageHistory: true,
        }),
        missingPermissions: Object.freeze([]),
      });
    },
    async close() {},
  });
  const service = await AdminService.create({
    repositoryRoot,
    workspaceRoot,
    openDiscordServerSession,
    discordCredentialConfigured: true,
  });
  const server = await startAdminHttpServer({ service, host: "127.0.0.1", port: 0 });
  servers.push(server);
  return { repositoryRoot, server };
}

async function json(url: string, path: string, init?: RequestInit) {
  const response = await fetch(`${url}${path}`, init);
  return { response, body: await response.json() as any };
}

describe("Administration server configuration HTTP", () => {
  it("serves state, connection testing, preview, and exact apply routes", async () => {
    const { repositoryRoot, server } = await start();
    const state = await json(server.url, "/api/v1/server-configuration");
    expect(state.response.status).toBe(200);
    expect(state.body.data).toMatchObject({
      credential: { configured: true, valueExposed: false },
      connectionTestAvailable: true,
      webhooks: { used: false },
    });

    const tested = await json(server.url, "/api/v1/server-configuration/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(tested.body.data).toMatchObject({ operationallyReady: true, guild: { name: "VisionX HTTP" } });

    const routes = Object.fromEntries(state.body.data.routes.map((route: any) => [route.logicalChannel, route.channelId ?? ""]));
    routes.stocks = "177777777777777777";
    const preview = await json(server.url, "/api/v1/server-configuration/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routes }),
    });
    expect(preview.response.status).toBe(201);
    expect(preview.body.data).toMatchObject({ valid: true, confirmation: "APPLY SERVER CONFIGURATION" });

    const wrong = await json(server.url, `/api/v1/server-configuration/previews/${preview.body.data.previewId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "APPLY" }),
    });
    expect(wrong.response.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: "server_configuration_confirmation_invalid" });

    const applied = await json(server.url, `/api/v1/server-configuration/previews/${preview.body.data.previewId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: preview.body.data.confirmation }),
    });
    expect(applied.body.data).toMatchObject({ applied: true, mode: "configuration" });
    expect(JSON.parse(await readFile(join(repositoryRoot, "config/channels.json"), "utf8"))).toMatchObject({ stocks: routes.stocks });
  });
});

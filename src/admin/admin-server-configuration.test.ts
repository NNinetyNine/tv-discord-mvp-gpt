import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  DiscordServerAdministrationSession,
  DiscordServerRouteFacts,
} from "../publish/discord-server-session.ts";
import { copyAdminCanonicalFixture } from "../test-support/admin-canonical-fixture.ts";
import { AdminService } from "./admin-service.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function mutableRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visionx-server-config-repo-"));
  cleanup.push(root);
  await copyAdminCanonicalFixture(root);
  return root;
}

function routeFacts(channelId: string, missingPermissions: readonly (keyof DiscordServerRouteFacts["permissions"])[] = []): DiscordServerRouteFacts {
  const permissions = Object.freeze({
    viewChannel: !missingPermissions.includes("viewChannel"),
    sendMessages: !missingPermissions.includes("sendMessages"),
    sendMessagesInThreads: !missingPermissions.includes("sendMessagesInThreads"),
    createPublicThreads: !missingPermissions.includes("createPublicThreads"),
    manageThreads: !missingPermissions.includes("manageThreads"),
    attachFiles: !missingPermissions.includes("attachFiles"),
    readMessageHistory: !missingPermissions.includes("readMessageHistory"),
  });
  return Object.freeze({
    channelId,
    channelName: `forum-${channelId.slice(-4)}`,
    channelType: "guild_forum",
    guildId: "199999999999999999",
    guildName: "VisionX QA",
    availableTagCount: 4,
    availableTags: Object.freeze([Object.freeze({ id: "155555555555555555", name: "Analysis", moderated: false })]),
    roleNames: Object.freeze(["VisionX Bot"]),
    permissions,
    missingPermissions: Object.freeze([...missingPermissions]),
  });
}

function sessionFactory(options: { readonly missingPermissionChannelId?: string } = {}) {
  const inspected: string[] = [];
  let closed = false;
  return {
    inspected,
    closed: () => closed,
    open: async (): Promise<DiscordServerAdministrationSession> => Object.freeze({
      bot: Object.freeze({ userId: "188888888888888888", username: "visionx-test" }),
      async inspectForum(channelId: string) {
        inspected.push(channelId);
        return routeFacts(
          channelId,
          channelId === options.missingPermissionChannelId ? ["sendMessagesInThreads"] : [],
        );
      },
      async close() { closed = true; },
    }),
  };
}

async function createService(repositoryRoot: string, factory = sessionFactory()) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-server-config-workspace-"));
  cleanup.push(workspaceRoot);
  const service = await AdminService.create({
    repositoryRoot,
    workspaceRoot,
    openDiscordServerSession: factory.open,
    discordCredentialConfigured: true,
  });
  return { service, factory, workspaceRoot };
}

function currentRoutes(state: Awaited<ReturnType<AdminService["serverConfigurationState"]>>): Record<string, string> {
  return Object.fromEntries(state.routes.map((route) => [route.logicalChannel, route.channelId ?? ""]));
}

describe("Administration server configuration", () => {
  it("reports secure credential, route ownership, direct gateway, and no webhook custody", async () => {
    const root = await mutableRepository();
    const { service } = await createService(root);
    const state = await service.serverConfigurationState();
    expect(state).toMatchObject({
      credential: { configured: true, source: "process_environment", editable: false, valueExposed: false },
      connectionTestAvailable: true,
      publisherTransport: "discord_bot_gateway",
      webhooks: { used: false, configured: false },
    });
    expect(state.routes).toContainEqual(expect.objectContaining({
      logicalChannel: "crypto",
      packIds: ["crypto"],
      boundThreadCount: 1,
    }));
    expect(JSON.stringify(state)).not.toContain("DISCORD_BOT_TOKEN");
  });

  it("tests bot, guild, forum tags, roles, and required permissions without mutation", async () => {
    const root = await mutableRepository();
    const before = await readFile(join(root, "config/channels.json"));
    const { service, factory } = await createService(root);
    const result = await service.inspectServerConfiguration();
    expect(result).toMatchObject({
      operationallyReady: true,
      bot: { username: "visionx-test" },
      guild: { name: "VisionX QA" },
      sessionClosed: true,
      effects: { discordInspected: true, discordContentChanged: false, configurationChanged: false },
    });
    expect(result.routes).toHaveLength(6);
    expect(result.routes[0]?.facts).toMatchObject({ availableTagCount: 4, roleNames: ["VisionX Bot"] });
    expect(factory.closed()).toBe(true);
    expect(await readFile(join(root, "config/channels.json"))).toEqual(before);
  });

  it("applies one live-validated route change while preserving all thread bindings", async () => {
    const root = await mutableRepository();
    const { service, factory } = await createService(root);
    const state = await service.serverConfigurationState();
    const routes = currentRoutes(state);
    routes.stocks = "177777777777777777";
    const beforeBindings = await readFile(join(root, "config/asset-threads.json"));
    const preview = await service.prepareServerConfigurationChange({ routes });
    expect(preview).toMatchObject({
      valid: true,
      mode: "configuration",
      changedRouteCount: 1,
      bindingsToReestablish: 0,
      confirmation: "APPLY SERVER CONFIGURATION",
      effects: { threadBindingsRemoved: 0, discordContentChanged: false },
    });
    const applied = await service.applyServerConfiguration(preview.previewId, preview.confirmation);
    expect(applied).toMatchObject({
      applied: true,
      mode: "configuration",
      backupId: null,
      liveValidation: { operationallyReady: true, routeCount: 6 },
    });
    expect(factory.inspected).toHaveLength(12);
    expect(JSON.parse(await readFile(join(root, "config/channels.json"), "utf8"))).toMatchObject({ stocks: routes.stocks });
    expect(await readFile(join(root, "config/asset-threads.json"))).toEqual(beforeBindings);
  });

  it("adds a new logical route after live validation without creating Discord content", async () => {
    const root = await mutableRepository();
    const { service } = await createService(root);
    const routes = currentRoutes(await service.serverConfigurationState());
    routes.research = "144444444444444444";

    const preview = await service.prepareServerConfigurationChange({ routes });
    expect(preview).toMatchObject({
      valid: true,
      mode: "configuration",
      changedRouteCount: 1,
      affectedPackIds: [],
      bindingsToReestablish: 0,
      effects: { discordContentChanged: false },
    });
    expect(preview.routes).toContainEqual(expect.objectContaining({
      logicalChannel: "research",
      currentChannelId: null,
      nextChannelId: routes.research,
      changed: true,
      packIds: [],
      boundThreadCount: 0,
    }));

    await service.applyServerConfiguration(preview.previewId, preview.confirmation);
    const stored = JSON.parse(await readFile(join(root, "config/channels.json"), "utf8")) as Record<string, string>;
    expect(stored.research).toBe(routes.research);
    expect((await service.serverConfigurationState()).routes).toContainEqual(expect.objectContaining({
      logicalChannel: "research",
      channelId: routes.research,
      packIds: [],
      registryAssetCount: 0,
      boundThreadCount: 0,
    }));
  });

  it("removes an unused logical route after review while preserving every remaining route", async () => {
    const root = await mutableRepository();
    const channelsPath = join(root, "config/channels.json");
    const channels = JSON.parse(await readFile(channelsPath, "utf8")) as Record<string, string>;
    channels.unused = "144444444444444444";
    await writeFile(channelsPath, `${JSON.stringify(channels, null, 2)}\n`, "utf8");

    const { service } = await createService(root);
    const routes = currentRoutes(await service.serverConfigurationState());
    delete routes.unused;
    const preview = await service.prepareServerConfigurationChange({ routes });
    expect(preview).toMatchObject({ valid: true, changedRouteCount: 1, affectedPackIds: [] });
    expect(preview.routes).toContainEqual(expect.objectContaining({
      logicalChannel: "unused",
      currentChannelId: channels.unused,
      nextChannelId: null,
      changed: true,
    }));

    await service.applyServerConfiguration(preview.previewId, preview.confirmation);
    const stored = JSON.parse(await readFile(channelsPath, "utf8")) as Record<string, string>;
    expect(stored).not.toHaveProperty("unused");
    expect(Object.keys(stored).sort()).toEqual(Object.keys(routes).sort());
  });

  it("blocks route removal until Pack, Registry, and binding dependencies are reassigned", async () => {
    const root = await mutableRepository();
    const { service } = await createService(root);
    const routes = currentRoutes(await service.serverConfigurationState());
    delete routes.crypto;

    const preview = await service.prepareServerConfigurationChange({ routes });
    expect(preview.valid).toBe(false);
    expect(preview.issues).toContainEqual(expect.objectContaining({
      code: "route_removal_blocked",
      logicalChannel: "crypto",
    }));
    expect(preview.issues.find((entry) => entry.code === "route_removal_blocked")?.message).toContain("Packs crypto");
    expect(preview.issues.find((entry) => entry.code === "route_removal_blocked")?.message).toContain("Registry Assets");
    await expect(service.applyServerConfiguration(preview.previewId, preview.confirmation)).rejects.toMatchObject({
      code: "server_configuration_preview_not_found",
    });
  });

  it("requires migration for a changed route with persistent bindings", async () => {
    const root = await mutableRepository();
    const { service } = await createService(root);
    const routes = currentRoutes(await service.serverConfigurationState());
    routes.crypto = "166666666666666666";
    const preview = await service.prepareServerConfigurationChange({ routes });
    expect(preview.valid).toBe(false);
    expect(preview.bindingsToReestablish).toBe(1);
    expect(preview.issues).toContainEqual(expect.objectContaining({ code: "binding_migration_required" }));
    await expect(service.applyServerConfiguration(preview.previewId, preview.confirmation)).rejects.toMatchObject({
      code: "server_configuration_preview_not_found",
    });
  });

  it("backs up migration evidence, uses a rollback-protected transaction, and clears only affected Pack bindings", async () => {
    const root = await mutableRepository();
    const threadBindingsPath = join(root, "config/asset-threads.json");
    const initialBindings = JSON.parse(await readFile(threadBindingsPath, "utf8")) as any;
    initialBindings.packs.stocks = { moh: "133333333333333333" };
    await writeFile(threadBindingsPath, `${JSON.stringify(initialBindings, null, 2)}\n`, "utf8");
    const { service, workspaceRoot } = await createService(root);
    const routes = currentRoutes(await service.serverConfigurationState());
    routes.crypto = "166666666666666666";
    const preview = await service.prepareServerMigration({ routes });
    expect(preview).toMatchObject({
      valid: true,
      mode: "migration",
      confirmation: "MIGRATE 1 ROUTE",
      affectedPackIds: ["crypto"],
      bindingsToReestablish: 1,
      effects: { threadBindingsRemoved: 1, backupRequired: true },
    });
    const applied = await service.applyServerConfiguration(preview.previewId, preview.confirmation);
    expect(applied).toMatchObject({ applied: true, mode: "migration", backupId: preview.previewId });
    expect(JSON.parse(await readFile(threadBindingsPath, "utf8"))).toEqual({
      schemaVersion: 1,
      packs: { stocks: { moh: "133333333333333333" } },
    });
    expect(await readFile(join(workspaceRoot, "server-configuration/migrations", preview.previewId, "channels.before.json"))).toBeTruthy();
    expect(await readFile(join(workspaceRoot, "server-configuration/migrations", preview.previewId, "completion.json"))).toBeTruthy();
  });

  it("rejects a stale preview without overwriting a newer canonical route change", async () => {
    const root = await mutableRepository();
    const { service } = await createService(root);
    const channelsPath = join(root, "config/channels.json");
    const candidate = currentRoutes(await service.serverConfigurationState());
    candidate.stocks = "177777777777777777";
    const preview = await service.prepareServerConfigurationChange({ routes: candidate });
    expect(preview.valid).toBe(true);

    const newer = JSON.parse(await readFile(channelsPath, "utf8")) as Record<string, string>;
    newer.etfs = "122222222222222222";
    await writeFile(channelsPath, `${JSON.stringify(newer, null, 2)}\n`, "utf8");

    await expect(
      service.applyServerConfiguration(preview.previewId, preview.confirmation),
    ).rejects.toMatchObject({ code: "server_configuration_state_changed", status: 409 });
    expect(JSON.parse(await readFile(channelsPath, "utf8"))).toEqual(newer);
  });

  it("rejects a preview when Pack routing context changes after review", async () => {
    const root = await mutableRepository();
    const { service } = await createService(root);
    const channelsPath = join(root, "config/channels.json");
    const packsPath = join(root, "definitions/packs.json");
    const channelsBefore = await readFile(channelsPath);
    const candidate = currentRoutes(await service.serverConfigurationState());
    candidate.stocks = "177777777777777777";
    const preview = await service.prepareServerConfigurationChange({ routes: candidate });
    expect(preview.valid).toBe(true);

    const packs = JSON.parse(await readFile(packsPath, "utf8")) as Array<Record<string, unknown>>;
    packs[0] = { ...packs[0], display: "Crypto Markets" };
    await writeFile(packsPath, `${JSON.stringify(packs, null, 2)}
`, "utf8");

    await expect(
      service.applyServerConfiguration(preview.previewId, preview.confirmation),
    ).rejects.toMatchObject({ code: "server_configuration_state_changed", status: 409 });
    expect(await readFile(channelsPath)).toEqual(channelsBefore);
  });

  it("revalidates the complete live target immediately before source mutation", async () => {
    const root = await mutableRepository();
    const beforeChannels = await readFile(join(root, "config/channels.json"));
    let openCount = 0;
    const targetChannelId = "144444444444444444";
    const openDiscordServerSession = async (): Promise<DiscordServerAdministrationSession> => {
      openCount += 1;
      const blockTarget = openCount > 1;
      return Object.freeze({
        bot: Object.freeze({ userId: "188888888888888888", username: "visionx-test" }),
        async inspectForum(channelId: string) {
          return routeFacts(
            channelId,
            blockTarget && channelId === targetChannelId ? ["manageThreads"] : [],
          );
        },
        async close() {},
      });
    };
    const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-server-config-revalidate-"));
    cleanup.push(workspaceRoot);
    const service = await AdminService.create({
      repositoryRoot: root,
      workspaceRoot,
      openDiscordServerSession,
      discordCredentialConfigured: true,
    });
    const routes = currentRoutes(await service.serverConfigurationState());
    routes.stocks = targetChannelId;
    const preview = await service.prepareServerConfigurationChange({ routes });
    expect(preview.valid).toBe(true);
    await expect(
      service.applyServerConfiguration(preview.previewId, preview.confirmation),
    ).rejects.toMatchObject({ code: "server_configuration_blocked", status: 409 });
    expect(openCount).toBe(2);
    expect(await readFile(join(root, "config/channels.json"))).toEqual(beforeChannels);
  });

  it("rechecks canonical Pack context after final live validation and before source mutation", async () => {
    const root = await mutableRepository();
    const channelsPath = join(root, "config/channels.json");
    const packsPath = join(root, "definitions/packs.json");
    const channelsBefore = await readFile(channelsPath);
    let openCount = 0;
    const openDiscordServerSession = async (): Promise<DiscordServerAdministrationSession> => {
      openCount += 1;
      const mutateOnClose = openCount === 2;
      return Object.freeze({
        bot: Object.freeze({ userId: "188888888888888888", username: "visionx-test" }),
        async inspectForum(channelId: string) {
          return routeFacts(channelId);
        },
        async close() {
          if (mutateOnClose) {
            const packs = JSON.parse(await readFile(packsPath, "utf8")) as Array<Record<string, unknown>>;
            packs[0] = { ...packs[0], display: "Changed During Live Validation" };
            await writeFile(packsPath, `${JSON.stringify(packs, null, 2)}\n`, "utf8");
          }
        },
      });
    };
    const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-server-config-live-race-"));
    cleanup.push(workspaceRoot);
    const service = await AdminService.create({
      repositoryRoot: root,
      workspaceRoot,
      openDiscordServerSession,
      discordCredentialConfigured: true,
    });
    const routes = currentRoutes(await service.serverConfigurationState());
    routes.stocks = "177777777777777777";
    const preview = await service.prepareServerConfigurationChange({ routes });
    expect(preview.valid).toBe(true);

    await expect(
      service.applyServerConfiguration(preview.previewId, preview.confirmation),
    ).rejects.toMatchObject({ code: "server_configuration_state_changed", status: 409 });
    expect(openCount).toBe(2);
    expect(await readFile(channelsPath)).toEqual(channelsBefore);
  });

  it("returns a blocked preview when the bot lacks a required target permission", async () => {
    const root = await mutableRepository();
    const initial = await createService(root);
    const state = await initial.service.serverConfigurationState();
    const routes = currentRoutes(state);
    routes.stocks = "155555555555555555";
    const blockedFactory = sessionFactory({ missingPermissionChannelId: routes.stocks });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-server-config-blocked-"));
    cleanup.push(workspaceRoot);
    const service = await AdminService.create({
      repositoryRoot: root,
      workspaceRoot,
      openDiscordServerSession: blockedFactory.open,
      discordCredentialConfigured: true,
    });
    const preview = await service.prepareServerConfigurationChange({ routes });
    expect(preview.valid).toBe(false);
    expect(preview.issues).toContainEqual(expect.objectContaining({
      code: "discord_route_blocked",
      logicalChannel: "stocks",
    }));
  });
});

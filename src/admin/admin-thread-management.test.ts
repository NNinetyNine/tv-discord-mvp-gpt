import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type {
  DiscordAssetThreadCreateInput,
} from "../application/provision-discord-asset-thread.ts";
import type { DiscordAssetThreadFacts } from "../application/adopt-discord-asset-thread.ts";
import type {
  DiscordForumAdministrationSession,
  DiscordForumSession,
} from "../publish/discord-forum-session.ts";
import { parseAssetThreadBindings } from "../wiring/asset-threads.ts";
import { startAdminHttpServer, type RunningAdminHttpServer } from "./admin-http-server.ts";
import {
  AdminService,
  type AdminDiscordForumProvisioningSessionFactory,
  type AdminDiscordForumSessionFactory,
} from "./admin-service.ts";

const CRYPTO_FORUM_ID = "1529334738454839349";
const ADOPTED_THREAD_ID = "1529999999999999999";
const OTHER_FORUM_ID = "1528888888888888888";

const cleanup: string[] = [];
const servers: RunningAdminHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visionx-admin-threads-source-"));
  cleanup.push(root);
  await cp(resolve("definitions"), join(root, "definitions"), { recursive: true });
  await cp(resolve("config"), join(root, "config"), { recursive: true });
  return root;
}

async function createService(
  repositoryRoot: string,
  openDiscordForumSession?: AdminDiscordForumSessionFactory,
  openDiscordForumProvisioningSession?: AdminDiscordForumProvisioningSessionFactory,
): Promise<AdminService> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-threads-workspace-"));
  cleanup.push(workspaceRoot);
  return AdminService.create({
    repositoryRoot,
    workspaceRoot,
    ...(openDiscordForumSession === undefined ? {} : { openDiscordForumSession }),
    ...(openDiscordForumProvisioningSession === undefined ? {} : { openDiscordForumProvisioningSession }),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function squarePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 96,
      height: 96,
      channels: 4,
      background: { r: 24, g: 48, b: 72, alpha: 1 },
    },
  }).png().toBuffer();
}

function sessionFactory(options: {
  readonly parentId?: string;
  readonly found?: boolean;
  readonly closeFails?: boolean;
} = {}): {
  readonly factory: AdminDiscordForumSessionFactory;
  readonly opened: string[];
  readonly inspected: string[];
  readonly closed: string[];
} {
  const opened: string[] = [];
  const inspected: string[] = [];
  const closed: string[] = [];
  const factory = async (): Promise<DiscordForumSession> => {
    opened.push("session");
    return Object.freeze({
      inspectThread: async (threadId: string): Promise<DiscordAssetThreadFacts | null> => {
        inspected.push(threadId);
        if (options.found === false) return null;
        return Object.freeze({
          threadId,
          parentId: options.parentId ?? CRYPTO_FORUM_ID,
          name: "Akash Network // $AKT",
          archived: false,
          locked: false,
          appliedTagIds: Object.freeze(["1527777777777777777"]),
        });
      },
      close: async () => {
        closed.push("session");
        if (options.closeFails === true) throw new Error("mock close failure");
      },
    });
  };
  return { factory, opened, inspected, closed };
}

function provisioningSessionFactory(options: {
  readonly createdThreadId?: string;
  readonly deleteFails?: boolean;
  readonly closeFails?: boolean;
} = {}): {
  readonly factory: AdminDiscordForumProvisioningSessionFactory;
  readonly opened: string[];
  readonly inspectedForums: string[];
  readonly createCalls: DiscordAssetThreadCreateInput[];
  readonly deleted: string[];
  readonly closed: string[];
} {
  const opened: string[] = [];
  const inspectedForums: string[] = [];
  const createCalls: DiscordAssetThreadCreateInput[] = [];
  const deleted: string[] = [];
  const closed: string[] = [];
  const factory = async (): Promise<DiscordForumAdministrationSession> => {
    opened.push("session");
    return Object.freeze({
      inspectForum: async (forumChannelId: string) => {
        inspectedForums.push(forumChannelId);
        return Object.freeze({
          forumChannelId,
          name: "Crypto Analyses",
          availableTags: Object.freeze([
            Object.freeze({ id: "1527777777777777777", name: "Analysis", moderated: false }),
            Object.freeze({ id: "1527777777777777778", name: "Members", moderated: true }),
          ]),
        });
      },
      inspectThread: async () => null,
      createThread: async (input: DiscordAssetThreadCreateInput) => {
        createCalls.push(input);
        return Object.freeze({
          threadId: options.createdThreadId ?? ADOPTED_THREAD_ID,
          parentId: input.forumChannelId,
          name: input.title,
          archived: false,
          locked: false,
          appliedTagIds: Object.freeze([...input.appliedTagIds]),
        });
      },
      deleteThread: async (threadId: string) => {
        deleted.push(threadId);
        if (options.deleteFails === true) throw new Error("mock delete failure");
      },
      close: async () => {
        closed.push("session");
        if (options.closeFails === true) throw new Error("mock close failure");
      },
    });
  };
  return { factory, opened, inspectedForums, createCalls, deleted, closed };
}

describe("Administration Discord thread routing", () => {
  it("reports exact canonical routing coverage without exposing forum snowflakes", async () => {
    const service = await createService(resolve("."));
    const state = await service.threadManagementState();
    const crypto = state.packs.find((pack) => pack.id === "crypto");

    expect(state).toMatchObject({
      schemaVersion: 1,
      mode: "adoption_only",
      adoptionAvailable: false,
      provisioningAvailable: false,
      publicationAvailable: false,
      boundCount: 1,
      totalCount: 131,
      missingCount: 130,
    });
    expect(crypto).toMatchObject({
      logicalChannel: "crypto",
      forumConfigured: true,
      boundCount: 1,
      totalCount: 16,
      missingCount: 15,
    });
    expect(crypto?.assets.find((asset) => asset.id === "btc")).toMatchObject({
      bindingState: "bound",
      threadId: "1529335112293027860",
    });
    expect(crypto?.assets.find((asset) => asset.id === "akt")).toMatchObject({
      bindingState: "unbound",
      threadId: null,
    });
    expect(JSON.stringify(state)).not.toContain(CRYPTO_FORUM_ID);
  });

  it("adopts only after read-only parent verification and atomically records the local binding", async () => {
    const repositoryRoot = await temporaryRepository();
    const mock = sessionFactory();
    const service = await createService(repositoryRoot, mock.factory);
    const canonicalPaths = [
      "definitions/registry.json",
      "definitions/packs.json",
      "config/channels.json",
    ].map((path) => join(repositoryRoot, path));
    const before = await Promise.all(canonicalPaths.map(async (path) => sha256(await readFile(path))));

    const result = await service.adoptExistingThread({
      packId: "crypto",
      assetId: "akt",
      threadId: ADOPTED_THREAD_ID,
      confirmation: "adopt_existing_thread",
    });

    expect(result).toMatchObject({
      outcome: "adopted",
      packId: "crypto",
      assetId: "akt",
      thread: {
        threadId: ADOPTED_THREAD_ID,
        name: "Akash Network // $AKT",
        appliedTagCount: 1,
      },
      sessionClosed: true,
      warnings: [],
      effects: {
        discordInspected: true,
        discordContentChanged: false,
        bindingChanged: true,
        published: false,
        released: false,
      },
    });
    expect(mock.opened).toEqual(["session"]);
    expect(mock.inspected).toEqual([ADOPTED_THREAD_ID]);
    expect(mock.closed).toEqual(["session"]);

    const bindings = parseAssetThreadBindings(JSON.parse(
      await readFile(join(repositoryRoot, "config/asset-threads.json"), "utf8"),
    ));
    expect(bindings.packs.crypto).toMatchObject({
      akt: ADOPTED_THREAD_ID,
      btc: "1529335112293027860",
    });
    const after = await Promise.all(canonicalPaths.map(async (path) => sha256(await readFile(path))));
    expect(after).toEqual(before);
    await expect(service.threadManagementState()).resolves.toMatchObject({ boundCount: 2, missingCount: 129 });
  });

  it("rejects unavailable, unconfirmed, malformed, and conflicting requests before Discord contact", async () => {
    const repositoryRoot = await temporaryRepository();
    const withoutDiscord = await createService(repositoryRoot);
    await expect(withoutDiscord.adoptExistingThread({
      packId: "crypto",
      assetId: "akt",
      threadId: ADOPTED_THREAD_ID,
      confirmation: "adopt_existing_thread",
    })).rejects.toMatchObject({ code: "discord_operations_unavailable", status: 503 });

    const mock = sessionFactory();
    const service = await createService(repositoryRoot, mock.factory);
    await expect(service.adoptExistingThread({
      packId: "crypto",
      assetId: "akt",
      threadId: ADOPTED_THREAD_ID,
      confirmation: "yes",
    })).rejects.toMatchObject({ code: "thread_adoption_confirmation_invalid" });
    await expect(service.adoptExistingThread({
      packId: "crypto",
      assetId: "akt",
      threadId: "not-a-thread",
      confirmation: "adopt_existing_thread",
    })).rejects.toMatchObject({ code: "thread_adoption_failed", status: 400 });
    await expect(service.adoptExistingThread({
      packId: "crypto",
      assetId: "btc",
      threadId: ADOPTED_THREAD_ID,
      confirmation: "adopt_existing_thread",
    })).rejects.toMatchObject({ code: "thread_binding_conflict", status: 409 });
    await expect(service.adoptExistingThread({
      packId: "crypto",
      assetId: "akt",
      threadId: "1529335112293027860",
      confirmation: "adopt_existing_thread",
    })).rejects.toMatchObject({ code: "thread_binding_conflict", status: 409 });
    expect(mock.opened).toEqual([]);
    expect(mock.inspected).toEqual([]);
    expect(mock.closed).toEqual([]);
  });

  it("rejects a candidate from another forum and preserves the binding source", async () => {
    const repositoryRoot = await temporaryRepository();
    const bindingsPath = join(repositoryRoot, "config/asset-threads.json");
    const before = await readFile(bindingsPath);
    const mock = sessionFactory({ parentId: OTHER_FORUM_ID });
    const service = await createService(repositoryRoot, mock.factory);

    await expect(service.adoptExistingThread({
      packId: "crypto",
      assetId: "akt",
      threadId: ADOPTED_THREAD_ID,
      confirmation: "adopt_existing_thread",
    })).rejects.toMatchObject({ code: "thread_adoption_failed", status: 409 });
    expect(await readFile(bindingsPath)).toEqual(before);
    expect(mock.opened).toEqual(["session"]);
    expect(mock.inspected).toEqual([ADOPTED_THREAD_ID]);
    expect(mock.closed).toEqual(["session"]);
  });

  it("reports a successful binding truthfully when session close fails", async () => {
    const repositoryRoot = await temporaryRepository();
    const mock = sessionFactory({ closeFails: true });
    const service = await createService(repositoryRoot, mock.factory);

    const result = await service.adoptExistingThread({
      packId: "crypto",
      assetId: "akt",
      threadId: ADOPTED_THREAD_ID,
      confirmation: "adopt_existing_thread",
    });
    expect(result).toMatchObject({
      outcome: "adopted",
      sessionClosed: false,
      warnings: ["discord_session_close_failed"],
      effects: { bindingChanged: true, discordContentChanged: false },
    });
    expect((await service.threadManagementState()).boundCount).toBe(2);
  });

  it("inspects current forum tags, stages exact logo evidence, and provisions one persistent post", async () => {
    const repositoryRoot = await temporaryRepository();
    const mock = provisioningSessionFactory();
    const service = await createService(repositoryRoot, undefined, mock.factory);
    const protectedPaths = [
      "definitions/registry.json",
      "definitions/packs.json",
      "config/channels.json",
    ].map((path) => join(repositoryRoot, path));
    const before = await Promise.all(protectedPaths.map(async (path) => sha256(await readFile(path))));

    await expect(service.threadManagementState()).resolves.toMatchObject({
      mode: "adoption_and_provisioning",
      adoptionAvailable: false,
      provisioningAvailable: true,
      publicationAvailable: false,
    });
    const forum = await service.inspectPackForum({
      packId: "crypto",
      confirmation: "inspect_forum_tags",
    });
    expect(forum).toMatchObject({
      packId: "crypto",
      forum: {
        name: "Crypto Analyses",
        availableTags: [
          { id: "1527777777777777777", name: "Analysis", moderated: false },
          { id: "1527777777777777778", name: "Members", moderated: true },
        ],
      },
      sessionClosed: true,
      effects: { discordContentChanged: false, bindingChanged: false, published: false, released: false },
    });

    const logoBytes = await squarePng();
    const staged = await service.stageThreadProvisioningLogo({ packId: "crypto", assetId: "akt", bytes: logoBytes });
    expect(staged).toMatchObject({
      packId: "crypto",
      assetId: "akt",
      evidence: { width: 96, height: 96 },
      effects: { discordContacted: false, repositoryChanged: false },
    });
    expect(mock.opened).toEqual(["session"]);

    const result = await service.provisionNewThread({
      packId: "crypto",
      assetId: "akt",
      title: "Akash Network // $AKT",
      appliedTagIds: ["1527777777777777777"],
      logoSha256: (staged.evidence as { sha256: string }).sha256,
      confirmation: "provision_new_thread",
    });
    expect(result).toMatchObject({
      outcome: "provisioned",
      packId: "crypto",
      assetId: "akt",
      thread: { threadId: ADOPTED_THREAD_ID, name: "Akash Network // $AKT", appliedTagCount: 1 },
      sessionClosed: true,
      effects: {
        discordInspected: true,
        discordContentChanged: true,
        bindingChanged: true,
        published: false,
        released: false,
      },
    });
    expect(mock.opened).toEqual(["session", "session"]);
    expect(mock.inspectedForums).toEqual([CRYPTO_FORUM_ID]);
    expect(mock.createCalls).toHaveLength(1);
    expect(mock.createCalls[0]).toMatchObject({
      forumChannelId: CRYPTO_FORUM_ID,
      title: "Akash Network // $AKT",
      appliedTagIds: ["1527777777777777777"],
      starterLogoFilename: "akt.png",
    });
    expect(mock.createCalls[0]?.starterLogoBytes).toEqual(logoBytes);
    expect(mock.deleted).toEqual([]);
    expect(mock.closed).toEqual(["session", "session"]);
    expect(parseAssetThreadBindings(JSON.parse(
      await readFile(join(repositoryRoot, "config/asset-threads.json"), "utf8"),
    )).packs.crypto).toMatchObject({ akt: ADOPTED_THREAD_ID });
    const after = await Promise.all(protectedPaths.map(async (path) => sha256(await readFile(path))));
    expect(after).toEqual(before);
  });

  it("fails closed before Discord contact on stale logo evidence or invalid confirmation", async () => {
    const repositoryRoot = await temporaryRepository();
    const mock = provisioningSessionFactory();
    const service = await createService(repositoryRoot, undefined, mock.factory);
    const staged = await service.stageThreadProvisioningLogo({ packId: "crypto", assetId: "akt", bytes: await squarePng() });
    const input = {
      packId: "crypto",
      assetId: "akt",
      title: "Akash Network // $AKT",
      appliedTagIds: [] as string[],
      logoSha256: (staged.evidence as { sha256: string }).sha256,
      confirmation: "provision_new_thread",
    };

    await expect(service.provisionNewThread({ ...input, confirmation: "yes" })).rejects.toMatchObject({
      code: "thread_provisioning_confirmation_invalid",
    });
    await expect(service.provisionNewThread({ ...input, logoSha256: "a".repeat(64) })).rejects.toMatchObject({
      code: "thread_provisioning_logo_mismatch",
      status: 409,
    });
    await expect(service.provisionNewThread({ ...input, title: "x".repeat(101) })).rejects.toMatchObject({
      code: "thread_provisioning_failed",
      status: 400,
    });
    expect(mock.opened).toEqual([]);
    expect(mock.createCalls).toEqual([]);
  });

  it("preserves a successful provisioned binding while warning on session-close failure", async () => {
    const repositoryRoot = await temporaryRepository();
    const mock = provisioningSessionFactory({ closeFails: true });
    const service = await createService(repositoryRoot, undefined, mock.factory);
    const staged = await service.stageThreadProvisioningLogo({ packId: "crypto", assetId: "akt", bytes: await squarePng() });

    await expect(service.provisionNewThread({
      packId: "crypto",
      assetId: "akt",
      title: "Akash Network // $AKT",
      appliedTagIds: [],
      logoSha256: (staged.evidence as { sha256: string }).sha256,
      confirmation: "provision_new_thread",
    })).resolves.toMatchObject({
      outcome: "provisioned",
      sessionClosed: false,
      warnings: ["discord_session_close_failed"],
      effects: { discordContentChanged: true, bindingChanged: true },
    });
    expect((await service.threadManagementState()).boundCount).toBe(2);
  });

  it("deletes only the provisional thread when durable binding fails and reports retained cleanup truthfully", async () => {
    const repositoryRoot = await temporaryRepository();
    const deleted = provisioningSessionFactory({ createdThreadId: "1529335112293027860" });
    const service = await createService(repositoryRoot, undefined, deleted.factory);
    const staged = await service.stageThreadProvisioningLogo({ packId: "crypto", assetId: "akt", bytes: await squarePng() });
    const input = {
      packId: "crypto",
      assetId: "akt",
      title: "Akash Network // $AKT",
      appliedTagIds: [] as string[],
      logoSha256: (staged.evidence as { sha256: string }).sha256,
      confirmation: "provision_new_thread",
    };
    await expect(service.provisionNewThread(input)).rejects.toMatchObject({
      code: "thread_provisioning_failed",
      status: 502,
      details: { outcome: "binding_failed_thread_deleted", sessionClosed: true },
    });
    expect(deleted.deleted).toEqual(["1529335112293027860"]);
    expect((await service.threadManagementState()).boundCount).toBe(1);

    const retained = provisioningSessionFactory({ createdThreadId: "1529335112293027860", deleteFails: true });
    const retryService = await createService(repositoryRoot, undefined, retained.factory);
    const retryStaged = await retryService.stageThreadProvisioningLogo({ packId: "crypto", assetId: "akt", bytes: await squarePng() });
    await expect(retryService.provisionNewThread({
      ...input,
      logoSha256: (retryStaged.evidence as { sha256: string }).sha256,
    })).rejects.toMatchObject({
      code: "thread_provisioning_failed",
      status: 502,
      details: {
        outcome: "binding_failed_thread_retained",
        retainedThreadId: "1529335112293027860",
        sessionClosed: true,
      },
    });
    expect(retained.deleted).toEqual(["1529335112293027860"]);
    expect((await retryService.threadManagementState()).boundCount).toBe(1);
  });

  it("fails closed on incoherent thread-binding custody", async () => {
    const repositoryRoot = await temporaryRepository();
    await writeFile(join(repositoryRoot, "config/asset-threads.json"), `${JSON.stringify({
      schemaVersion: 1,
      packs: { crypto: { aapl: ADOPTED_THREAD_ID } },
    }, null, 2)}\n`);
    const service = await createService(repositoryRoot);
    await expect(service.threadManagementState()).rejects.toMatchObject({
      code: "invalid_thread_bindings",
      status: 500,
    });
  });

  it("serves strict dashboard and adoption routes without adding provisioning or publication authority", async () => {
    const repositoryRoot = await temporaryRepository();
    const mock = sessionFactory();
    const service = await createService(repositoryRoot, mock.factory);
    const server = await startAdminHttpServer({ service, host: "127.0.0.1", port: 0 });
    servers.push(server);

    const dashboardResponse = await fetch(`${server.url}/api/v1/thread-management`);
    const dashboard = await dashboardResponse.json() as any;
    expect(dashboardResponse.status).toBe(200);
    expect(dashboard.data).toMatchObject({ adoptionAvailable: true, provisioningAvailable: false, boundCount: 1 });

    const adoptionResponse = await fetch(`${server.url}/api/v1/thread-management/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packId: "crypto",
        assetId: "akt",
        threadId: ADOPTED_THREAD_ID,
        confirmation: "adopt_existing_thread",
      }),
    });
    expect(adoptionResponse.status).toBe(200);
    expect((await adoptionResponse.json() as any).data).toMatchObject({
      outcome: "adopted",
      effects: { discordContentChanged: false, published: false, released: false },
    });

    const extraField = await fetch(`${server.url}/api/v1/thread-management/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packId: "crypto",
        assetId: "zec",
        threadId: "1529999999999999998",
        confirmation: "adopt_existing_thread",
        provision: true,
      }),
    });
    expect(extraField.status).toBe(400);
    expect((await extraField.json() as any).error.code).toBe("invalid_request");
    expect((await fetch(`${server.url}/api/v1/thread-management`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${server.url}/api/v1/thread-management/provision`)).status).toBe(405);
    expect((await fetch(`${server.url}/api/v1/thread-management/publish`)).status).toBe(404);
  });

  it("serves explicit forum inspection, PNG staging, and confirmed provisioning routes", async () => {
    const repositoryRoot = await temporaryRepository();
    const mock = provisioningSessionFactory();
    const service = await createService(repositoryRoot, undefined, mock.factory);
    const server = await startAdminHttpServer({ service, host: "127.0.0.1", port: 0 });
    servers.push(server);

    const inspectionResponse = await fetch(`${server.url}/api/v1/thread-management/packs/crypto/forum/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "inspect_forum_tags" }),
    });
    expect(inspectionResponse.status).toBe(200);
    expect((await inspectionResponse.json() as any).data).toMatchObject({
      forum: {
        name: "Crypto Analyses",
        availableTags: [
          { id: "1527777777777777777" },
          { id: "1527777777777777778" },
        ],
      },
      effects: { discordContentChanged: false, bindingChanged: false },
    });

    const logo = await squarePng();
    const logoResponse = await fetch(`${server.url}/api/v1/thread-management/packs/crypto/assets/akt/provisioning-logo`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: logo,
    });
    expect(logoResponse.status).toBe(201);
    const logoPayload = await logoResponse.json() as any;
    expect(logoPayload.data.effects).toEqual({ discordContacted: false, repositoryChanged: false });

    const provisionResponse = await fetch(`${server.url}/api/v1/thread-management/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packId: "crypto",
        assetId: "akt",
        title: "Akash Network // $AKT",
        appliedTagIds: ["1527777777777777777"],
        logoSha256: logoPayload.data.evidence.sha256,
        confirmation: "provision_new_thread",
      }),
    });
    expect(provisionResponse.status).toBe(201);
    expect((await provisionResponse.json() as any).data).toMatchObject({
      outcome: "provisioned",
      effects: { discordContentChanged: true, bindingChanged: true, published: false, released: false },
    });

    const malformed = await fetch(`${server.url}/api/v1/thread-management/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packId: "crypto",
        assetId: "zec",
        title: "Zcash // $ZEC",
        appliedTagIds: [],
        logoSha256: "a".repeat(64),
        confirmation: "provision_new_thread",
        publish: true,
      }),
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error.code).toBe("invalid_request");
    expect(mock.createCalls).toHaveLength(1);
  });
});

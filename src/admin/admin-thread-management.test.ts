import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DiscordAssetThreadFacts } from "../application/adopt-discord-asset-thread.ts";
import type { DiscordForumSession } from "../publish/discord-forum-session.ts";
import { parseAssetThreadBindings } from "../wiring/asset-threads.ts";
import { startAdminHttpServer, type RunningAdminHttpServer } from "./admin-http-server.ts";
import { AdminService, type AdminDiscordForumSessionFactory } from "./admin-service.ts";

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
): Promise<AdminService> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "visionx-admin-threads-workspace-"));
  cleanup.push(workspaceRoot);
  return AdminService.create({
    repositoryRoot,
    workspaceRoot,
    ...(openDiscordForumSession === undefined ? {} : { openDiscordForumSession }),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
    expect((await fetch(`${server.url}/api/v1/thread-management/provision`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/v1/thread-management/publish`)).status).toBe(404);
  });
});

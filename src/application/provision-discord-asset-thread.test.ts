import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  CanonicalAssetLogo,
} from "../assets/asset-logo-file.ts";
import type {
  DiscordAssetThreadFacts,
} from "./adopt-discord-asset-thread.ts";
import {
  provisionDiscordAssetThread,
  type ProvisionDiscordAssetThreadDeps,
} from "./provision-discord-asset-thread.ts";

const FORUM_ID = "123456789012345678";
const THREAD_ID = "223456789012345678";
const TAG_ID = "323456789012345678";

const LOGO: CanonicalAssetLogo =
  Object.freeze({
    path:
      "/repo/assets/asset-logos/btc.png",
    bytes: Buffer.from("png"),
    evidence: Object.freeze({
      ok: true,
      sha256: "a".repeat(64),
      byteSize: 3,
      format: "png",
      width: 96,
      height: 96,
      pageOrFrameCount: 1,
      channelCount: 4,
      hasAlpha: true,
    }),
  });

const THREAD: DiscordAssetThreadFacts =
  Object.freeze({
    threadId: THREAD_ID,
    parentId: FORUM_ID,
    name: "Bitcoin // $BTC",
    archived: false,
    locked: false,
    appliedTagIds:
      Object.freeze([TAG_ID]),
  });

function fixture(
  overrides: Partial<
    ProvisionDiscordAssetThreadDeps
  > = {},
): {
  readonly deps:
    ProvisionDiscordAssetThreadDeps;
  readonly created: unknown[];
  readonly bound: unknown[];
  readonly deleted: string[];
} {
  const created: unknown[] = [];
  const bound: unknown[] = [];
  const deleted: string[] = [];

  const deps:
  ProvisionDiscordAssetThreadDeps = {
    packs: Object.freeze([
      Object.freeze({
        id: "crypto",
        display: "Crypto",
        channel: "crypto",
        assets:
          Object.freeze(["btc"]),
      }),
    ]),
    assets: Object.freeze([
      Object.freeze({
        id: "btc",
        tradingView: "BTC",
        display: "Bitcoin",
        currency: "USD",
        channel: "crypto",
      }),
    ]),
    resolveChannel: (channelName) =>
      channelName === "crypto"
        ? FORUM_ID
        : null,
    resolveThread: () => null,
    createThread: async (input) => {
      created.push(input);
      return THREAD;
    },
    bindThread:
      async (
        packId,
        assetId,
        threadId,
      ) => {
        bound.push({
          packId,
          assetId,
          threadId,
        });
        return { changed: true };
      },
    deleteThread: async (threadId) => {
      deleted.push(threadId);
    },
    ...overrides,
  };

  return {
    deps,
    created,
    bound,
    deleted,
  };
}

const INPUT = Object.freeze({
  packId: "crypto",
  assetId: "btc",
  title: "Bitcoin // $BTC",
  appliedTagIds:
    Object.freeze([TAG_ID]),
  logo: LOGO,
});

describe("Discord Asset-thread provisioning", () => {
  it("creates a logo starter with explicit title and tags, then binds the returned thread", async () => {
    const state = fixture();

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        INPUT,
      ),
    ).resolves.toEqual({
      ok: true,
      outcome: "provisioned",
      packId: "crypto",
      assetId: "btc",
      forumChannelId: FORUM_ID,
      thread: THREAD,
    });

    expect(state.created).toEqual([
      {
        forumChannelId: FORUM_ID,
        title: "Bitcoin // $BTC",
        appliedTagIds: [TAG_ID],
        starterLogoBytes: LOGO.bytes,
        starterLogoFilename: "btc.png",
      },
    ]);
    expect(state.bound).toEqual([
      {
        packId: "crypto",
        assetId: "btc",
        threadId: THREAD_ID,
      },
    ]);
    expect(state.deleted).toEqual([]);
  });

  it("rejects invalid titles before any side effect", async () => {
    const state = fixture();

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        {
          ...INPUT,
          title: "  ",
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      outcome: "invalid_title",
    });

    expect(state.created).toEqual([]);
    expect(state.bound).toEqual([]);
  });

  it("rejects malformed and duplicate tag IDs before any side effect", async () => {
    const malformed = fixture();

    await expect(
      provisionDiscordAssetThread(
        malformed.deps,
        {
          ...INPUT,
          appliedTagIds: ["bad-tag"],
        },
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "invalid_tag_id",
      tagId: "bad-tag",
    });

    expect(malformed.created).toEqual([]);

    const duplicate = fixture();

    await expect(
      provisionDiscordAssetThread(
        duplicate.deps,
        {
          ...INPUT,
          appliedTagIds: [
            TAG_ID,
            TAG_ID,
          ],
        },
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "duplicate_tag_id",
      tagId: TAG_ID,
    });

    expect(duplicate.created).toEqual([]);
  });

  it("rejects an unknown Pack before Discord creation", async () => {
    const state = fixture();

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        {
          ...INPUT,
          packId: "missing",
        },
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "unknown_pack",
      packId: "missing",
    });

    expect(state.created).toEqual([]);
  });

  it("rejects an Asset outside the Pack before Discord creation", async () => {
    const state = fixture();

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        {
          ...INPUT,
          assetId: "eth",
        },
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "asset_not_in_pack",
      packId: "crypto",
      assetId: "eth",
    });

    expect(state.created).toEqual([]);
  });

  it("rejects a missing canonical Asset before Discord creation", async () => {
    const state = fixture({
      assets: Object.freeze([]),
    });

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        INPUT,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "unknown_asset",
      assetId: "btc",
    });

    expect(state.created).toEqual([]);
  });

  it("fails closed when the Pack forum is not provisioned", async () => {
    const state = fixture({
      resolveChannel: () => null,
    });

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        INPUT,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome:
        "forum_channel_unresolved",
      packId: "crypto",
      channelName: "crypto",
    });

    expect(state.created).toEqual([]);
  });

  it("does not create a second thread for an existing binding", async () => {
    const state = fixture({
      resolveThread: () => THREAD_ID,
    });

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        INPUT,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "already_bound",
      packId: "crypto",
      assetId: "btc",
      threadId: THREAD_ID,
    });

    expect(state.created).toEqual([]);
  });

  it("reports Discord creation failure without binding or cleanup", async () => {
    const state = fixture({
      createThread: async () => {
        throw new Error("missing permission");
      },
    });

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        INPUT,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome:
        "discord_provision_failed",
      packId: "crypto",
      assetId: "btc",
      detail: "missing permission",
    });

    expect(state.bound).toEqual([]);
    expect(state.deleted).toEqual([]);
  });

  it("deletes the newly created provisional thread when binding fails", async () => {
    const state = fixture({
      bindThread: async () => {
        throw new Error("binding race");
      },
    });

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        INPUT,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome:
        "binding_failed_thread_deleted",
      packId: "crypto",
      assetId: "btc",
      thread: THREAD,
      detail: "binding race",
    });

    expect(state.deleted).toEqual([
      THREAD_ID,
    ]);
  });

  it("truthfully reports a retained provisional thread when cleanup also fails", async () => {
    const state = fixture({
      bindThread: async () => {
        throw new Error("binding race");
      },
      deleteThread: async () => {
        throw new Error("delete denied");
      },
    });

    await expect(
      provisionDiscordAssetThread(
        state.deps,
        INPUT,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome:
        "binding_failed_thread_retained",
      packId: "crypto",
      assetId: "btc",
      thread: THREAD,
      detail: "binding race",
      cleanupDetail: "delete denied",
    });
  });
});

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  adoptDiscordAssetThread,
  type AdoptDiscordAssetThreadDeps,
  type DiscordAssetThreadFacts,
} from "./adopt-discord-asset-thread.ts";

const FORUM_ID = "123456789012345678";
const OTHER_FORUM_ID = "223456789012345678";
const THREAD_ID = "323456789012345678";

const THREAD: DiscordAssetThreadFacts =
  Object.freeze({
    threadId: THREAD_ID,
    parentId: FORUM_ID,
    name: "Bitcoin // $BTC",
    archived: false,
    locked: false,
    appliedTagIds: Object.freeze([
      "423456789012345678",
    ]),
  });

function fixture(
  overrides: Partial<AdoptDiscordAssetThreadDeps> = {},
): {
  readonly deps: AdoptDiscordAssetThreadDeps;
  readonly inspected: string[];
  readonly bound: Array<{
    readonly packId: string;
    readonly assetId: string;
    readonly threadId: string;
  }>;
} {
  const inspected: string[] = [];
  const bound: Array<{
    readonly packId: string;
    readonly assetId: string;
    readonly threadId: string;
  }> = [];

  const deps: AdoptDiscordAssetThreadDeps = {
    packs: Object.freeze([
      Object.freeze({
        id: "crypto",
        display: "Crypto",
        channel: "crypto",
        assets: Object.freeze([
          "btc",
          "eth",
        ]),
      }),
    ]),
    resolveChannel: (channelName) =>
      channelName === "crypto"
        ? FORUM_ID
        : null,
    inspectThread: async (threadId) => {
      inspected.push(threadId);
      return THREAD;
    },
    bindThread: async (
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
    ...overrides,
  };

  return { deps, inspected, bound };
}

describe("Discord Asset-thread adoption", () => {
  it("adopts an existing thread only after verifying Pack membership and forum ownership", async () => {
    const state = fixture();

    const result =
      await adoptDiscordAssetThread(
        state.deps,
        "crypto",
        "btc",
        THREAD_ID,
      );

    expect(result).toEqual({
      ok: true,
      outcome: "adopted",
      packId: "crypto",
      assetId: "btc",
      forumChannelId: FORUM_ID,
      thread: THREAD,
    });
    expect(state.inspected).toEqual([
      THREAD_ID,
    ]);
    expect(state.bound).toEqual([
      {
        packId: "crypto",
        assetId: "btc",
        threadId: THREAD_ID,
      },
    ]);
  });

  it("reports an exact repeated binding as already adopted", async () => {
    const state = fixture({
      bindThread: async () => ({
        changed: false,
      }),
    });

    await expect(
      adoptDiscordAssetThread(
        state.deps,
        "crypto",
        "btc",
        THREAD_ID,
      ),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "already_adopted",
    });
  });

  it("rejects malformed Discord thread IDs before inspection", async () => {
    const state = fixture();

    await expect(
      adoptDiscordAssetThread(
        state.deps,
        "crypto",
        "btc",
        "not-a-thread",
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "invalid_thread_id",
      threadId: "not-a-thread",
    });

    expect(state.inspected).toEqual([]);
    expect(state.bound).toEqual([]);
  });

  it("rejects unknown Packs before Discord inspection", async () => {
    const state = fixture();

    await expect(
      adoptDiscordAssetThread(
        state.deps,
        "missing",
        "btc",
        THREAD_ID,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "unknown_pack",
      packId: "missing",
    });

    expect(state.inspected).toEqual([]);
    expect(state.bound).toEqual([]);
  });

  it("rejects an Asset that is not a member of the named Pack", async () => {
    const state = fixture();

    await expect(
      adoptDiscordAssetThread(
        state.deps,
        "crypto",
        "aapl",
        THREAD_ID,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "asset_not_in_pack",
      packId: "crypto",
      assetId: "aapl",
    });

    expect(state.inspected).toEqual([]);
    expect(state.bound).toEqual([]);
  });

  it("fails closed when the Pack forum is not provisioned", async () => {
    const state = fixture({
      resolveChannel: () => null,
    });

    await expect(
      adoptDiscordAssetThread(
        state.deps,
        "crypto",
        "btc",
        THREAD_ID,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "forum_channel_unresolved",
      packId: "crypto",
      channelName: "crypto",
    });

    expect(state.inspected).toEqual([]);
    expect(state.bound).toEqual([]);
  });

  it("does not bind a missing Discord thread", async () => {
    const state = fixture({
      inspectThread: async (threadId) => {
        state.inspected.push(threadId);
        return null;
      },
    });

    await expect(
      adoptDiscordAssetThread(
        state.deps,
        "crypto",
        "btc",
        THREAD_ID,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "thread_not_found",
      packId: "crypto",
      assetId: "btc",
      threadId: THREAD_ID,
    });

    expect(state.bound).toEqual([]);
  });

  it("does not bind a thread owned by a different parent channel", async () => {
    const state = fixture({
      inspectThread: async (threadId) => {
        state.inspected.push(threadId);
        return {
          ...THREAD,
          parentId: OTHER_FORUM_ID,
        };
      },
    });

    await expect(
      adoptDiscordAssetThread(
        state.deps,
        "crypto",
        "btc",
        THREAD_ID,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "thread_parent_mismatch",
      packId: "crypto",
      assetId: "btc",
      threadId: THREAD_ID,
      expectedForumChannelId: FORUM_ID,
      actualParentId: OTHER_FORUM_ID,
    });

    expect(state.bound).toEqual([]);
  });

  it("reports Discord inspection failures without invoking the binding writer", async () => {
    const state = fixture({
      inspectThread: async () => {
        throw new Error("missing access");
      },
    });

    await expect(
      adoptDiscordAssetThread(
        state.deps,
        "crypto",
        "btc",
        THREAD_ID,
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "discord_inspection_failed",
      packId: "crypto",
      assetId: "btc",
      threadId: THREAD_ID,
      detail: "missing access",
    });

    expect(state.bound).toEqual([]);
  });
});

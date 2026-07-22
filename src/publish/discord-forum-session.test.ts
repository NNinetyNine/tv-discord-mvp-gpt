import {
  ChannelType,
  type Channel,
  type ForumThreadChannel,
  type GuildForumThreadCreateOptions,
} from "discord.js";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildDiscordForumProvisioningOperations,
  inspectDiscordForumThread,
  type DiscordChannelFetcher,
} from "./discord-forum-session.ts";

const FORUM_ID = "123456789012345678";
const THREAD_ID = "223456789012345678";
const TAG_ID = "323456789012345678";

function fakeChannel(
  value: {
    readonly id: string;
    readonly type: ChannelType;
    readonly thread?: boolean;
    readonly parentId?: string | null;
    readonly name?: string;
    readonly archived?: boolean | null;
    readonly locked?: boolean | null;
    readonly appliedTags?: readonly string[];
  },
): Channel {
  return {
    id: value.id,
    type: value.type,
    isThread: () => value.thread ?? false,
    parentId: value.parentId ?? null,
    name: value.name ?? "channel",
    archived: value.archived ?? null,
    locked: value.locked ?? null,
    appliedTags: [
      ...(value.appliedTags ?? []),
    ],
  } as unknown as Channel;
}

function fetcher(
  channels: Readonly<Record<string, Channel>>,
  calls: string[],
): DiscordChannelFetcher {
  return async (channelId) => {
    calls.push(channelId);
    return channels[channelId] ?? null;
  };
}

function provisionFixture(
  options: {
    readonly availableTagIds?:
      readonly string[];
    readonly parentId?: string | null;
    readonly deleteThread?: (
      reason?: string,
    ) => Promise<void>;
  } = {},
): {
  readonly fetchChannel:
    DiscordChannelFetcher;
  readonly createCalls:
    GuildForumThreadCreateOptions[];
  readonly deleteReasons: string[];
} {
  const createCalls:
    GuildForumThreadCreateOptions[] = [];
  const deleteReasons: string[] = [];

  const thread = {
    id: THREAD_ID,
    type: ChannelType.PublicThread,
    isThread: () => true,
    parentId:
      options.parentId === undefined
        ? FORUM_ID
        : options.parentId,
    name: "Bitcoin // $BTC",
    archived: false,
    locked: false,
    appliedTags: [TAG_ID],
    delete: async (reason?: string) => {
      deleteReasons.push(reason ?? "");

      if (
        options.deleteThread !== undefined
      ) {
        await options.deleteThread(reason);
      }

      return thread;
    },
  } as unknown as ForumThreadChannel;

  const forum = {
    id: FORUM_ID,
    type: ChannelType.GuildForum,
    availableTags: (
      options.availableTagIds ?? [TAG_ID]
    ).map((id) => ({
      id,
      name: `tag-${id}`,
      moderated: false,
      emoji: null,
    })),
    threads: {
      create: async (
        createOptions:
          GuildForumThreadCreateOptions,
      ) => {
        createCalls.push(createOptions);
        return thread;
      },
    },
  } as unknown as Channel;

  return {
    fetchChannel:
      fetcher(
        {
          [FORUM_ID]: forum,
        },
        [],
      ),
    createCalls,
    deleteReasons,
  };
}

describe("Discord forum inspection", () => {
  it("returns read-only adoption facts for a forum thread", async () => {
    const calls: string[] = [];
    const tagIds = [
      "323456789012345678",
      "423456789012345678",
    ];

    const result =
      await inspectDiscordForumThread(
        fetcher(
          {
            [THREAD_ID]: fakeChannel({
              id: THREAD_ID,
              type:
                ChannelType.PublicThread,
              thread: true,
              parentId: FORUM_ID,
              name: "Bitcoin // $BTC",
              archived: false,
              locked: false,
              appliedTags: tagIds,
            }),
            [FORUM_ID]: fakeChannel({
              id: FORUM_ID,
              type:
                ChannelType.GuildForum,
            }),
          },
          calls,
        ),
        THREAD_ID,
      );

    expect(result).toEqual({
      threadId: THREAD_ID,
      parentId: FORUM_ID,
      name: "Bitcoin // $BTC",
      archived: false,
      locked: false,
      appliedTagIds: tagIds,
    });
    expect(calls).toEqual([
      THREAD_ID,
      FORUM_ID,
    ]);
  });

  it("returns null when the candidate thread does not exist", async () => {
    const calls: string[] = [];

    await expect(
      inspectDiscordForumThread(
        fetcher({}, calls),
        THREAD_ID,
      ),
    ).resolves.toBeNull();

    expect(calls).toEqual([THREAD_ID]);
  });

  it("rejects a channel that is not a thread", async () => {
    await expect(
      inspectDiscordForumThread(
        fetcher(
          {
            [THREAD_ID]: fakeChannel({
              id: THREAD_ID,
              type: ChannelType.GuildText,
            }),
          },
          [],
        ),
        THREAD_ID,
      ),
    ).rejects.toThrow(
      /not a Discord thread/,
    );
  });

  it("rejects a thread whose parent cannot be fetched", async () => {
    await expect(
      inspectDiscordForumThread(
        fetcher(
          {
            [THREAD_ID]: fakeChannel({
              id: THREAD_ID,
              type:
                ChannelType.PublicThread,
              thread: true,
              parentId: FORUM_ID,
            }),
          },
          [],
        ),
        THREAD_ID,
      ),
    ).rejects.toThrow(
      /parent channel .* was not found/,
    );
  });

  it("rejects a thread owned by a non-forum parent", async () => {
    await expect(
      inspectDiscordForumThread(
        fetcher(
          {
            [THREAD_ID]: fakeChannel({
              id: THREAD_ID,
              type:
                ChannelType.PublicThread,
              thread: true,
              parentId: FORUM_ID,
            }),
            [FORUM_ID]: fakeChannel({
              id: FORUM_ID,
              type: ChannelType.GuildText,
            }),
          },
          [],
        ),
        THREAD_ID,
      ),
    ).rejects.toThrow(
      /not owned by a Discord forum channel/,
    );
  });
});

describe("Discord forum provisioning operations", () => {
  it("creates the forum thread with the exact title, tags, and PNG starter", async () => {
    const target = provisionFixture();
    const operations =
      buildDiscordForumProvisioningOperations(
        target.fetchChannel,
      );
    const logo = Buffer.from("logo");

    const result =
      await operations.createThread({
        forumChannelId: FORUM_ID,
        title: "Bitcoin // $BTC",
        appliedTagIds: [TAG_ID],
        starterLogoBytes: logo,
        starterLogoFilename:
          "btc.png",
      });

    expect(result).toEqual({
      threadId: THREAD_ID,
      parentId: FORUM_ID,
      name: "Bitcoin // $BTC",
      archived: false,
      locked: false,
      appliedTagIds: [TAG_ID],
    });

    expect(target.createCalls).toHaveLength(
      1,
    );
    expect(target.createCalls[0]).toEqual({
      name: "Bitcoin // $BTC",
      appliedTags: [TAG_ID],
      message: {
        files: [
          {
            attachment: logo,
            name: "btc.png",
          },
        ],
      },
    });
  });

  it("rejects a destination that is not a forum channel", async () => {
    const operations =
      buildDiscordForumProvisioningOperations(
        fetcher(
          {
            [FORUM_ID]: fakeChannel({
              id: FORUM_ID,
              type: ChannelType.GuildText,
            }),
          },
          [],
        ),
      );

    await expect(
      operations.createThread({
        forumChannelId: FORUM_ID,
        title: "Bitcoin // $BTC",
        appliedTagIds: [],
        starterLogoBytes:
          Buffer.from("logo"),
        starterLogoFilename:
          "btc.png",
      }),
    ).rejects.toThrow(
      /not a Discord forum channel/,
    );
  });

  it("rejects an unavailable tag before creating the thread", async () => {
    const target = provisionFixture({
      availableTagIds: [],
    });
    const operations =
      buildDiscordForumProvisioningOperations(
        target.fetchChannel,
      );

    await expect(
      operations.createThread({
        forumChannelId: FORUM_ID,
        title: "Bitcoin // $BTC",
        appliedTagIds: [TAG_ID],
        starterLogoBytes:
          Buffer.from("logo"),
        starterLogoFilename:
          "btc.png",
      }),
    ).rejects.toThrow(
      /tag .* is not available/,
    );

    expect(target.createCalls).toEqual([]);
  });

  it("deletes only a thread created by the same provisioning session", async () => {
    const target = provisionFixture();
    const operations =
      buildDiscordForumProvisioningOperations(
        target.fetchChannel,
      );

    await operations.createThread({
      forumChannelId: FORUM_ID,
      title: "Bitcoin // $BTC",
      appliedTagIds: [TAG_ID],
      starterLogoBytes:
        Buffer.from("logo"),
      starterLogoFilename: "btc.png",
    });

    await operations.deleteThread(
      THREAD_ID,
    );

    expect(target.deleteReasons).toEqual([
      "VisionX provisioning compensation after binding failure",
    ]);

    await expect(
      operations.deleteThread(THREAD_ID),
    ).rejects.toThrow(
      /was not created by this provisioning session/,
    );
  });

  it("refuses to delete an unrelated Discord thread", async () => {
    const target = provisionFixture();
    const operations =
      buildDiscordForumProvisioningOperations(
        target.fetchChannel,
      );

    await expect(
      operations.deleteThread(THREAD_ID),
    ).rejects.toThrow(
      /refusing to delete thread/,
    );

    expect(target.deleteReasons).toEqual([]);
  });

  it("retains compensation authority when deletion fails so it can be retried", async () => {
    let attempts = 0;

    const target = provisionFixture({
      deleteThread: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("delete denied");
        }
      },
    });

    const operations =
      buildDiscordForumProvisioningOperations(
        target.fetchChannel,
      );

    await operations.createThread({
      forumChannelId: FORUM_ID,
      title: "Bitcoin // $BTC",
      appliedTagIds: [TAG_ID],
      starterLogoBytes:
        Buffer.from("logo"),
      starterLogoFilename: "btc.png",
    });

    await expect(
      operations.deleteThread(THREAD_ID),
    ).rejects.toThrow("delete denied");

    await expect(
      operations.deleteThread(THREAD_ID),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(2);
  });

  it("deletes a created thread whose returned parent is inconsistent", async () => {
    const target = provisionFixture({
      parentId:
        "423456789012345678",
    });
    const operations =
      buildDiscordForumProvisioningOperations(
        target.fetchChannel,
      );

    await expect(
      operations.createThread({
        forumChannelId: FORUM_ID,
        title: "Bitcoin // $BTC",
        appliedTagIds: [TAG_ID],
        starterLogoBytes:
          Buffer.from("logo"),
        starterLogoFilename: "btc.png",
      }),
    ).rejects.toThrow(
      /not requested forum/,
    );

    expect(target.deleteReasons).toEqual([
      "VisionX rejected an invalid provisioning result",
    ]);
  });
});

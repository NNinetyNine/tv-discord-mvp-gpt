import {
  ChannelType,
  type Channel,
} from "discord.js";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  inspectDiscordForumThread,
  type DiscordChannelFetcher,
} from "./discord-forum-session.ts";

const FORUM_ID = "123456789012345678";
const THREAD_ID = "223456789012345678";

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
              type: ChannelType.PublicThread,
              thread: true,
              parentId: FORUM_ID,
              name: "Bitcoin // $BTC",
              archived: false,
              locked: false,
              appliedTags: tagIds,
            }),
            [FORUM_ID]: fakeChannel({
              id: FORUM_ID,
              type: ChannelType.GuildForum,
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
    ).rejects.toThrow(/not a Discord thread/);
  });

  it("rejects a thread whose parent cannot be fetched", async () => {
    await expect(
      inspectDiscordForumThread(
        fetcher(
          {
            [THREAD_ID]: fakeChannel({
              id: THREAD_ID,
              type: ChannelType.PublicThread,
              thread: true,
              parentId: FORUM_ID,
            }),
          },
          [],
        ),
        THREAD_ID,
      ),
    ).rejects.toThrow(/parent channel .* was not found/);
  });

  it("rejects a thread owned by a non-forum parent", async () => {
    await expect(
      inspectDiscordForumThread(
        fetcher(
          {
            [THREAD_ID]: fakeChannel({
              id: THREAD_ID,
              type: ChannelType.PublicThread,
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

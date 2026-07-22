import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Channel,
} from "discord.js";

import type {
  DiscordAssetThreadFacts,
  DiscordAssetThreadInspector,
} from "../application/adopt-discord-asset-thread.ts";

export type DiscordChannelFetcher = (
  channelId: string,
) => Promise<Channel | null>;

export interface DiscordForumSession {
  readonly inspectThread:
    DiscordAssetThreadInspector;
  close(): Promise<void>;
}

/**
 * Inspect one Discord channel as an existing forum thread.
 *
 * The operation is read-only. It fetches the candidate thread and its parent,
 * verifies that the parent is a Guild Forum channel, and returns only the
 * adoption facts needed by the application layer.
 */
export async function inspectDiscordForumThread(
  fetchChannel: DiscordChannelFetcher,
  threadId: string,
): Promise<DiscordAssetThreadFacts | null> {
  const candidate = await fetchChannel(threadId);

  if (candidate === null) {
    return null;
  }

  if (candidate.id !== threadId) {
    throw new Error(
      `Discord returned channel "${candidate.id}" for requested "${threadId}"`,
    );
  }

  if (!candidate.isThread()) {
    throw new Error(
      `channel ${threadId} is not a Discord thread`,
    );
  }

  if (candidate.parentId === null) {
    throw new Error(
      `thread ${threadId} has no parent channel`,
    );
  }

  const parent = await fetchChannel(
    candidate.parentId,
  );

  if (parent === null) {
    throw new Error(
      `parent channel ${candidate.parentId} was not found`,
    );
  }

  if (parent.type !== ChannelType.GuildForum) {
    throw new Error(
      `thread ${threadId} is not owned by a Discord forum channel`,
    );
  }

  return Object.freeze({
    threadId: candidate.id,
    parentId: candidate.parentId,
    name: candidate.name,
    archived: candidate.archived,
    locked: candidate.locked,
    appliedTagIds: Object.freeze([
      ...candidate.appliedTags,
    ]),
  });
}

/**
 * Open one read-only Discord forum inspection session.
 *
 * Login is completed before the session is returned. Call close() in a
 * finally block so the gateway socket is always destroyed.
 */
export async function openDiscordForumSession():
Promise<DiscordForumSession> {
  const token = process.env.DISCORD_BOT_TOKEN;

  if (!token || token.trim().length === 0) {
    throw new Error(
      "DISCORD_BOT_TOKEN is not set in .env",
    );
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  try {
    const ready = new Promise<void>((resolve) => {
      client.once(
        Events.ClientReady,
        () => resolve(),
      );
    });

    await client.login(token);
    await ready;
  } catch (error) {
    await client.destroy().catch(() => undefined);
    throw error;
  }

  const fetchChannel: DiscordChannelFetcher =
    async (channelId) =>
      client.channels.fetch(channelId);

  return Object.freeze({
    inspectThread:
      async (threadId: string) =>
        inspectDiscordForumThread(
          fetchChannel,
          threadId,
        ),

    async close(): Promise<void> {
      await client.destroy();
    },
  });
}

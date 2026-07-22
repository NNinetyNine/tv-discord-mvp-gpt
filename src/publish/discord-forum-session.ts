import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Channel,
  type ForumThreadChannel,
} from "discord.js";

import type {
  DiscordAssetThreadFacts,
  DiscordAssetThreadInspector,
} from "../application/adopt-discord-asset-thread.ts";
import type {
  DiscordAssetThreadCreateInput,
  DiscordAssetThreadCreator,
  DiscordAssetThreadDeleter,
} from "../application/provision-discord-asset-thread.ts";

export type DiscordChannelFetcher = (
  channelId: string,
) => Promise<Channel | null>;

export interface DiscordForumSession {
  readonly inspectThread:
    DiscordAssetThreadInspector;
  close(): Promise<void>;
}

export interface DiscordForumProvisioningOperations {
  readonly createThread:
    DiscordAssetThreadCreator;
  readonly deleteThread:
    DiscordAssetThreadDeleter;
}

export interface DiscordForumProvisioningSession
  extends DiscordForumSession,
    DiscordForumProvisioningOperations {}

export interface DiscordForumTagFacts {
  readonly id: string;
  readonly name: string;
  readonly moderated: boolean;
}

export interface DiscordForumFacts {
  readonly forumChannelId: string;
  readonly name: string;
  readonly availableTags: readonly DiscordForumTagFacts[];
}

export type DiscordForumInspector = (
  forumChannelId: string,
) => Promise<DiscordForumFacts>;

export interface DiscordForumAdministrationSession
  extends DiscordForumProvisioningSession {
  readonly inspectForum: DiscordForumInspector;
}

interface ThreadFactSource {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly archived: boolean | null;
  readonly locked: boolean | null;
  readonly appliedTags: readonly string[];
}

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function threadFacts(
  thread: ThreadFactSource,
): DiscordAssetThreadFacts {
  return Object.freeze({
    threadId: thread.id,
    parentId: thread.parentId,
    name: thread.name,
    archived: thread.archived,
    locked: thread.locked,
    appliedTagIds: Object.freeze([
      ...thread.appliedTags,
    ]),
  });
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

  return threadFacts(candidate);
}

/** Fetch current forum identity and selectable tag facts without mutation. */
export async function inspectDiscordForum(
  fetchChannel: DiscordChannelFetcher,
  forumChannelId: string,
): Promise<DiscordForumFacts> {
  const candidate = await fetchChannel(forumChannelId);
  if (candidate === null) {
    throw new Error(`forum channel ${forumChannelId} was not found or is not visible to the bot`);
  }
  if (candidate.id !== forumChannelId) {
    throw new Error(`Discord returned channel "${candidate.id}" for requested forum "${forumChannelId}"`);
  }
  if (candidate.type !== ChannelType.GuildForum) {
    throw new Error(`channel ${forumChannelId} is not a Discord forum channel`);
  }
  return Object.freeze({
    forumChannelId,
    name: candidate.name,
    availableTags: Object.freeze(candidate.availableTags.map((tag) => Object.freeze({
      id: tag.id,
      name: tag.name,
      moderated: tag.moderated,
    }))),
  });
}

/**
 * Build provisioning operations around one Discord channel fetcher.
 *
 * Compensation is deliberately confined to threads created through this exact
 * operations instance. deleteThread() refuses every unrelated thread ID.
 */
export function buildDiscordForumProvisioningOperations(
  fetchChannel: DiscordChannelFetcher,
): DiscordForumProvisioningOperations {
  const provisionalThreads =
    new Map<string, ForumThreadChannel>();

  const createThread:
  DiscordAssetThreadCreator =
    async (
      input: DiscordAssetThreadCreateInput,
    ) => {
      const candidate = await fetchChannel(
        input.forumChannelId,
      );

      if (candidate === null) {
        throw new Error(
          `forum channel ${input.forumChannelId} was not found or is not visible to the bot`,
        );
      }

      if (
        candidate.id !==
        input.forumChannelId
      ) {
        throw new Error(
          `Discord returned channel "${candidate.id}" for requested forum "${input.forumChannelId}"`,
        );
      }

      if (
        candidate.type !==
        ChannelType.GuildForum
      ) {
        throw new Error(
          `channel ${input.forumChannelId} is not a Discord forum channel`,
        );
      }

      const availableTagIds = new Set(
        candidate.availableTags.map(
          (tag) => tag.id,
        ),
      );

      for (
        const tagId of input.appliedTagIds
      ) {
        if (!availableTagIds.has(tagId)) {
          throw new Error(
            `tag ${tagId} is not available in forum ${input.forumChannelId}`,
          );
        }
      }

      const thread =
        await candidate.threads.create({
          name: input.title,
          appliedTags: [
            ...input.appliedTagIds,
          ],
          message: {
            files: [
              {
                attachment: Buffer.from(
                  input.starterLogoBytes,
                ),
                name:
                  input.starterLogoFilename,
              },
            ],
          },
        });

      if (
        thread.parentId !==
        input.forumChannelId
      ) {
        let cleanupDetail:
          string | undefined;

        try {
          await thread.delete(
            "VisionX rejected an invalid provisioning result",
          );
        } catch (error) {
          cleanupDetail = errorDetail(error);
        }

        throw new Error(
          [
            `Discord created thread ${thread.id} under parent ${String(thread.parentId)}, not requested forum ${input.forumChannelId}`,
            cleanupDetail === undefined
              ? "the invalid thread was deleted"
              : `the invalid thread could not be deleted: ${cleanupDetail}`,
          ].join("; "),
        );
      }

      provisionalThreads.set(
        thread.id,
        thread,
      );

      return threadFacts(thread);
    };

  const deleteThread:
  DiscordAssetThreadDeleter =
    async (threadId: string) => {
      const thread =
        provisionalThreads.get(threadId);

      if (thread === undefined) {
        throw new Error(
          `refusing to delete thread ${threadId}: it was not created by this provisioning session`,
        );
      }

      await thread.delete(
        "VisionX provisioning compensation after binding failure",
      );

      provisionalThreads.delete(threadId);
    };

  return Object.freeze({
    createThread,
    deleteThread,
  });
}

/**
 * Open one Discord forum session.
 *
 * Login is completed before the session is returned. Adoption inspection is
 * read-only. Provisioning creation is explicit, and compensation can delete
 * only threads created through this same session.
 */
export async function openDiscordForumSession():
Promise<DiscordForumAdministrationSession> {
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
    await client.destroy().catch(
      () => undefined,
    );
    throw error;
  }

  const fetchChannel: DiscordChannelFetcher =
    async (channelId) =>
      client.channels.fetch(channelId);

  const provisioning =
    buildDiscordForumProvisioningOperations(
      fetchChannel,
    );

  return Object.freeze({
    inspectForum:
      async (forumChannelId: string) =>
        inspectDiscordForum(
          fetchChannel,
          forumChannelId,
        ),

    inspectThread:
      async (threadId: string) =>
        inspectDiscordForumThread(
          fetchChannel,
          threadId,
        ),

    createThread:
      provisioning.createThread,

    deleteThread:
      provisioning.deleteThread,

    async close(): Promise<void> {
      await client.destroy();
    },
  });
}

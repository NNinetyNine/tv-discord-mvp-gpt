import { Client, GatewayIntentBits, AttachmentBuilder, Events } from "discord.js";

import { logger } from "../logger.ts";

/**
 * Session-scoped Discord publisher: open once (login), post many times (each
 * returning the Discord message identity), close explicitly. Built for pack
 * publishes of N charts — one gateway login for the whole release, not one per
 * chart (71 rapid logins would invite the rate-limit interruptions the release
 * lifecycle exists to survive).
 *
 * This is a NEW adapter with a different shape from the legacy per-call
 * publish() in discord.ts, which remains untouched (its consumers are the
 * legacy runtime and post-fixture.ts). The Publisher type in types.ts is not
 * modified.
 *
 * open fails fast and completely: a bad token or dead network produces a clean
 * throw with ZERO side effects — callers open the session BEFORE creating any
 * durable release state. Channels are fetched once and cached per channelId.
 * close() must always be called (callers use finally); it tears down the
 * gateway socket so the process can exit.
 */

export interface PublisherSession {
  /** Post one image; resolves with the Discord message identity. */
  post(channelId: string, imagePath: string): Promise<{ messageId: string }>;
  /** Tear down the gateway socket. Always call (finally). Idempotent-safe. */
  close(): Promise<void>;
}

export async function openPublisherSession(): Promise<PublisherSession> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error("DISCORD_BOT_TOKEN is not set in .env");
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    const ready = new Promise<void>((resolve) => {
      client.once(Events.ClientReady, () => resolve());
    });
    await client.login(token);
    await ready;
  } catch (e) {
    // Fail completely: never hand back a half-open session.
    await client.destroy().catch(() => {});
    throw e;
  }

  const channelCache = new Map<string, { send: (o: object) => Promise<{ id: string }> }>();

  async function textChannel(channelId: string) {
    const cached = channelCache.get(channelId);
    if (cached) return cached;
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`channel ${channelId} not found (or bot cannot see it)`);
    }
    if (!channel.isTextBased() || !("send" in channel)) {
      throw new Error(`channel ${channelId} is not a text channel that accepts messages`);
    }
    const sendable = channel as unknown as { send: (o: object) => Promise<{ id: string }> };
    channelCache.set(channelId, sendable);
    return sendable;
  }

  return {
    async post(channelId: string, imagePath: string): Promise<{ messageId: string }> {
      const channel = await textChannel(channelId);
      const attachment = new AttachmentBuilder(imagePath, { name: "chart.png" });
      const message = await channel.send({ files: [attachment] });
      logger.debug({ channelId, messageId: message.id }, "discord session post ok");
      return { messageId: message.id };
    },

    async close(): Promise<void> {
      await client.destroy();
    },
  };
}
import { Client, GatewayIntentBits, AttachmentBuilder, Events } from "discord.js";

import type { Publisher } from "../types.ts";
import { logger } from "../logger.ts";

/**
 * Day 2: real Discord publish.
 *
 * For the single-ticker MVP this logs in, posts, and tears the client down
 * on every call — fully self-contained, no shared global state, and the
 * process exits cleanly because the gateway socket is closed before the
 * promise resolves.
 *
 * KNOWN DEBT (fix when multi-ticker matters): re-logging in per publish is
 * wasteful at N tickers. When we loop over many tickers we'll hoist the client
 * into a shared, logged-in-once instance with an explicit shutdown. The
 * Publisher signature does not change when we do that.
 */
export const publish: Publisher = async (imagePath, channelId): Promise<void> => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error("DISCORD_BOT_TOKEN is not set in .env");
  }

  // Only the Guilds intent is needed to post an attachment to a channel.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    // Wait until the gateway is READY before touching channels.
    const ready = new Promise<void>((resolve) => {
      client.once(Events.ClientReady, () => resolve());
    });
    await client.login(token);
    await ready;

    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`channel ${channelId} not found (or bot cannot see it)`);
    }
    if (!channel.isTextBased() || !("send" in channel)) {
      throw new Error(`channel ${channelId} is not a text channel that accepts messages`);
    }

    const attachment = new AttachmentBuilder(imagePath, { name: "chart.png" });
    const message = await channel.send({ files: [attachment] });

    logger.debug({ channelId, messageId: message.id }, "discord publish ok");
  } finally {
    // Always close the socket so the process can exit and we leak nothing.
    await client.destroy();
  }
};
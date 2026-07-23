import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type ForumChannel,
  type GuildMember,
} from "discord.js";

export const DISCORD_SERVER_REQUIRED_PERMISSIONS = Object.freeze([
  "viewChannel",
  "sendMessages",
  "sendMessagesInThreads",
  "createPublicThreads",
  "manageThreads",
  "attachFiles",
  "readMessageHistory",
] as const);

export type DiscordServerPermissionName =
  (typeof DISCORD_SERVER_REQUIRED_PERMISSIONS)[number];

export interface DiscordServerBotFacts {
  readonly userId: string;
  readonly username: string;
}

export interface DiscordServerForumTagFacts {
  readonly id: string;
  readonly name: string;
  readonly moderated: boolean;
}

export interface DiscordServerRouteFacts {
  readonly channelId: string;
  readonly channelName: string;
  readonly channelType: "guild_forum";
  readonly guildId: string;
  readonly guildName: string;
  readonly availableTagCount: number;
  readonly availableTags: readonly DiscordServerForumTagFacts[];
  readonly roleNames: readonly string[];
  readonly permissions: Readonly<Record<DiscordServerPermissionName, boolean>>;
  readonly missingPermissions: readonly DiscordServerPermissionName[];
}

export interface DiscordServerAdministrationSession {
  readonly bot: DiscordServerBotFacts;
  inspectForum(channelId: string): Promise<DiscordServerRouteFacts>;
  close(): Promise<void>;
}

function permissionFacts(channel: ForumChannel, member: GuildMember): {
  readonly permissions: Readonly<Record<DiscordServerPermissionName, boolean>>;
  readonly missingPermissions: readonly DiscordServerPermissionName[];
  readonly roleNames: readonly string[];
} {
  const resolved = channel.permissionsFor(member);
  if (resolved === null) {
    throw new Error(`bot permissions for forum ${channel.id} are unavailable`);
  }
  const permissions = Object.freeze({
    viewChannel: resolved.has(PermissionFlagsBits.ViewChannel),
    sendMessages: resolved.has(PermissionFlagsBits.SendMessages),
    sendMessagesInThreads: resolved.has(PermissionFlagsBits.SendMessagesInThreads),
    createPublicThreads: resolved.has(PermissionFlagsBits.CreatePublicThreads),
    manageThreads: resolved.has(PermissionFlagsBits.ManageThreads),
    attachFiles: resolved.has(PermissionFlagsBits.AttachFiles),
    readMessageHistory: resolved.has(PermissionFlagsBits.ReadMessageHistory),
  });
  return Object.freeze({
    permissions,
    missingPermissions: Object.freeze(
      DISCORD_SERVER_REQUIRED_PERMISSIONS.filter((name) => !permissions[name]),
    ),
    roleNames: Object.freeze(
      [...member.roles.cache.values()]
        .filter((role) => role.id !== channel.guild.id)
        .map((role) => role.name)
        .sort((left, right) => left.localeCompare(right, "en")),
    ),
  });
}

export async function openDiscordServerAdministrationSession():
Promise<DiscordServerAdministrationSession> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error("DISCORD_BOT_TOKEN is not set in the Administration process environment");
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const ready = new Promise<void>((resolve) => {
      client.once(Events.ClientReady, () => resolve());
    });
    await client.login(token);
    await ready;
  } catch (error) {
    await client.destroy().catch(() => undefined);
    throw error;
  }

  if (client.user === null) {
    await client.destroy().catch(() => undefined);
    throw new Error("Discord client became ready without a bot identity");
  }

  const bot = Object.freeze({
    userId: client.user.id,
    username: client.user.username,
  });

  return Object.freeze({
    bot,
    async inspectForum(channelId: string): Promise<DiscordServerRouteFacts> {
      const channel = await client.channels.fetch(channelId);
      if (channel === null) {
        throw new Error(`forum channel ${channelId} was not found or is not visible to the bot`);
      }
      if (channel.id !== channelId) {
        throw new Error(`Discord returned channel ${channel.id} for requested forum ${channelId}`);
      }
      if (channel.type !== ChannelType.GuildForum) {
        throw new Error(`channel ${channelId} is not a Discord forum channel`);
      }
      const member = channel.guild.members.me ?? await channel.guild.members.fetchMe();
      const facts = permissionFacts(channel, member);
      return Object.freeze({
        channelId,
        channelName: channel.name,
        channelType: "guild_forum" as const,
        guildId: channel.guild.id,
        guildName: channel.guild.name,
        availableTagCount: channel.availableTags.length,
        availableTags: Object.freeze(
          channel.availableTags
            .map((tag) => Object.freeze({ id: tag.id, name: tag.name, moderated: tag.moderated }))
            .sort((left, right) => left.name.localeCompare(right.name, "en")),
        ),
        roleNames: facts.roleNames,
        permissions: facts.permissions,
        missingPermissions: facts.missingPermissions,
      });
    },
    async close(): Promise<void> {
      await client.destroy();
    },
  });
}

import type { Pack } from "../packs/packs.ts";
import type { ChannelResolver } from "../wiring/channels.ts";

const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/u;

/**
 * Read-only Discord facts needed to adopt an existing forum post.
 *
 * Adoption deliberately preserves every Discord-owned property: title, tags,
 * archive/lock state, starter message, and message history are observed only.
 */
export interface DiscordAssetThreadFacts {
  readonly threadId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly archived: boolean | null;
  readonly locked: boolean | null;
  readonly appliedTagIds: readonly string[];
}

export type DiscordAssetThreadInspector = (
  threadId: string,
) => Promise<DiscordAssetThreadFacts | null>;

export interface AssetThreadBindingWriteResult {
  readonly changed: boolean;
}

export type AssetThreadBindingWriter = (
  packId: string,
  assetId: string,
  threadId: string,
) => Promise<AssetThreadBindingWriteResult>;

export interface AdoptDiscordAssetThreadDeps {
  readonly packs: readonly Pack[];
  readonly resolveChannel: ChannelResolver;
  readonly inspectThread: DiscordAssetThreadInspector;
  readonly bindThread: AssetThreadBindingWriter;
}

export type AdoptDiscordAssetThreadResult =
  | {
      readonly ok: true;
      readonly outcome:
        | "adopted"
        | "already_adopted";
      readonly packId: string;
      readonly assetId: string;
      readonly forumChannelId: string;
      readonly thread: DiscordAssetThreadFacts;
    }
  | {
      readonly ok: false;
      readonly outcome: "invalid_thread_id";
      readonly threadId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "unknown_pack";
      readonly packId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "asset_not_in_pack";
      readonly packId: string;
      readonly assetId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "forum_channel_unresolved";
      readonly packId: string;
      readonly channelName: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "thread_not_found";
      readonly packId: string;
      readonly assetId: string;
      readonly threadId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "thread_parent_mismatch";
      readonly packId: string;
      readonly assetId: string;
      readonly threadId: string;
      readonly expectedForumChannelId: string;
      readonly actualParentId: string | null;
    }
  | {
      readonly ok: false;
      readonly outcome: "discord_inspection_failed";
      readonly packId: string;
      readonly assetId: string;
      readonly threadId: string;
      readonly detail: string;
    };

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

/**
 * Adopt one existing Discord forum post as the persistent thread for a
 * canonical Pack/Asset pair.
 *
 * All canonical and Discord destination checks complete before the binding
 * writer is invoked. The inspector is read-only; this use case never edits the
 * Discord post or its starter message.
 */
export async function adoptDiscordAssetThread(
  deps: AdoptDiscordAssetThreadDeps,
  packId: string,
  assetId: string,
  threadId: string,
): Promise<AdoptDiscordAssetThreadResult> {
  if (!DISCORD_SNOWFLAKE.test(threadId)) {
    return {
      ok: false,
      outcome: "invalid_thread_id",
      threadId,
    };
  }

  const pack =
    deps.packs.find((candidate) =>
      candidate.id === packId,
    ) ?? null;

  if (pack === null) {
    return {
      ok: false,
      outcome: "unknown_pack",
      packId,
    };
  }

  if (!pack.assets.includes(assetId)) {
    return {
      ok: false,
      outcome: "asset_not_in_pack",
      packId,
      assetId,
    };
  }

  const forumChannelId =
    deps.resolveChannel(pack.channel);

  if (forumChannelId === null) {
    return {
      ok: false,
      outcome: "forum_channel_unresolved",
      packId,
      channelName: pack.channel,
    };
  }

  let thread: DiscordAssetThreadFacts | null;

  try {
    thread = await deps.inspectThread(threadId);
  } catch (error) {
    return {
      ok: false,
      outcome: "discord_inspection_failed",
      packId,
      assetId,
      threadId,
      detail: errorDetail(error),
    };
  }

  if (thread === null) {
    return {
      ok: false,
      outcome: "thread_not_found",
      packId,
      assetId,
      threadId,
    };
  }

  if (thread.threadId !== threadId) {
    throw new Error(
      `internal: Discord inspector returned thread "${thread.threadId}" for requested "${threadId}"`,
    );
  }

  if (thread.parentId !== forumChannelId) {
    return {
      ok: false,
      outcome: "thread_parent_mismatch",
      packId,
      assetId,
      threadId,
      expectedForumChannelId: forumChannelId,
      actualParentId: thread.parentId,
    };
  }

  const binding = await deps.bindThread(
    packId,
    assetId,
    threadId,
  );

  return {
    ok: true,
    outcome: binding.changed
      ? "adopted"
      : "already_adopted",
    packId,
    assetId,
    forumChannelId,
    thread,
  };
}

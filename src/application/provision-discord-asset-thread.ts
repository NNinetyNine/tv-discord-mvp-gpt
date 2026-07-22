import type {
  CanonicalAssetLogo,
} from "../assets/asset-logo-file.ts";
import type {
  Pack,
} from "../packs/packs.ts";
import type {
  Asset,
} from "../types.ts";
import type {
  AssetThreadResolver,
} from "../wiring/asset-threads.ts";
import type {
  ChannelResolver,
} from "../wiring/channels.ts";
import type {
  AssetThreadBindingWriter,
  DiscordAssetThreadFacts,
} from "./adopt-discord-asset-thread.ts";

const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface ProvisionDiscordAssetThreadInput {
  readonly packId: string;
  readonly assetId: string;
  /**
   * Explicit operator-owned Discord forum-post title.
   *
   * This is never inferred from Asset metadata.
   */
  readonly title: string;
  /** Optional Discord forum tag IDs, selected explicitly by the operator. */
  readonly appliedTagIds: readonly string[];
  readonly logo: CanonicalAssetLogo;
}

export interface DiscordAssetThreadCreateInput {
  readonly forumChannelId: string;
  readonly title: string;
  readonly appliedTagIds: readonly string[];
  readonly starterLogoBytes: Buffer;
  readonly starterLogoFilename: string;
}

export type DiscordAssetThreadCreator = (
  input: DiscordAssetThreadCreateInput,
) => Promise<DiscordAssetThreadFacts>;

export type DiscordAssetThreadDeleter = (
  threadId: string,
) => Promise<void>;

export interface ProvisionDiscordAssetThreadDeps {
  readonly packs: readonly Pack[];
  readonly assets: readonly Asset[];
  readonly resolveChannel: ChannelResolver;
  readonly resolveThread: AssetThreadResolver;
  readonly createThread: DiscordAssetThreadCreator;
  readonly bindThread: AssetThreadBindingWriter;
  /**
   * Compensation for a newly created provisional thread when durable binding
   * fails. The resulting outcome always states whether deletion succeeded.
   */
  readonly deleteThread: DiscordAssetThreadDeleter;
}

export type ProvisionDiscordAssetThreadResult =
  | {
      readonly ok: true;
      readonly outcome: "provisioned";
      readonly packId: string;
      readonly assetId: string;
      readonly forumChannelId: string;
      readonly thread: DiscordAssetThreadFacts;
    }
  | {
      readonly ok: false;
      readonly outcome: "invalid_title";
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly outcome:
        | "invalid_tag_id"
        | "duplicate_tag_id";
      readonly tagId: string;
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
      readonly outcome: "unknown_asset";
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
      readonly outcome: "already_bound";
      readonly packId: string;
      readonly assetId: string;
      readonly threadId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "discord_provision_failed";
      readonly packId: string;
      readonly assetId: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "binding_failed_thread_deleted";
      readonly packId: string;
      readonly assetId: string;
      readonly thread: DiscordAssetThreadFacts;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "binding_failed_thread_retained";
      readonly packId: string;
      readonly assetId: string;
      readonly thread: DiscordAssetThreadFacts;
      readonly detail: string;
      readonly cleanupDetail: string;
    };

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function validateTitle(
  title: string,
): string | null {
  if (title.length === 0) {
    return "Discord thread title must not be empty.";
  }

  if (title.trim().length === 0) {
    return "Discord thread title must contain visible characters.";
  }

  if (title !== title.trim()) {
    return "Discord thread title must not contain leading or trailing whitespace.";
  }

  if (CONTROL_CHARACTER.test(title)) {
    return "Discord thread title must not contain control characters.";
  }

  return null;
}

function validateTags(
  tagIds: readonly string[],
):
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly outcome:
        | "invalid_tag_id"
        | "duplicate_tag_id";
      readonly tagId: string;
    } {
  const seen = new Set<string>();

  for (const tagId of tagIds) {
    if (!DISCORD_SNOWFLAKE.test(tagId)) {
      return {
        ok: false,
        outcome: "invalid_tag_id",
        tagId,
      };
    }

    if (seen.has(tagId)) {
      return {
        ok: false,
        outcome: "duplicate_tag_id",
        tagId,
      };
    }

    seen.add(tagId);
  }

  return { ok: true };
}

/**
 * Provision one new Discord forum post for a canonical Pack/Asset pair.
 *
 * Every local preflight completes before Discord creation:
 * - explicit title and tags are valid;
 * - Pack and Asset exist;
 * - the Asset belongs to the Pack;
 * - the Pack forum is provisioned;
 * - the composite identity has no existing thread binding.
 *
 * After Discord creation, durable binding is attempted. A binding failure
 * triggers explicit compensation of only the newly created provisional thread.
 */
export async function provisionDiscordAssetThread(
  deps: ProvisionDiscordAssetThreadDeps,
  input: ProvisionDiscordAssetThreadInput,
): Promise<ProvisionDiscordAssetThreadResult> {
  const titleFailure = validateTitle(
    input.title,
  );

  if (titleFailure !== null) {
    return {
      ok: false,
      outcome: "invalid_title",
      detail: titleFailure,
    };
  }

  const tags = validateTags(
    input.appliedTagIds,
  );

  if (!tags.ok) {
    return tags;
  }

  const pack =
    deps.packs.find(
      (candidate) =>
        candidate.id === input.packId,
    ) ?? null;

  if (pack === null) {
    return {
      ok: false,
      outcome: "unknown_pack",
      packId: input.packId,
    };
  }

  if (!pack.assets.includes(input.assetId)) {
    return {
      ok: false,
      outcome: "asset_not_in_pack",
      packId: input.packId,
      assetId: input.assetId,
    };
  }

  const asset =
    deps.assets.find(
      (candidate) =>
        candidate.id === input.assetId,
    ) ?? null;

  if (asset === null) {
    return {
      ok: false,
      outcome: "unknown_asset",
      assetId: input.assetId,
    };
  }

  const forumChannelId =
    deps.resolveChannel(pack.channel);

  if (forumChannelId === null) {
    return {
      ok: false,
      outcome: "forum_channel_unresolved",
      packId: input.packId,
      channelName: pack.channel,
    };
  }

  const existingThreadId =
    deps.resolveThread(
      input.packId,
      input.assetId,
    );

  if (existingThreadId !== null) {
    return {
      ok: false,
      outcome: "already_bound",
      packId: input.packId,
      assetId: input.assetId,
      threadId: existingThreadId,
    };
  }

  let thread: DiscordAssetThreadFacts;

  try {
    thread = await deps.createThread({
      forumChannelId,
      title: input.title,
      appliedTagIds: Object.freeze([
        ...input.appliedTagIds,
      ]),
      starterLogoBytes: input.logo.bytes,
      starterLogoFilename:
        `${asset.id}.png`,
    });
  } catch (error) {
    return {
      ok: false,
      outcome: "discord_provision_failed",
      packId: input.packId,
      assetId: input.assetId,
      detail: errorDetail(error),
    };
  }

  if (
    !DISCORD_SNOWFLAKE.test(thread.threadId) ||
    thread.parentId !== forumChannelId
  ) {
    throw new Error(
      `internal: Discord provisioner returned thread "${thread.threadId}" with parent "${String(thread.parentId)}" for forum "${forumChannelId}"`,
    );
  }

  try {
    await deps.bindThread(
      input.packId,
      input.assetId,
      thread.threadId,
    );
  } catch (error) {
    const detail = errorDetail(error);

    try {
      await deps.deleteThread(
        thread.threadId,
      );

      return {
        ok: false,
        outcome:
          "binding_failed_thread_deleted",
        packId: input.packId,
        assetId: input.assetId,
        thread,
        detail,
      };
    } catch (cleanupError) {
      return {
        ok: false,
        outcome:
          "binding_failed_thread_retained",
        packId: input.packId,
        assetId: input.assetId,
        thread,
        detail,
        cleanupDetail:
          errorDetail(cleanupError),
      };
    }
  }

  return {
    ok: true,
    outcome: "provisioned",
    packId: input.packId,
    assetId: input.assetId,
    forumChannelId,
    thread,
  };
}

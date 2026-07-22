import type { Pack } from "../packs/packs.ts";
import type { AssetThreadResolver } from "../wiring/asset-threads.ts";
import type { ChannelResolver } from "../wiring/channels.ts";
import type {
  DiscordAssetThreadFacts,
  DiscordAssetThreadInspector,
} from "./adopt-discord-asset-thread.ts";

const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/u;

export type PackThreadRoutingIssue =
  | "thread_not_found"
  | "thread_identity_mismatch"
  | "thread_parent_mismatch"
  | "thread_archived"
  | "thread_archive_state_unknown"
  | "thread_locked"
  | "thread_lock_state_unknown";

export interface PackThreadRoutingInspection {
  readonly assetId: string;
  readonly threadId: string;
  readonly name: string | null;
  readonly archived: boolean | null;
  readonly locked: boolean | null;
  readonly appliedTagCount: number;
  readonly issues: readonly PackThreadRoutingIssue[];
}

export interface VerifyPackDiscordThreadRoutingDeps {
  readonly packs: readonly Pack[];
  readonly resolveChannel: ChannelResolver;
  readonly resolveThread: AssetThreadResolver;
  readonly inspectThread: DiscordAssetThreadInspector;
}

export type VerifyPackDiscordThreadRoutingResult =
  | {
      readonly ok: true;
      readonly outcome: "ready";
      readonly packId: string;
      readonly forumChannelId: string;
      readonly inspections: readonly PackThreadRoutingInspection[];
    }
  | {
      readonly ok: false;
      readonly outcome: "unknown_pack";
      readonly packId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "forum_channel_unresolved";
      readonly packId: string;
      readonly channelName: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "missing_bindings";
      readonly packId: string;
      readonly missingAssetIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly outcome: "invalid_binding";
      readonly packId: string;
      readonly assetId: string;
      readonly threadId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "duplicate_binding";
      readonly packId: string;
      readonly assetId: string;
      readonly priorAssetId: string;
      readonly threadId: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "discord_inspection_failed";
      readonly packId: string;
      readonly assetId: string;
      readonly threadId: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "thread_issues";
      readonly packId: string;
      readonly forumChannelId: string;
      readonly inspections: readonly PackThreadRoutingInspection[];
    };

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspection(
  assetId: string,
  threadId: string,
  forumChannelId: string,
  facts: DiscordAssetThreadFacts | null,
): PackThreadRoutingInspection {
  if (facts === null) {
    return Object.freeze({
      assetId,
      threadId,
      name: null,
      archived: null,
      locked: null,
      appliedTagCount: 0,
      issues: Object.freeze(["thread_not_found"] as const),
    });
  }

  const issues: PackThreadRoutingIssue[] = [];
  if (facts.threadId !== threadId) issues.push("thread_identity_mismatch");
  if (facts.parentId !== forumChannelId) issues.push("thread_parent_mismatch");
  if (facts.archived === true) issues.push("thread_archived");
  else if (facts.archived === null) issues.push("thread_archive_state_unknown");
  if (facts.locked === true) issues.push("thread_locked");
  else if (facts.locked === null) issues.push("thread_lock_state_unknown");

  return Object.freeze({
    assetId,
    threadId,
    name: facts.name,
    archived: facts.archived,
    locked: facts.locked,
    appliedTagCount: facts.appliedTagIds.length,
    issues: Object.freeze(issues),
  });
}

/**
 * Verify every persistent destination for one Pack without mutating Discord.
 *
 * Missing, malformed, or duplicate local bindings fail before the first
 * inspection. Once local custody is complete, bound threads are inspected in
 * canonical Pack order and must remain in the configured forum, active, and
 * unlocked.
 */
export async function verifyPackDiscordThreadRouting(
  deps: VerifyPackDiscordThreadRoutingDeps,
  packId: string,
): Promise<VerifyPackDiscordThreadRoutingResult> {
  const pack = deps.packs.find((candidate) => candidate.id === packId) ?? null;
  if (pack === null) return { ok: false, outcome: "unknown_pack", packId };

  const forumChannelId = deps.resolveChannel(pack.channel);
  if (forumChannelId === null) {
    return { ok: false, outcome: "forum_channel_unresolved", packId, channelName: pack.channel };
  }

  const bindings = pack.assets.map((assetId) => Object.freeze({
    assetId,
    threadId: deps.resolveThread(pack.id, assetId),
  }));
  const missingAssetIds = bindings
    .filter((binding) => binding.threadId === null)
    .map((binding) => binding.assetId);
  if (missingAssetIds.length > 0) {
    return {
      ok: false,
      outcome: "missing_bindings",
      packId,
      missingAssetIds: Object.freeze(missingAssetIds),
    };
  }

  const seen = new Map<string, string>();
  for (const binding of bindings) {
    const threadId = binding.threadId as string;
    if (!DISCORD_SNOWFLAKE.test(threadId)) {
      return { ok: false, outcome: "invalid_binding", packId, assetId: binding.assetId, threadId };
    }
    const priorAssetId = seen.get(threadId);
    if (priorAssetId !== undefined) {
      return {
        ok: false,
        outcome: "duplicate_binding",
        packId,
        assetId: binding.assetId,
        priorAssetId,
        threadId,
      };
    }
    seen.set(threadId, binding.assetId);
  }

  const inspections: PackThreadRoutingInspection[] = [];
  for (const binding of bindings) {
    const threadId = binding.threadId as string;
    let facts: DiscordAssetThreadFacts | null;
    try {
      facts = await deps.inspectThread(threadId);
    } catch (error) {
      return {
        ok: false,
        outcome: "discord_inspection_failed",
        packId,
        assetId: binding.assetId,
        threadId,
        detail: errorDetail(error),
      };
    }
    inspections.push(inspection(binding.assetId, threadId, forumChannelId, facts));
  }

  const frozen = Object.freeze(inspections);
  if (inspections.some((item) => item.issues.length > 0)) {
    return { ok: false, outcome: "thread_issues", packId, forumChannelId, inspections: frozen };
  }
  return { ok: true, outcome: "ready", packId, forumChannelId, inspections: frozen };
}

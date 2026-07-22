import { describe, expect, it } from "vitest";

import type { DiscordAssetThreadFacts } from "./adopt-discord-asset-thread.ts";
import {
  verifyPackDiscordThreadRouting,
  type VerifyPackDiscordThreadRoutingDeps,
} from "./verify-pack-discord-thread-routing.ts";

const FORUM_ID = "1529334738454839349";
const THREADS = Object.freeze({
  akt: "1529999999999999991",
  btc: "1529999999999999992",
});
const PACKS = Object.freeze([
  Object.freeze({ id: "crypto", display: "Crypto", channel: "crypto", assets: Object.freeze(["akt", "btc"]) }),
]);

function facts(threadId: string, overrides: Partial<DiscordAssetThreadFacts> = {}): DiscordAssetThreadFacts {
  return Object.freeze({
    threadId,
    parentId: FORUM_ID,
    name: `Thread ${threadId}`,
    archived: false,
    locked: false,
    appliedTagIds: Object.freeze([]),
    ...overrides,
  });
}

function fixture(options: {
  readonly bindings?: Readonly<Record<string, string | null>>;
  readonly forumChannelId?: string | null;
  readonly inspect?: (threadId: string) => Promise<DiscordAssetThreadFacts | null>;
} = {}): { readonly deps: VerifyPackDiscordThreadRoutingDeps; readonly inspected: string[] } {
  const inspected: string[] = [];
  const bindings: Readonly<Record<string, string | null>> = options.bindings ?? THREADS;
  return {
    inspected,
    deps: {
      packs: PACKS,
      resolveChannel: () => options.forumChannelId === undefined ? FORUM_ID : options.forumChannelId,
      resolveThread: (_packId, assetId) => bindings[assetId] ?? null,
      inspectThread: async (threadId) => {
        inspected.push(threadId);
        return options.inspect === undefined ? facts(threadId) : options.inspect(threadId);
      },
    },
  };
}

describe("Pack Discord thread-routing verification", () => {
  it("verifies every bound thread in canonical Pack order", async () => {
    const target = fixture();
    await expect(verifyPackDiscordThreadRouting(target.deps, "crypto")).resolves.toEqual({
      ok: true,
      outcome: "ready",
      packId: "crypto",
      forumChannelId: FORUM_ID,
      inspections: [
        {
          assetId: "akt",
          threadId: THREADS.akt,
          name: `Thread ${THREADS.akt}`,
          archived: false,
          locked: false,
          appliedTagCount: 0,
          issues: [],
        },
        {
          assetId: "btc",
          threadId: THREADS.btc,
          name: `Thread ${THREADS.btc}`,
          archived: false,
          locked: false,
          appliedTagCount: 0,
          issues: [],
        },
      ],
    });
    expect(target.inspected).toEqual([THREADS.akt, THREADS.btc]);
  });

  it("rejects missing bindings before Discord inspection", async () => {
    const target = fixture({ bindings: { akt: THREADS.akt } });
    await expect(verifyPackDiscordThreadRouting(target.deps, "crypto")).resolves.toEqual({
      ok: false,
      outcome: "missing_bindings",
      packId: "crypto",
      missingAssetIds: ["btc"],
    });
    expect(target.inspected).toEqual([]);
  });

  it("rejects malformed and duplicate bindings before Discord inspection", async () => {
    const malformed = fixture({ bindings: { akt: "bad", btc: THREADS.btc } });
    await expect(verifyPackDiscordThreadRouting(malformed.deps, "crypto")).resolves.toMatchObject({
      ok: false,
      outcome: "invalid_binding",
      assetId: "akt",
      threadId: "bad",
    });
    expect(malformed.inspected).toEqual([]);

    const duplicate = fixture({ bindings: { akt: THREADS.akt, btc: THREADS.akt } });
    await expect(verifyPackDiscordThreadRouting(duplicate.deps, "crypto")).resolves.toMatchObject({
      ok: false,
      outcome: "duplicate_binding",
      assetId: "btc",
      priorAssetId: "akt",
      threadId: THREADS.akt,
    });
    expect(duplicate.inspected).toEqual([]);
  });

  it("fails locally for unknown Packs and unresolved forums", async () => {
    const unknown = fixture();
    await expect(verifyPackDiscordThreadRouting(unknown.deps, "missing")).resolves.toEqual({
      ok: false,
      outcome: "unknown_pack",
      packId: "missing",
    });
    expect(unknown.inspected).toEqual([]);

    const unresolved = fixture({ forumChannelId: null });
    await expect(verifyPackDiscordThreadRouting(unresolved.deps, "crypto")).resolves.toEqual({
      ok: false,
      outcome: "forum_channel_unresolved",
      packId: "crypto",
      channelName: "crypto",
    });
    expect(unresolved.inspected).toEqual([]);
  });

  it("reports all observable thread blockers without mutation", async () => {
    const target = fixture({
      inspect: async (threadId) => threadId === THREADS.akt
        ? null
        : facts("1529999999999999998", {
            parentId: "1528888888888888888",
            archived: true,
            locked: null,
          }),
    });
    const result = await verifyPackDiscordThreadRouting(target.deps, "crypto");
    expect(result).toMatchObject({ ok: false, outcome: "thread_issues", packId: "crypto" });
    if (result.outcome !== "thread_issues") throw new Error("expected thread issues");
    expect(result.inspections).toEqual([
      {
        assetId: "akt",
        threadId: THREADS.akt,
        name: null,
        archived: null,
        locked: null,
        appliedTagCount: 0,
        issues: ["thread_not_found"],
      },
      {
        assetId: "btc",
        threadId: THREADS.btc,
        name: `Thread 1529999999999999998`,
        archived: true,
        locked: null,
        appliedTagCount: 0,
        issues: [
          "thread_identity_mismatch",
          "thread_parent_mismatch",
          "thread_archived",
          "thread_lock_state_unknown",
        ],
      },
    ]);
  });

  it("stops and reports the exact Asset when Discord inspection fails", async () => {
    const target = fixture({
      inspect: async (threadId) => {
        if (threadId === THREADS.btc) throw new Error("gateway unavailable");
        return facts(threadId);
      },
    });
    await expect(verifyPackDiscordThreadRouting(target.deps, "crypto")).resolves.toMatchObject({
      ok: false,
      outcome: "discord_inspection_failed",
      assetId: "btc",
      threadId: THREADS.btc,
      detail: "gateway unavailable",
    });
    expect(target.inspected).toEqual([THREADS.akt, THREADS.btc]);
  });
});

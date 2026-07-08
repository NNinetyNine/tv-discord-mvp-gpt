import type { PackSession, PublishPlan } from "../packs/session.ts";
import type { StagingStore } from "./staging.ts";
import type { ChannelResolver } from "./channels.ts";
import type { ReleaseStore, ReleaseRecord } from "../release/release-store.ts";

/**
 * Pack publishing orchestration. Publishing a pack = producing a RELEASE: the
 * durable archived record of the complete pack thesis, with per-analysis
 * Discord message identities recorded incrementally as they are earned.
 *
 * Constitution rules enforced here:
 *  - COMPLETE-ONLY: an incomplete pack cannot be published (pack_incomplete).
 *    Partial publishing does not exist; there is no confirmation for it.
 *  - ARCHIVE-BEFORE-EXTERNAL: the release record + image custody are written
 *    (publishedAt: null — in flight) before any Discord post; the workspace
 *    (session) is reset ONLY on a fully published release.
 *  - HONEST INTERRUPTION: a failure mid-posting leaves an in-flight release
 *    record stating exactly which messages exist; the session does not
 *    advance and staging is kept.
 *  - SUPERSESSION (private policy, single consumer): a new publish for a pack
 *    with an unsuperseded interrupted release is REFUSED unless the operator
 *    explicitly chooses to supersede; publishing fresh is itself what retires
 *    the old record from "live" (its later startedAt outranks it) — the old
 *    record is never modified.
 *
 * Lifecycle is DERIVED, never stored: publishedAt === null means in flight
 * (or interrupted); publishedAt !== null means published.
 *
 * Ordering: the publisher session is OPENED before the release is created, so
 * a connection failure aborts with zero durable side effects.
 *
 * Time is metadata: all timestamps flow from the injected now(); nothing here
 * reads a clock directly.
 */

export interface PublisherSessionShape {
  post(channelId: string, imagePath: string): Promise<{ readonly messageId: string }>;
  close(): Promise<void>;
}

export interface PublishPackDeps {
  readonly session: PackSession; // persistent wrapper -> advance() auto-saves
  readonly staging: StagingStore;
  readonly releases: ReleaseStore;
  readonly resolveChannel: ChannelResolver;
  /** Opens a logged-in publisher session. Must fail fast with no side effects. */
  readonly openPublisher: () => Promise<PublisherSessionShape>;
  /** Display name for an asset id (registry-owned; injected honestly). */
  readonly assetDisplay: (assetId: string) => string;
  /** Timestamp source (ISO-8601). Injected: time is metadata, tests are deterministic. */
  readonly now: () => string;
}

export interface PublishOptions {
  /** Operator's explicit decision to publish fresh past an interrupted release. */
  readonly supersedeInterrupted: boolean;
}

export type PublishPackResult =
  | {
      readonly ok: true;
      readonly outcome: "published";
      readonly packId: string;
      readonly releaseId: string;
      readonly publishedAssetIds: readonly string[];
      readonly advanced: true;
      readonly cleared: boolean; // false if staging clear failed (non-fatal)
    }
  | { readonly ok: false; readonly outcome: "no_active_pack" }
  | {
      readonly ok: false;
      readonly outcome: "pack_incomplete";
      readonly packId: string;
      readonly captured: number;
      readonly total: number;
      readonly missingAssetIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly outcome: "interrupted_release_exists";
      readonly packId: string;
      readonly releaseId: string;
      readonly startedAt: string;
      readonly postedCount: number;
      readonly totalCount: number;
    }
  | { readonly ok: false; readonly outcome: "missing_staged_images"; readonly packId: string; readonly missing: readonly string[] }
  | { readonly ok: false; readonly outcome: "channel_unresolved"; readonly packId: string }
  | { readonly ok: false; readonly outcome: "publisher_connect_failed"; readonly packId: string; readonly detail: string }
  | {
      readonly ok: false;
      readonly outcome: "publish_interrupted";
      readonly packId: string;
      readonly releaseId: string;
      readonly publishedAssetIds: readonly string[];
      /** Null when the failure was not attributable to a single asset's post. */
      readonly failedAssetId: string | null;
      readonly detail: string;
    };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * PRIVATE supersession policy (single consumer; extract only when a second
 * real consumer exists). The interrupted release that still COUNTS is the
 * newest record overall, if and only if it is still in flight (publishedAt
 * null) — anything older was superseded by whatever started after it.
 * startedAt is read as an ordering FACT (metadata), never as identity.
 */
function findUnsupersededInterrupted(records: readonly ReleaseRecord[]): ReleaseRecord | null {
  let newest: ReleaseRecord | null = null;
  for (const r of records) {
    if (newest === null || r.startedAt > newest.startedAt) newest = r;
  }
  return newest !== null && newest.publishedAt === null ? newest : null;
}

export async function publishActivePack(
  deps: PublishPackDeps,
  options: PublishOptions,
): Promise<PublishPackResult> {
  const { session, staging, releases, resolveChannel, openPublisher, assetDisplay, now } = deps;

  // 1. Active pack.
  const active = session.activePack();
  if (active === null) {
    return { ok: false, outcome: "no_active_pack" };
  }
  const packId = active.id;

  // 2. COMPLETE-ONLY gate. An incomplete pack is not a publishable thing.
  const missingAssetIds = session.pendingAssets();
  if (missingAssetIds.length > 0) {
    return {
      ok: false,
      outcome: "pack_incomplete",
      packId,
      captured: active.assets.length - missingAssetIds.length,
      total: active.assets.length,
      missingAssetIds,
    };
  }

  // Complete pack -> the plan covers every asset in canonical order.
  const plan: PublishPlan = session.publishPack();

  // 3. Unsuperseded interrupted release? Refuse unless the operator supersedes.
  const interrupted = findUnsupersededInterrupted(releases.listReleases(packId));
  if (interrupted !== null && !options.supersedeInterrupted) {
    return {
      ok: false,
      outcome: "interrupted_release_exists",
      packId,
      releaseId: interrupted.releaseId,
      startedAt: interrupted.startedAt,
      postedCount: interrupted.analyses.filter((a) => a.discordMessageId !== null).length,
      totalCount: interrupted.analyses.length,
    };
  }

  // 4. Resolve every staged image ONCE into assetId -> path (fail closed).
  const stagedPaths = new Map<string, string>();
  const missing: string[] = [];
  for (const rec of plan.toPublish) {
    const staged = staging.get(packId, rec.assetId);
    if (staged === null) missing.push(rec.assetId);
    else stagedPaths.set(rec.assetId, staged.path);
  }
  if (missing.length > 0) {
    return { ok: false, outcome: "missing_staged_images", packId, missing };
  }

  /** The one lookup of the truth resolved in step 4; absence here is a bug. */
  const stagedPath = (assetId: string): string => {
    const path = stagedPaths.get(assetId);
    if (path === undefined) {
      throw new Error(`internal: no staged path resolved for "${assetId}"`);
    }
    return path;
  };

  // 5. Channel.
  const channelId = resolveChannel(packId);
  if (channelId === null) {
    return { ok: false, outcome: "channel_unresolved", packId };
  }

  // 6. Open the publisher BEFORE creating durable state: a connect failure
  //    must leave zero side effects (no in-flight release to refuse on).
  let publisher: PublisherSessionShape;
  try {
    publisher = await openPublisher();
  } catch (e) {
    return { ok: false, outcome: "publisher_connect_failed", packId, detail: errMsg(e) };
  }

  let releaseId: string;
  const publishedAssetIds: string[] = [];
  try {
    // 7. Archive first: take custody + write the record (publishedAt: null).
    const record = releases.createRelease({
      packId,
      packDisplay: active.display,
      channelId,
      startedAt: now(),
      analyses: plan.toPublish.map((rec) => ({
        assetId: rec.assetId,
        display: assetDisplay(rec.assetId),
        capturedAt: rec.capturedAt,
        sourceImagePath: stagedPath(rec.assetId),
      })),
    });
    releaseId = record.releaseId;

    // 8. Post sequentially in canonical order; record each identity as earned.
    for (const rec of plan.toPublish) {
      let messageId: string;
      try {
        const posted = await publisher.post(channelId, stagedPath(rec.assetId));
        messageId = posted.messageId;
      } catch (e) {
        return {
          ok: false,
          outcome: "publish_interrupted",
          packId,
          releaseId,
          publishedAssetIds,
          failedAssetId: rec.assetId,
          detail: errMsg(e),
        };
      }
      try {
        releases.recordPost(packId, releaseId, rec.assetId, messageId, now());
        publishedAssetIds.push(rec.assetId);
      } catch (e) {
        // Posted but the record write failed: the message is LIVE but
        // unrecorded. Report the whole truth; the release stays in flight.
        return {
          ok: false,
          outcome: "publish_interrupted",
          packId,
          releaseId,
          publishedAssetIds,
          failedAssetId: rec.assetId,
          detail: `posted to Discord (message ${messageId}) but failed to record it: ${errMsg(e)}`,
        };
      }
    }

    // 9. All posted and recorded.
    try {
      releases.markPublished(packId, releaseId, now());
    } catch (e) {
      return {
        ok: false,
        outcome: "publish_interrupted",
        packId,
        releaseId,
        publishedAssetIds,
        failedAssetId: null,
        detail: `all analyses posted, but marking the release published failed: ${errMsg(e)}`,
      };
    }
  } finally {
    // Always tear the gateway down; a close failure never changes the outcome.
    await publisher.close().catch(() => {});
  }

  // 10. Fully published: reset the workspace (advance auto-persists), then
  //     clear staging (best-effort; the archive holds custody now).
  session.advance();

  let cleared = true;
  try {
    staging.clear(packId);
  } catch {
    cleared = false;
  }

  return {
    ok: true,
    outcome: "published",
    packId,
    releaseId,
    publishedAssetIds,
    advanced: true,
    cleared,
  };
}
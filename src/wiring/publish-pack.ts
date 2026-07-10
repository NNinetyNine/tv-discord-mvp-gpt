import type { PackSession, PublishPlan } from "../packs/session.ts";
import type { StagingStore } from "./staging.ts";
import type { ChannelResolver } from "./channels.ts";
import type { ReleaseStore, ReleaseRecord } from "../release/release-store.ts";

/**
 * Pack publishing orchestration: producing a RELEASE, and RESUMING one that
 * was interrupted. Both live here because both are the same responsibility —
 * the publish process — publish starts it, resume completes it.
 *
 * Constitution rules enforced here:
 *  - COMPLETE-ONLY: an incomplete pack cannot be published (pack_incomplete).
 *    Partial publishing does not exist; there is no confirmation for it.
 *  - ARCHIVE-BEFORE-EXTERNAL: the release record + image custody are written
 *    (publishedAt: null — in flight) before any Discord post; the pack's
 *    workspace is reset ONLY on a fully published release.
 *  - HONEST INTERRUPTION: a failure mid-posting leaves an in-flight release
 *    record stating exactly which messages exist; the workspace is untouched
 *    and staging is kept. Resume itself can interrupt, leaving the release
 *    exactly as resumable as before.
 *  - RESUME: completes an existing interrupted release from its own record —
 *    never creates a second release, posts ONLY analyses whose message
 *    identity is still null, posts from ARCHIVE CUSTODY (never staging), and
 *    posts to the record's snapshotted channelId (a Release snapshots its
 *    delivery target like everything else). Resume is PACK-scoped: the
 *    Constitution has no "active pack" — per-pack releases are independently
 *    resumable, and choosing WHICH pack to resume belongs to the operator via
 *    the delivery layer. (Today's single-active session means the delivery
 *    layer can only ever choose the in-flight pack; that is the session's
 *    limitation, not this function's contract.)
 *  - SUPERSESSION (private policy; both consumers live in this module —
 *    extraction fires only when a consumer in another module exists): the
 *    interrupted release that still COUNTS is the newest record overall, iff
 *    still in flight. Publishing fresh past it (--supersede) is what retires
 *    it; the old record is never modified.
 *
 * Staging custody is ASSET-keyed: pack membership and canonical order come
 * from the session's plan (publish) or the Release record (resume), never
 * from staging. Post-publish clearing targets exactly the release's assets.
 *
 * Lifecycle is DERIVED, never stored: publishedAt === null means in flight
 * (or interrupted); publishedAt !== null means published.
 *
 * Ordering: the publisher session is OPENED before any durable effect, so a
 * connection failure aborts with zero side effects (resume's gates are pure
 * reads, so this holds for both operations).
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

/**
 * Resume needs strictly less than publish: no channel resolution (the record
 * snapshotted its channel), no display lookup (the record snapshotted its
 * displays). Honest deps — it declares only what it uses.
 */
export interface ResumePackDeps {
  readonly session: PackSession;
  readonly staging: StagingStore;
  readonly releases: ReleaseStore;
  readonly openPublisher: () => Promise<PublisherSessionShape>;
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

/**
 * Resume's own contract. Not shared with PublishPackResult: a result union is
 * the exhaustive promise of what a function can produce, and each of these
 * functions produces outcomes the other cannot. There is deliberately NO
 * no_active_pack variant: resume is pack-scoped, and "which pack" is the
 * delivery layer's question. `resumed.postedNowAssetIds` may legitimately be
 * EMPTY (a release interrupted after its last post but before markPublished
 * resumes by posting nothing).
 */
export type ResumePackResult =
  | {
      readonly ok: true;
      readonly outcome: "resumed";
      readonly packId: string;
      readonly releaseId: string;
      /** Analyses posted by THIS run (already-posted ones are never re-posted). */
      readonly postedNowAssetIds: readonly string[];
      readonly cleared: boolean; // false if staging clear failed (non-fatal)
    }
  | { readonly ok: false; readonly outcome: "nothing_to_resume"; readonly packId: string }
  | { readonly ok: false; readonly outcome: "publisher_connect_failed"; readonly packId: string; readonly detail: string }
  | {
      readonly ok: false;
      readonly outcome: "publish_interrupted";
      readonly packId: string;
      readonly releaseId: string;
      readonly publishedAssetIds: readonly string[];
      readonly failedAssetId: string | null;
      readonly detail: string;
    };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * PRIVATE supersession policy (both consumers are in this module; extract
 * only when a consumer in a DIFFERENT module exists). The interrupted release
 * that still COUNTS is the newest record overall, if and only if it is still
 * in flight (publishedAt null) — anything older was superseded by whatever
 * started after it. startedAt is read as an ordering FACT (metadata), never
 * as identity.
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
  //    Custody is asset-keyed; membership/order came from the plan above.
  const stagedPaths = new Map<string, string>();
  const missing: string[] = [];
  for (const rec of plan.toPublish) {
    const staged = staging.get(rec.assetId);
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
  //     clear exactly the release's assets from staging (best-effort; the
  //     archive holds custody now).
  session.advance();

  let cleared = true;
  try {
    staging.clear(plan.toPublish.map((rec) => rec.assetId));
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

/**
 * Resume the given pack's interrupted release: complete the existing record,
 * never create a second one. Posts ONLY analyses whose discordMessageId is
 * still null, from ARCHIVE CUSTODY, to the record's snapshotted channel,
 * recording each identity as earned. The pack's workspace resets and its
 * staging clears only once the release is fully published. Interruption of
 * resume itself leaves the release exactly as resumable as before — resume is
 * re-runnable.
 *
 * The pack is a PARAMETER: which pack to resume is the operator's choice,
 * made at the delivery layer. Under today's single-active session the only
 * legitimately resumable pack is the in-flight one (an interrupted publish
 * means advance() never fired), so a resumable release for any OTHER pack
 * means session and archive disagree — a violated invariant, thrown loudly
 * BEFORE any external effect, never a soft outcome.
 */
export async function resumeInterruptedRelease(
  deps: ResumePackDeps,
  packId: string,
): Promise<ResumePackResult> {
  const { session, staging, releases, openPublisher, now } = deps;

  // 1. The pack's interrupted release that still counts, or nothing to do.
  const release = findUnsupersededInterrupted(releases.listReleases(packId));
  if (release === null) {
    return { ok: false, outcome: "nothing_to_resume", packId };
  }
  const releaseId = release.releaseId;

  // 2. Invariant: under the single-active session, the interrupted pack IS
  //    the in-flight pack (advance never fired). Completing a release for any
  //    other pack and then advancing would silently discard the in-flight
  //    pack's work — so incoherence fails LOUD, before any external effect.
  //    (This assert dissolves when session evolution brings per-pack reset.)
  const active = session.activePack();
  if (active === null || active.id !== packId) {
    throw new Error(
      `internal: pack "${packId}" has an interrupted release but is not the session's in-flight pack` +
        `${active === null ? " (session is complete)" : ` (in flight: "${active.id}")`} — session and archive are inconsistent`,
    );
  }

  // 3. Open the publisher first: gates above were pure reads, so a connect
  //    failure leaves zero side effects.
  let publisher: PublisherSessionShape;
  try {
    publisher = await openPublisher();
  } catch (e) {
    return { ok: false, outcome: "publisher_connect_failed", packId, detail: errMsg(e) };
  }

  const postedNowAssetIds: string[] = [];
  try {
    // 4. Post ONLY the unposted remainder, in the record's canonical order,
    //    from archive custody, to the record's snapshotted channel.
    for (const analysis of release.analyses) {
      if (analysis.discordMessageId !== null) continue; // never duplicate a post

      const imagePath = releases.imagePath(packId, releaseId, analysis.imageFile);

      let messageId: string;
      try {
        const posted = await publisher.post(release.channelId, imagePath);
        messageId = posted.messageId;
      } catch (e) {
        return {
          ok: false,
          outcome: "publish_interrupted",
          packId,
          releaseId,
          publishedAssetIds: postedNowAssetIds,
          failedAssetId: analysis.assetId,
          detail: errMsg(e),
        };
      }
      try {
        releases.recordPost(packId, releaseId, analysis.assetId, messageId, now());
        postedNowAssetIds.push(analysis.assetId);
      } catch (e) {
        return {
          ok: false,
          outcome: "publish_interrupted",
          packId,
          releaseId,
          publishedAssetIds: postedNowAssetIds,
          failedAssetId: analysis.assetId,
          detail: `posted to Discord (message ${messageId}) but failed to record it: ${errMsg(e)}`,
        };
      }
    }

    // 5. Everything posted (possibly by earlier runs): the release completes.
    //    A record interrupted after its last post resumes here naturally,
    //    with postedNowAssetIds empty.
    try {
      releases.markPublished(packId, releaseId, now());
    } catch (e) {
      return {
        ok: false,
        outcome: "publish_interrupted",
        packId,
        releaseId,
        publishedAssetIds: postedNowAssetIds,
        failedAssetId: null,
        detail: `all analyses posted, but marking the release published failed: ${errMsg(e)}`,
      };
    }
  } finally {
    await publisher.close().catch(() => {});
  }

  // 6. Fully published: reset the pack's workspace (today: advance the
  //    single-active session), then clear exactly the release's assets from
  //    staging (best-effort; the archive has held custody since the release
  //    was created).
  session.advance();

  let cleared = true;
  try {
    staging.clear(release.analyses.map((a) => a.assetId));
  } catch {
    cleared = false;
  }

  return { ok: true, outcome: "resumed", packId, releaseId, postedNowAssetIds, cleared };
}
import type { Workspace, AssetCapture } from "../packs/workspace.ts";
import type { StagingStore } from "./staging.ts";
import type { ChannelResolver } from "./channels.ts";
import type { AssetThreadResolver } from "./asset-threads.ts";
import type { ReleaseStore, ReleaseRecord } from "../release/release-store.ts";

/**
 * Pack publishing orchestration: producing a RELEASE, and RESUMING one that
 * was interrupted. Both live here because both are the same responsibility —
 * the publish process — publish starts it, resume completes it.
 *
 * Both operations are PACK-EXPLICIT: they take the packId as input. Which
 * pack to publish or resume is the operator's choice, made at the delivery
 * layer (Constitution §4.5: the subset of Complete Packs is operator-chosen).
 * An unknown packId is a programming fault (callers validate operator input)
 * and fails LOUD.
 *
 * Constitution rules enforced here:
 *  - COMPLETE-ONLY: an incomplete pack cannot be published (pack_incomplete).
 *    Partial publishing does not exist; there is no confirmation for it.
 *  - ARCHIVE-BEFORE-EXTERNAL: the release record + image custody are written
 *    (publishedAt: null — in flight) before any Discord post; the pack's
 *    workspace instance is reset ONLY on a fully published release, via
 *    per-pack resetPack (§4.5, §4.7) — other packs' work is untouched.
 *  - HONEST INTERRUPTION: a failure mid-posting leaves an in-flight release
 *    record stating exactly which messages exist; the workspace is untouched
 *    and staging is kept. Resume itself can interrupt, leaving the release
 *    exactly as resumable as before.
 *  - RESUME: completes an existing interrupted release from its own record —
 *    never creates a second release, posts ONLY analyses whose message
 *    identity is still null, posts from ARCHIVE CUSTODY (never staging), and
 *    posts to the record's snapshotted destination (a Release snapshots its
 *    delivery target like everything else). Per-pack releases are
 *    independently resumable.
 *  - SUPERSESSION (private policy; both consumers live in this module —
 *    extraction fires only when a consumer in another module exists): the
 *    interrupted release that still COUNTS is the newest record overall, iff
 *    still in flight. Publishing fresh past it (--supersede) is what retires
 *    it; the old record is never modified.
 *
 * Staging custody is ASSET-keyed: pack membership and canonical order come
 * from the Workspace's derived plan (publish) or the Release record (resume),
 * never from staging. Post-publish clearing targets exactly the release's
 * assets.
 *
 * Lifecycle is DERIVED, never stored: publishedAt === null means in flight
 * (or interrupted); publishedAt !== null means published.
 *
 * Ordering: the publisher gateway is OPENED before any durable effect, so a
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
  readonly workspace: Workspace; // pass the persisted surface -> resetPack auto-saves
  readonly staging: StagingStore;
  readonly releases: ReleaseStore;
  readonly resolveChannel: ChannelResolver;
  /** Resolve one Pack/Asset pair to its persistent Discord forum thread. */
  readonly resolveAssetThread: AssetThreadResolver;
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
  readonly workspace: Workspace;
  readonly staging: StagingStore;
  readonly releases: ReleaseStore;
  readonly openPublisher: () => Promise<PublisherSessionShape>;
  readonly now: () => string;
}


export interface InspectPackPublishReadinessDeps {
  readonly workspace: Workspace;
  readonly staging: StagingStore;
  readonly releases: ReleaseStore;
  readonly resolveChannel: ChannelResolver;
  readonly resolveAssetThread: AssetThreadResolver;
}

export type PackPublishBlocker =
  | { readonly code: "pack_incomplete"; readonly missingAssetIds: readonly string[] }
  | { readonly code: "interrupted_release_exists"; readonly releaseId: string; readonly startedAt: string; readonly postedCount: number; readonly totalCount: number }
  | { readonly code: "published_release_cleanup_required"; readonly releaseId: string; readonly publishedAt: string }
  | { readonly code: "missing_staged_images"; readonly missingAssetIds: readonly string[] }
  | { readonly code: "channel_unresolved" }
  | { readonly code: "asset_threads_unresolved"; readonly missingAssetIds: readonly string[] };

export interface PackPublishReadiness {
  readonly packId: string;
  readonly ready: boolean;
  readonly capturedCount: number;
  readonly totalCount: number;
  readonly stagedCount: number;
  readonly resolvedThreadCount: number;
  readonly blockers: readonly PackPublishBlocker[];
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
      readonly cleared: boolean; // false if staging clear failed (non-fatal)
    }
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
  | {
      readonly ok: false;
      readonly outcome: "published_release_cleanup_required";
      readonly packId: string;
      readonly releaseId: string;
      readonly publishedAt: string;
    }
  | { readonly ok: false; readonly outcome: "missing_staged_images"; readonly packId: string; readonly missing: readonly string[] }
  | { readonly ok: false; readonly outcome: "channel_unresolved"; readonly packId: string }
  | {
      readonly ok: false;
      readonly outcome: "asset_threads_unresolved";
      readonly packId: string;
      readonly missingAssetIds: readonly string[];
    }
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
 * functions produces outcomes the other cannot. `resumed.postedNowAssetIds`
 * may legitimately be EMPTY (a release interrupted after its last post but
 * before markPublished resumes by posting nothing).
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
function findNewestRelease(records: readonly ReleaseRecord[]): ReleaseRecord | null {
  let newest: ReleaseRecord | null = null;
  for (const record of records) {
    if (
      newest === null ||
      record.startedAt > newest.startedAt ||
      (record.startedAt === newest.startedAt && record.releaseId > newest.releaseId)
    ) {
      newest = record;
    }
  }
  return newest;
}

function findUnsupersededInterrupted(records: readonly ReleaseRecord[]): ReleaseRecord | null {
  const newest = findNewestRelease(records);
  return newest !== null && newest.publishedAt === null ? newest : null;
}

function findPublishedReleaseAwaitingWorkspaceCleanup(
  records: readonly ReleaseRecord[],
  captures: readonly AssetCapture[],
): ReleaseRecord | null {
  const newest = findNewestRelease(records);
  if (newest === null || newest.publishedAt === null || newest.analyses.length !== captures.length) {
    return null;
  }
  return newest.analyses.every((analysis, index) => {
    const capture = captures[index];
    return capture !== undefined &&
      capture.assetId === analysis.assetId &&
      capture.capturedAt === analysis.capturedAt;
  }) ? newest : null;
}


type PreparedPackPublication = {
  readonly pack: NonNullable<ReturnType<Workspace["pack"]>>;
  readonly toPublish: readonly AssetCapture[];
  readonly stagedPaths: ReadonlyMap<string, string>;
  readonly forumChannelId: string;
  readonly threadIds: ReadonlyMap<string, string>;
};

type PackPublicationPreparation =
  | { readonly ok: true; readonly plan: PreparedPackPublication }
  | { readonly ok: false; readonly result: Exclude<PublishPackResult, { readonly ok: true }> };

function preparePackPublication(
  deps: InspectPackPublishReadinessDeps,
  packId: string,
  options: PublishOptions,
): PackPublicationPreparation {
  const { workspace, staging, releases, resolveChannel, resolveAssetThread } = deps;
  const pack = workspace.pack(packId);
  if (pack === null) {
    throw new Error(`internal: unknown pack "${packId}" — callers validate operator input`);
  }

  const missingAssetIds = workspace.pendingAssets(packId);
  if (missingAssetIds.length > 0) {
    return {
      ok: false,
      result: {
        ok: false,
        outcome: "pack_incomplete",
        packId,
        captured: pack.assets.length - missingAssetIds.length,
        total: pack.assets.length,
        missingAssetIds,
      },
    };
  }

  const toPublish = workspace.capturedFor(packId);
  const releaseRecords = releases.listReleases(packId);
  const publishedAwaitingCleanup = findPublishedReleaseAwaitingWorkspaceCleanup(releaseRecords, toPublish);
  if (publishedAwaitingCleanup !== null) {
    return {
      ok: false,
      result: {
        ok: false,
        outcome: "published_release_cleanup_required",
        packId,
        releaseId: publishedAwaitingCleanup.releaseId,
        publishedAt: publishedAwaitingCleanup.publishedAt!,
      },
    };
  }
  const interrupted = findUnsupersededInterrupted(releaseRecords);
  if (interrupted !== null && !options.supersedeInterrupted) {
    return {
      ok: false,
      result: {
        ok: false,
        outcome: "interrupted_release_exists",
        packId,
        releaseId: interrupted.releaseId,
        startedAt: interrupted.startedAt,
        postedCount: interrupted.analyses.filter((analysis) => analysis.discordMessageId !== null).length,
        totalCount: interrupted.analyses.length,
      },
    };
  }

  const stagedPaths = new Map<string, string>();
  const missingStagedAssetIds: string[] = [];
  for (const capture of toPublish) {
    const staged = staging.get(capture.assetId);
    if (staged === null) missingStagedAssetIds.push(capture.assetId);
    else stagedPaths.set(capture.assetId, staged.path);
  }
  if (missingStagedAssetIds.length > 0) {
    return {
      ok: false,
      result: { ok: false, outcome: "missing_staged_images", packId, missing: missingStagedAssetIds },
    };
  }

  const forumChannelId = resolveChannel(pack.channel);
  if (forumChannelId === null) {
    return { ok: false, result: { ok: false, outcome: "channel_unresolved", packId } };
  }

  const threadIds = new Map<string, string>();
  const missingThreadAssetIds: string[] = [];
  for (const capture of toPublish) {
    const resolved = resolveAssetThread(packId, capture.assetId);
    if (resolved === null) missingThreadAssetIds.push(capture.assetId);
    else threadIds.set(capture.assetId, resolved);
  }
  if (missingThreadAssetIds.length > 0) {
    return {
      ok: false,
      result: {
        ok: false,
        outcome: "asset_threads_unresolved",
        packId,
        missingAssetIds: missingThreadAssetIds,
      },
    };
  }

  return {
    ok: true,
    plan: { pack, toPublish, stagedPaths, forumChannelId, threadIds },
  };
}

export function inspectPackPublishReadiness(
  deps: InspectPackPublishReadinessDeps,
  packId: string,
  options: PublishOptions = { supersedeInterrupted: false },
): PackPublishReadiness {
  const pack = deps.workspace.pack(packId);
  if (pack === null) throw new Error(`internal: unknown pack "${packId}" — callers validate operator input`);

  const missingAssetIds = deps.workspace.pendingAssets(packId);
  const capturedCount = pack.assets.length - missingAssetIds.length;
  const missingStagedAssetIds = pack.assets.filter((assetId) => !deps.staging.has(assetId));
  const missingThreadAssetIds = pack.assets.filter(
    (assetId) => deps.resolveAssetThread(packId, assetId) === null,
  );
  const releaseRecords = deps.releases.listReleases(packId);
  const interrupted = findUnsupersededInterrupted(releaseRecords);
  const publishedAwaitingCleanup = missingAssetIds.length === 0
    ? findPublishedReleaseAwaitingWorkspaceCleanup(releaseRecords, deps.workspace.capturedFor(packId))
    : null;
  const blockers: PackPublishBlocker[] = [];

  if (missingAssetIds.length > 0) {
    blockers.push({ code: "pack_incomplete", missingAssetIds });
  }
  if (publishedAwaitingCleanup !== null) {
    blockers.push({
      code: "published_release_cleanup_required",
      releaseId: publishedAwaitingCleanup.releaseId,
      publishedAt: publishedAwaitingCleanup.publishedAt!,
    });
  }
  if (interrupted !== null && !options.supersedeInterrupted) {
    blockers.push({
      code: "interrupted_release_exists",
      releaseId: interrupted.releaseId,
      startedAt: interrupted.startedAt,
      postedCount: interrupted.analyses.filter((analysis) => analysis.discordMessageId !== null).length,
      totalCount: interrupted.analyses.length,
    });
  }
  if (missingStagedAssetIds.length > 0) {
    blockers.push({ code: "missing_staged_images", missingAssetIds: missingStagedAssetIds });
  }
  if (deps.resolveChannel(pack.channel) === null) {
    blockers.push({ code: "channel_unresolved" });
  }
  if (missingThreadAssetIds.length > 0) {
    blockers.push({ code: "asset_threads_unresolved", missingAssetIds: missingThreadAssetIds });
  }

  return Object.freeze({
    packId,
    ready: blockers.length === 0,
    capturedCount,
    totalCount: pack.assets.length,
    stagedCount: pack.assets.length - missingStagedAssetIds.length,
    resolvedThreadCount: pack.assets.length - missingThreadAssetIds.length,
    blockers: Object.freeze(blockers),
  });
}

export async function publishPack(
  deps: PublishPackDeps,
  packId: string,
  options: PublishOptions,
): Promise<PublishPackResult> {
  const {
    workspace,
    staging,
    releases,
    openPublisher,
    assetDisplay,
    now,
  } = deps;

  const prepared = preparePackPublication(deps, packId, options);
  if (!prepared.ok) return prepared.result;

  const { pack, toPublish, stagedPaths, forumChannelId, threadIds } = prepared.plan;

  const stagedPath = (assetId: string): string => {
    const path = stagedPaths.get(assetId);
    if (path === undefined) throw new Error(`internal: no staged path resolved for "${assetId}"`);
    return path;
  };
  const threadId = (assetId: string): string => {
    const resolved = threadIds.get(assetId);
    if (resolved === undefined) throw new Error(`internal: no Discord thread resolved for "${packId}/${assetId}"`);
    return resolved;
  };

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
    const record = releases.createThreadedRelease({
      packId,
      packDisplay: pack.display,
      forumChannelId,
      startedAt: now(),
      analyses: toPublish.map((rec) => ({
        assetId: rec.assetId,
        display: assetDisplay(rec.assetId),
        capturedAt: rec.capturedAt,
        sourceImagePath: stagedPath(rec.assetId),
        threadId: threadId(rec.assetId),
      })),
    });
    releaseId = record.releaseId;

    // 8. Post sequentially in canonical order; record each identity as earned.
    for (const rec of toPublish) {
      let messageId: string;
      try {
        const posted = await publisher.post(
          threadId(rec.assetId),
          stagedPath(rec.assetId),
        );
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

  // 10. Fully published: this pack's instance ends (per-pack reset; other
  //     packs untouched), then clear exactly the release's assets from
  //     staging (best-effort; the archive holds custody now).
  workspace.resetPack(packId);

  let cleared = true;
  try {
    staging.clear(toPublish.map((rec) => rec.assetId));
  } catch {
    cleared = false;
  }

  return {
    ok: true,
    outcome: "published",
    packId,
    releaseId,
    publishedAssetIds,
    cleared,
  };
}

/**
 * Resume the given pack's interrupted release: complete the existing record,
 * never create a second one. Posts ONLY analyses whose discordMessageId is
 * still null, from ARCHIVE CUSTODY, to the record's snapshotted channel,
 * recording each identity as earned. The pack's workspace instance resets and
 * its staging clears only once the release is fully published — other packs
 * are untouched. Interruption of resume itself leaves the release exactly as
 * resumable as before — resume is re-runnable.
 *
 * The pack is a PARAMETER: which pack to resume is the operator's choice,
 * made at the delivery layer.
 */
export async function resumeInterruptedRelease(
  deps: ResumePackDeps,
  packId: string,
): Promise<ResumePackResult> {
  const { workspace, staging, releases, openPublisher, now } = deps;

  // 1. The pack's interrupted release that still counts, or nothing to do.
  const release = findUnsupersededInterrupted(releases.listReleases(packId));
  if (release === null) {
    return { ok: false, outcome: "nothing_to_resume", packId };
  }
  const releaseId = release.releaseId;

  // 2. Open the publisher first: the gate above was a pure read, so a connect
  //    failure leaves zero side effects.
  let publisher: PublisherSessionShape;
  try {
    publisher = await openPublisher();
  } catch (e) {
    return { ok: false, outcome: "publisher_connect_failed", packId, detail: errMsg(e) };
  }

  const postedNowAssetIds: string[] = [];
  try {
    // 3. Post ONLY the unposted remainder, in the record's canonical order,
    //    from archive custody, to each snapshotted Discord destination.
    for (const analysis of release.analyses) {
      if (analysis.discordMessageId !== null) continue; // never duplicate a post

      const imagePath = releases.imagePath(packId, releaseId, analysis.imageFile);

      let messageId: string;
      try {
        let destinationId: string;

        if ("threadId" in analysis) {
          destinationId = analysis.threadId;
        } else {
          if (release.version !== 1) {
            throw new Error(
              `internal: version-2 Release analysis "${analysis.assetId}" has no threadId`,
            );
          }
          destinationId = release.channelId;
        }

        const posted = await publisher.post(destinationId, imagePath);
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

    // 4. Everything posted (possibly by earlier runs): the release completes.
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

  // 5. Fully published: this pack's instance ends (per-pack reset; other
  //    packs untouched), then clear exactly the release's assets from staging
  //    (best-effort; the archive has held custody since the release was
  //    created).
  workspace.resetPack(packId);

  let cleared = true;
  try {
    staging.clear(release.analyses.map((a) => a.assetId));
  } catch {
    cleared = false;
  }

  return { ok: true, outcome: "resumed", packId, releaseId, postedNowAssetIds, cleared };
}
import type { PackSession, PublishPlan } from "../packs/session.ts";
import type { StagingStore } from "./staging.ts";
import type { ChannelResolver } from "./channels.ts";

/**
 * Pack publishing orchestration. Coordinates Session + Staging + a publisher to
 * publish the active pack's captured subset, then advance. Owns no business
 * rules of its own — it composes verified modules.
 *
 * Flow:
 *   1. active pack? (else no_active_pack)
 *   2. anything captured? (else nothing_captured) — checked via the session's
 *      public capturedAssets(), so publishPack() is only called when we KNOW it
 *      will not throw its empty-pack guard. Any throw from publishPack() after
 *      that point is a genuine bug and is allowed to propagate (not swallowed).
 *   3. every toPublish asset has a staged image (else missing_staged_images)
 *   4. resolve the channel BEFORE confirmation (else channel_unresolved)
 *   5. if partial, require confirmation (else partial_declined)
 *   6. publish staged images sequentially in canonical order; stop on first
 *      failure (else publish_failed; no advance, no clear)
 *   7. all succeeded: advance the session (authoritative, auto-persists), then
 *      clear staging (best-effort; clear failure is non-fatal)
 *
 * Publisher / confirmation are injected inline shapes (no new exported
 * abstractions), matching the capture-once precedent. The real Discord publisher
 * is adapted to the publisher shape at the wiring boundary in a later phase.
 */

export interface PublishPackDeps {
  readonly session: PackSession; // persistent wrapper -> advance() auto-saves
  readonly staging: StagingStore;
  /** Publishes one staged image to one channel. Rejects on failure. */
  readonly publisher: { publish(channelId: string, imagePath: string): Promise<void> };
  /** Resolves a channel name to a Discord channel ID, or null. */
  readonly resolveChannel: ChannelResolver;
  /** Called ONLY for a partial pack; resolves true to proceed, false to abort. */
  readonly confirmPartial: (plan: PublishPlan) => Promise<boolean>;
}

export type PublishPackResult =
  | {
      readonly ok: true;
      readonly outcome: "published";
      readonly packId: string;
      readonly publishedAssetIds: readonly string[];
      readonly advanced: true;
      readonly cleared: boolean; // false if clear() failed (non-fatal)
      readonly wasPartial: boolean;
    }
  | { readonly ok: false; readonly outcome: "no_active_pack" }
  | { readonly ok: false; readonly outcome: "nothing_captured"; readonly packId: string }
  | { readonly ok: false; readonly outcome: "missing_staged_images"; readonly packId: string; readonly missing: readonly string[] }
  | { readonly ok: false; readonly outcome: "channel_unresolved"; readonly packId: string }
  | { readonly ok: false; readonly outcome: "partial_declined"; readonly packId: string }
  | {
      readonly ok: false;
      readonly outcome: "publish_failed";
      readonly packId: string;
      readonly publishedAssetIds: readonly string[];
      readonly failedAssetId: string;
      readonly detail: string;
      readonly advanced: false;
      readonly cleared: false;
    };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function publishActivePack(deps: PublishPackDeps): Promise<PublishPackResult> {
  const { session, staging, publisher, resolveChannel, confirmPartial } = deps;

  // 1. Active pack.
  const active = session.activePack();
  if (active === null) {
    return { ok: false, outcome: "no_active_pack" };
  }
  const packId = active.id;

  // 2. Nothing captured? Check explicitly via the session's public read API, so
  //    publishPack() is only called when captures exist and its empty-pack guard
  //    cannot fire. No catch is used: a throw from publishPack() below would be a
  //    genuine bug and is intentionally NOT converted into an operational outcome.
  if (session.capturedAssets().length === 0) {
    return { ok: false, outcome: "nothing_captured", packId };
  }

  const plan: PublishPlan = session.publishPack();

  // 3. Every asset we intend to publish must have a staged image (fail closed).
  const missing: string[] = [];
  for (const rec of plan.toPublish) {
    if (!staging.has(packId, rec.assetId)) missing.push(rec.assetId);
  }
  if (missing.length > 0) {
    return { ok: false, outcome: "missing_staged_images", packId, missing };
  }

  // 4. Resolve the channel BEFORE prompting for confirmation (fail fast).
  const channelId = resolveChannel(packId);
  if (channelId === null) {
    return { ok: false, outcome: "channel_unresolved", packId };
  }

  // 5. Partial publish requires confirmation.
  if (plan.isPartial) {
    const proceed = await confirmPartial(plan);
    if (!proceed) {
      return { ok: false, outcome: "partial_declined", packId };
    }
  }

  // 6. Publish sequentially in canonical order; stop on first failure.
  const publishedAssetIds: string[] = [];
  for (const rec of plan.toPublish) {
    const staged = staging.get(packId, rec.assetId);
    if (staged === null) {
      // Defensive re-check: a file could vanish between step 3 and here.
      return {
        ok: false,
        outcome: "publish_failed",
        packId,
        publishedAssetIds,
        failedAssetId: rec.assetId,
        detail: "staged image disappeared before publish",
        advanced: false,
        cleared: false,
      };
    }
    try {
      await publisher.publish(channelId, staged.path);
      publishedAssetIds.push(rec.assetId);
    } catch (e) {
      return {
        ok: false,
        outcome: "publish_failed",
        packId,
        publishedAssetIds,
        failedAssetId: rec.assetId,
        detail: errMsg(e),
        advanced: false,
        cleared: false,
      };
    }
  }

  // 7. All published. Advance (authoritative, auto-persists), then clear (best-effort).
  session.advance();

  let cleared = true;
  try {
    staging.clear(packId);
  } catch {
    cleared = false; // non-fatal: advance stands; orphaned files belong to a done pack
  }

  return {
    ok: true,
    outcome: "published",
    packId,
    publishedAssetIds,
    advanced: true,
    cleared,
    wasPartial: plan.isPartial,
  };
}
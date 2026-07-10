import { loadRegistry, type Registry } from "../registry/registry.ts";
import { createResolver, type Resolver } from "../resolver/index.ts";
import { loadPacks } from "../packs/packs.ts";
import { createPersistentWorkspace } from "../packs/persistence.ts";
import type { Workspace } from "../packs/workspace.ts";
import type { PackSession } from "../packs/session.ts";
import { createStagingStore, type StagingStore } from "../wiring/staging.ts";
import { loadChannelResolver } from "../wiring/channels.ts";
import { createReleaseStore, type ReleaseStore } from "../release/release-store.ts";
import { openPublisherSession } from "../publish/discord-session.ts";
import {
  validateImage,
  DEFAULT_VALIDATION_POLICY,
  type ValidationPolicy,
} from "../validation/validate-image.ts";
import { captureFromFile } from "../application/capture-from-file.ts";
import type { CaptureAttemptResult } from "../wiring/capture-once.ts";
import {
  publishActivePack,
  resumeInterruptedRelease,
  type PublishPackResult,
  type PublishOptions,
  type ResumePackResult,
} from "../wiring/publish-pack.ts";

/**
 * Composition root for the new architecture.
 *
 * buildApp() assembles the REAL application dependencies from config and wires
 * the existing application/orchestration services over them. The persisted
 * working state is ONE Workspace exposed through TWO surfaces (one save
 * discipline, one store): capture runs on the constitutional `workspace`
 * surface (routing by identity — §4.1); publish and resume remain on the
 * TRANSITIONAL `session` compatibility surface until their own migration step
 * retires it. A capture through one surface is immediately visible through
 * the other.
 *
 * Pure assembly: buildApp() does NOT decide filesystem locations or read
 * process.env. sessionPath, stagingDir and archiveDir are required inputs —
 * each caller (tests, the CLI scripts, the eventual runtime) supplies the
 * locations. The one env read on the publish path (DISCORD_BOT_TOKEN) lives
 * inside the publisher adapter, which owns that installation concern.
 *
 * The composition root is also the ONLY place the real clock is bound
 * (now: () => new Date().toISOString()); orchestration receives time as a
 * dependency because time is metadata, never mechanism.
 *
 * The registry (asset catalog) is exposed because the operator workflow needs
 * catalog access — display names for reporting, id->Asset mapping. The
 * resolver stays forward-only (resolve(filename) only); catalog queries belong
 * to the Registry, which owns them.
 *
 * Seam notes:
 *  - validation: the canonical validateImage is bound with a complete, explicit
 *    ValidationPolicy (defaults to DEFAULT_VALIDATION_POLICY, whose
 *    expectedDimensions is null until export dimensions are reconciled).
 *  - publisher: the session-scoped openPublisherSession is passed as the
 *    openPublisher factory; orchestration opens it before any durable effect.
 *  - channels: real channels.json IDs resolve per pack; empty -> null, and
 *    publish fails closed with channel_unresolved. Resume needs no channel
 *    resolution at all — the Release record snapshotted its channel.
 *  - resume is PACK-scoped (the Constitution has no "active pack"); which pack
 *    to resume is the delivery layer's choice, passed through as packId.
 */

export interface BuildAppOptions {
  /** Where the persistent working-state file lives (required — no default). */
  readonly sessionPath: string;
  /** Base directory for the staging store (required — no default). */
  readonly stagingDir: string;
  /** Root directory of the release archive (required — no default). */
  readonly archiveDir: string;
  /**
   * Complete validation policy for the file-ingest path. Defaults to
   * DEFAULT_VALIDATION_POLICY (expectedDimensions: null — dimensions are not
   * enforced until reconciled). Supply a complete policy to override.
   */
  readonly validationPolicy?: ValidationPolicy;
}

export interface App {
  /** Asset catalog (display names, tradingView tokens, id->Asset via all()). */
  readonly registry: Registry;
  readonly resolver: Resolver;
  /** The constitutional working-state surface (capture facts, derived views). */
  readonly workspace: Workspace;
  /** TRANSITIONAL compatibility surface; publish/resume still consume it. */
  readonly session: PackSession;
  readonly staging: StagingStore;
  readonly releases: ReleaseStore;
  /** Application use case: capture one operator-exported file. */
  captureFromFile(filePath: string): Promise<CaptureAttemptResult>;
  /** Orchestration: publish the active pack as an archived Release. */
  publishActivePack(options: PublishOptions): Promise<PublishPackResult>;
  /** Orchestration: resume the given pack's interrupted release. */
  resumePack(packId: string): Promise<ResumePackResult>;
}

export function buildApp(opts: BuildAppOptions): App {
  // --- shared infrastructure (constructed once; app instance state) ---
  const registry = loadRegistry();
  const resolver = createResolver(registry);
  const { workspace, session } = createPersistentWorkspace({
    packs: loadPacks(),
    path: opts.sessionPath,
  });
  const staging = createStagingStore(opts.stagingDir);
  const releases = createReleaseStore(opts.archiveDir);

  // --- validation: canonical validator bound with a complete, explicit policy ---
  const policy: ValidationPolicy = opts.validationPolicy ?? DEFAULT_VALIDATION_POLICY;
  const validate = (imagePath: string) => validateImage(imagePath, policy);

  // --- channel resolution (real config; empty IDs -> null, fail closed) ---
  const resolveChannel = loadChannelResolver();

  // --- display names (registry-owned; injected into orchestration honestly) ---
  const assetDisplay = (assetId: string): string => {
    const asset = registry.all().find((a) => a.id === assetId);
    return asset ? asset.display : assetId;
  };

  // --- the one binding of the real clock ---
  const now = (): string => new Date().toISOString();

  return {
    registry,
    resolver,
    workspace,
    session,
    staging,
    releases,
    captureFromFile(filePath: string): Promise<CaptureAttemptResult> {
      return captureFromFile({ filePath, resolver, workspace, staging, validate });
    },
    publishActivePack(options: PublishOptions): Promise<PublishPackResult> {
      return publishActivePack(
        {
          session,
          staging,
          releases,
          resolveChannel,
          openPublisher: openPublisherSession,
          assetDisplay,
          now,
        },
        options,
      );
    },
    resumePack(packId: string): Promise<ResumePackResult> {
      return resumeInterruptedRelease(
        {
          session,
          staging,
          releases,
          openPublisher: openPublisherSession,
          now,
        },
        packId,
      );
    },
  };
}
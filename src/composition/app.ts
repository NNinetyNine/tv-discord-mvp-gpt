import { loadRegistry, type Registry } from "../registry/registry.ts";
import { createResolver, type Resolver } from "../resolver/index.ts";
import { loadPacks } from "../packs/packs.ts";
import { createPersistentWorkspace } from "../packs/persistence.ts";
import type { Workspace } from "../packs/workspace.ts";
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
  publishPack,
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
 * working state is the Workspace (routing by identity — §4.1); capture,
 * publish, and resume all operate on it, pack-explicitly where a pack is the
 * operation's subject. Publish and resume take the packId from the delivery
 * layer (Constitution §4.5: the operator chooses).
 *
 * Pure assembly: buildApp() does NOT decide filesystem locations or read
 * process.env. sessionPath, stagingDir, archiveDir, registryPath, packsPath
 * and channelsPath are required inputs — each caller (tests, the CLI scripts,
 * the eventual runtime) supplies the locations. The one env read on the
 * publish path (DISCORD_BOT_TOKEN) lives inside the publisher adapter, which
 * owns that installation concern.
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
 */

export interface BuildAppOptions {
  /** Where the persistent working-state file lives (required — no default). */
  readonly sessionPath: string;
  /** Base directory for the staging store (required — no default). */
  readonly stagingDir: string;
  /** Root directory of the release archive (required — no default). */
  readonly archiveDir: string;
  /** Location of the registry definition file (required — no default). */
  readonly registryPath: string;
  /** Location of the packs definition file (required — no default). */
  readonly packsPath: string;
  /** Location of the channels configuration file (required — no default). */
  readonly channelsPath: string;
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
  /** The persisted working-state surface (capture facts, derived pack views). */
  readonly workspace: Workspace;
  readonly staging: StagingStore;
  readonly releases: ReleaseStore;
  /** Application use case: capture one operator-exported file. */
  captureFromFile(filePath: string): Promise<CaptureAttemptResult>;
  /** Orchestration: publish the given pack as an archived Release. */
  publishPack(packId: string, options: PublishOptions): Promise<PublishPackResult>;
  /** Orchestration: resume the given pack's interrupted release. */
  resumePack(packId: string): Promise<ResumePackResult>;
}

export function buildApp(opts: BuildAppOptions): App {
  // --- shared infrastructure (constructed once; app instance state) ---
  const registry = loadRegistry(opts.registryPath, opts.channelsPath);
  const resolver = createResolver(registry);
  const workspace = createPersistentWorkspace({
    packs: loadPacks(opts.packsPath, new Set(registry.all().map((a) => a.id))),
    path: opts.sessionPath,
  });
  const staging = createStagingStore(opts.stagingDir);
  const releases = createReleaseStore(opts.archiveDir);

  // --- validation: canonical validator bound with a complete, explicit policy ---
  const policy: ValidationPolicy = opts.validationPolicy ?? DEFAULT_VALIDATION_POLICY;
  const validate = (imagePath: string) => validateImage(imagePath, policy);

  // --- channel resolution (real config; empty IDs -> null, fail closed) ---
  const resolveChannel = loadChannelResolver(opts.channelsPath);

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
    staging,
    releases,
    captureFromFile(filePath: string): Promise<CaptureAttemptResult> {
      return captureFromFile({ filePath, resolver, workspace, staging, validate });
    },
    publishPack(packId: string, options: PublishOptions): Promise<PublishPackResult> {
      return publishPack(
        {
          workspace,
          staging,
          releases,
          resolveChannel,
          openPublisher: openPublisherSession,
          assetDisplay,
          now,
        },
        packId,
        options,
      );
    },
    resumePack(packId: string): Promise<ResumePackResult> {
      return resumeInterruptedRelease(
        {
          workspace,
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
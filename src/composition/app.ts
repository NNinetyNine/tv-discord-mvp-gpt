import { loadRegistry, type Registry } from "../registry/registry.ts";
import { createResolver, type Resolver } from "../resolver/index.ts";
import { loadPacks } from "../packs/packs.ts";
import { createPersistentSession } from "../packs/persistence.ts";
import type { PackSession } from "../packs/session.ts";
import { createStagingStore, type StagingStore } from "../wiring/staging.ts";
import { loadChannelResolver } from "../wiring/channels.ts";
import { publish } from "../publish/discord.ts";
import {
  validateImage,
  DEFAULT_VALIDATION_POLICY,
  type ValidationPolicy,
} from "../validation/validate-image.ts";
import { captureFromFile } from "../application/capture-from-file.ts";
import type { CaptureAttemptResult } from "../wiring/capture-once.ts";
import {
  publishActivePack,
  type PublishPackResult,
  type PublishPackDeps,
} from "../wiring/publish-pack.ts";

/**
 * Composition root for the new (Snapshot-centric) architecture.
 *
 * buildApp() assembles the REAL application dependencies from config and wires
 * the existing application/orchestration services over them. It does not define
 * new use cases — it composes captureFromFile (application layer) and
 * publishActivePack (wiring) over a SHARED session and staging store, which are
 * the app instance's state (constructed once, not per operation).
 *
 * Pure assembly: buildApp() does NOT decide filesystem locations or read
 * process.env. sessionPath and stagingDir are required inputs — each caller
 * (tests, a CLI, a GUI, the eventual runtime index.ts) supplies the locations.
 * This keeps the composition root reusable across all of them without embedding
 * any environment or path policy of its own.
 *
 * This is additive and infrastructure-only: nothing here is imported by the
 * current runtime (index.ts / pipeline.ts), so npm run start is untouched. It is
 * the wiring the runtime will eventually inherit, exercised today through tests.
 *
 * The registry (asset catalog) is exposed because the future UI/operator
 * workflow needs catalog access — to list active-pack assets with display names,
 * show pending/captured assets, tell the operator which TradingView symbol to
 * export, and map pack asset IDs to full Asset records. The resolver stays
 * forward-only (resolve(filename) only); catalog queries belong to the Registry,
 * which owns them (all(), lookupByTradingView). No reverse lookup or query logic
 * is added here.
 *
 * Seam notes:
 *  - validation: the canonical validateImage is bound with a complete, explicit
 *    ValidationPolicy (defaults to DEFAULT_VALIDATION_POLICY, whose
 *    expectedDimensions is null until export dimensions are reconciled) — a real
 *    validator with an explicit, named policy, not a stub.
 *  - publisher: discord.publish is (imagePath, channelId); publishActivePack
 *    wants (channelId, imagePath). The one-line inline bind below translates the
 *    argument order. discord.ts is unchanged.
 *  - confirmPartial: injected by the caller (no partial-publish policy is baked
 *    into the composition root).
 *  - channels: real channels.json IDs are currently empty, so publishActivePack
 *    fails closed with channel_unresolved until real IDs are filled in. Correct.
 */

export interface BuildAppOptions {
  /** Where the persistent session file lives (required — no default). */
  readonly sessionPath: string;
  /** Base directory for the staging store (required — no default). */
  readonly stagingDir: string;
  /** Partial-publish confirmation policy (injected, not hardcoded). */
  readonly confirmPartial: PublishPackDeps["confirmPartial"];
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
  readonly session: PackSession;
  readonly staging: StagingStore;
  /** Application use case: capture one operator-exported file. */
  captureFromFile(filePath: string): Promise<CaptureAttemptResult>;
  /** Orchestration: publish the active pack (confirmPartial injected at build). */
  publishActivePack(): Promise<PublishPackResult>;
}

export function buildApp(opts: BuildAppOptions): App {
  // --- shared infrastructure (constructed once; app instance state) ---
  const registry = loadRegistry();
  const resolver = createResolver(registry);
  const session = createPersistentSession({
    packs: loadPacks(),
    path: opts.sessionPath,
  });
  const staging = createStagingStore(opts.stagingDir);

  // --- validation: canonical validator bound with a complete, explicit policy ---
  const policy: ValidationPolicy = opts.validationPolicy ?? DEFAULT_VALIDATION_POLICY;
  const validate = (imagePath: string) => validateImage(imagePath, policy);

  // --- publisher: inline arg-order bind over the real discord publisher ---
  const publisher = {
    publish: (channelId: string, imagePath: string) => publish(imagePath, channelId),
  };

  // --- channel resolution (real config; empty IDs -> null, fail closed) ---
  const resolveChannel = loadChannelResolver();

  return {
    registry,
    resolver,
    session,
    staging,
    captureFromFile(filePath: string): Promise<CaptureAttemptResult> {
      return captureFromFile({ filePath, resolver, session, staging, validate });
    },
    publishActivePack(): Promise<PublishPackResult> {
      return publishActivePack({
        session,
        staging,
        publisher,
        resolveChannel,
        confirmPartial: opts.confirmPartial,
      });
    },
  };
}
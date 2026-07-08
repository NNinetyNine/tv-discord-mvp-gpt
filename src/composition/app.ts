import { loadRegistry, type Registry } from "../registry/registry.ts";
import { createResolver, type Resolver } from "../resolver/index.ts";
import { loadPacks } from "../packs/packs.ts";
import { createPersistentSession } from "../packs/persistence.ts";
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
  type PublishPackResult,
  type PublishOptions,
} from "../wiring/publish-pack.ts";

/**
 * Composition root. Assembles the real dependencies from config and wires the
 * application/orchestration services over a SHARED session, staging store, and
 * release store (the app instance's state, constructed once).
 *
 * Pure assembly: buildApp() does NOT decide filesystem locations or read
 * process.env. sessionPath, stagingDir, and archiveDir are required inputs.
 * (The Discord publisher session reads DISCORD_BOT_TOKEN itself at open time —
 * the adapter owns its credential, same as the legacy publisher.)
 *
 * Publishing produces a RELEASE: archived custody + record before any post,
 * per-analysis Discord message identities recorded as earned, complete-only
 * (partial publishing does not exist — the old confirmPartial seam is gone),
 * workspace reset only on a fully published release. The real clock is bound
 * here (now) — orchestration receives time as an injected fact.
 *
 * Nothing here is imported by the legacy runtime; npm run start is untouched.
 */

export interface BuildAppOptions {
  /** Where the persistent session file lives (required — no default). */
  readonly sessionPath: string;
  /** Base directory for the staging store (required — no default). */
  readonly stagingDir: string;
  /** Root directory of the release archive (required — no default). */
  readonly archiveDir: string;
  /** Complete validation policy for the file-ingest path (defaults applied). */
  readonly validationPolicy?: ValidationPolicy;
}

export interface App {
  readonly registry: Registry;
  readonly resolver: Resolver;
  readonly session: PackSession;
  readonly staging: StagingStore;
  readonly releases: ReleaseStore;
  /** Application use case: capture one operator-exported file. */
  captureFromFile(filePath: string): Promise<CaptureAttemptResult>;
  /** Orchestration: publish the active pack as a Release. */
  publishActivePack(options: PublishOptions): Promise<PublishPackResult>;
}

export function buildApp(opts: BuildAppOptions): App {
  const registry = loadRegistry();
  const resolver = createResolver(registry);
  const session = createPersistentSession({
    packs: loadPacks(),
    path: opts.sessionPath,
  });
  const staging = createStagingStore(opts.stagingDir);
  const releases = createReleaseStore(opts.archiveDir);

  const policy: ValidationPolicy = opts.validationPolicy ?? DEFAULT_VALIDATION_POLICY;
  const validate = (imagePath: string) => validateImage(imagePath, policy);

  const resolveChannel = loadChannelResolver();

  /** Registry-owned display names, injected honestly as a function. */
  const assetDisplay = (assetId: string): string => {
    const asset = registry.all().find((a) => a.id === assetId);
    return asset ? asset.display : assetId;
  };

  return {
    registry,
    resolver,
    session,
    staging,
    releases,
    captureFromFile(filePath: string): Promise<CaptureAttemptResult> {
      return captureFromFile({ filePath, resolver, session, staging, validate });
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
          now: () => new Date().toISOString(),
        },
        options,
      );
    },
  };
}
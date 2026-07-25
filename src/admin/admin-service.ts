import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type { Asset } from "../types.ts";
import {
  validateAssetLogo,
  type ValidatedAssetLogo,
} from "../assets/asset-logo.ts";
import {
  AssetLogoFileError,
  deleteCanonicalAssetLogo,
  inspectCanonicalAssetLogo,
  readCanonicalAssetLogo,
  writeCanonicalAssetLogo,
} from "../assets/asset-logo-file.ts";
import {
  prepareCreatePackWithMissingAssets,
  serializeCreatePackPreview,
  serializeCreatePackWithMissingAssetsInput,
  type CreatePackPreview,
} from "../application/create-pack-with-missing-assets.ts";
import { applyCreatePackWithMissingAssetsFile } from "../application/create-pack-with-missing-assets-file.ts";
import type { Pack } from "../packs/packs.ts";
import {
  addPackAsset,
  buildPacks,
  deletePack,
  PackError,
  reassignPackChannel,
  removePackAsset,
  renamePackDisplay,
  reorderPackAssets,
  reorderPacks,
} from "../packs/packs.ts";
import { addAssetAlias, buildRegistry, removeAssetAlias, retireAsset, RegistryError } from "../registry/registry.ts";
import {
  previewRegistryCsvImport,
  type RegistryCsvImportIssue,
  type RegistryCsvImportRow,
} from "../registry/registry-csv-import.ts";
import {
  applyRegistryCsvImportFile,
  RegistryCsvImportFileError,
} from "../registry/registry-csv-import-file.ts";
import { createResolver } from "../resolver/index.ts";
import { findDuplicates } from "../audit/find-duplicates.ts";
import {
  auditAssetMarketIdentity,
  type AssetMarketIdentityAudit,
  type MarketIdentityAuditIssue,
} from "../registry/asset-market-identity-audit.ts";
import { computeAssetRegistrationRegistryFingerprint } from "../registry/asset-registration-proposal.ts";
import { validateAssetRegistrationChannel } from "../registry/asset-registration-channel.ts";
import {
  AdminError,
  type PackDraft,
  type PackDraftValidationResult,
  parsePackDraft,
  validatePackDraft,
} from "./admin-types.ts";
import { AdminWorkspace } from "./admin-workspace.ts";
import { AdminPackBuilderWorkspace } from "./admin-pack-builder-workspace.ts";
import {
  AdminStandaloneRenderWorkspace,
  type StandaloneRenderArtifactName,
} from "./admin-standalone-render-workspace.ts";
import { AdminPromotionWorkspace, type PackPromotionArtifactName } from "./admin-promotion-workspace.ts";
import {
  AdminAssetRegistrationWorkspace,
  type AssetRegistrationArtifactName,
} from "./admin-asset-registration-workspace.ts";
import {
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
  validateAssetRegistrationInput,
  validateAssetRegistrationProposalReceipt,
} from "../registry/asset-registration-proposal.ts";
import { proposeAssetRegistrationFile } from "../registry/asset-registration-proposal-file.ts";
import {
  serializeAssetRegistrationApplicationAuthorization,
  validateAssetRegistrationApplicationAuthorization,
} from "../registry/asset-registration-application-authorization.ts";
import { validateAssetRegistrationApplicationPlanReceipt } from "../registry/asset-registration-application-plan.ts";
import { planAssetRegistrationApplicationFile } from "../registry/asset-registration-application-plan-file.ts";
import { generateAssetRegistrationSourceChangeFile } from "../registry/asset-registration-source-change-file.ts";
import {
  serializeAssetRegistrationSourceChangeReviewDecision,
  validateAssetRegistrationSourceChangeReviewDecision,
  validateAssetRegistrationSourceChangeReviewReceipt,
} from "../registry/asset-registration-source-change-review.ts";
import { reviewAssetRegistrationSourceChangeFile } from "../registry/asset-registration-source-change-review-file.ts";
import {
  serializeAssetRegistrationSourceApplicationAuthorization,
  validateAssetRegistrationSourceApplicationAuthorization,
} from "../registry/asset-registration-source-application-authorization.ts";
import { applyAssetRegistrationSourceChangeFile } from "../registry/asset-registration-source-application-file.ts";
import {
  currentPackPromotionContext,
  generatePackSourceChange,
  planPackSourceChange,
  proposePackDraftPromotion,
  serializePackDraftPromotionRequest,
  serializePackSourceApplicationPlan,
  serializePackSourceChangeReceipt,
  serializePackSourcePlanningAuthorization,
  serializePackSourceProposal,
  sha256 as promotionSha256,
  validatePackDraftPromotionRequest,
  validatePackSourcePlanningAuthorization,
  type PackPromotionContext,
} from "../packs/pack-draft-promotion.ts";
import { previewChartPublicationFile } from "../application/chart-publication-preview-file.ts";
import {
  SUPPORTED_CHART_PUBLICATION_TIMEFRAMES,
  defaultChartPublicationTimeframeForPack,
  validateChartPublicationTimeframe,
  type ChartPublicationTimeframe,
} from "../application/chart-publication-preview.ts";
import { acceptPackChartPublicationFile } from "../application/accept-pack-chart-publication-file.ts";
import {
  resetPackWorkspaceAsset,
  resetPackWorkspacePack,
  type ResetPackWorkspaceResult,
} from "../application/reset-pack-workspace.ts";
import {
  verifyPackDiscordThreadRouting,
  type VerifyPackDiscordThreadRoutingResult,
} from "../application/verify-pack-discord-thread-routing.ts";
import { createPersistentWorkspace } from "../packs/persistence.ts";
import { createStagingStore } from "../wiring/staging.ts";
import { createReleaseStore, type ReleaseRecord, type ReleaseStore } from "../release/release-store.ts";
import {
  inspectPackPublishReadiness,
  publishPack,
  resumeInterruptedRelease,
  type PackPublishBlocker,
  type PublisherSessionShape,
  type PublishPackResult,
  type ResumePackResult,
} from "../wiring/publish-pack.ts";
import { DEFAULT_VALIDATION_POLICY, validateImage } from "../validation/validate-image.ts";
import {
  AdminPackRenderWorkspace,
  type PackRenderPreviewArtifactName,
} from "./admin-pack-render-workspace.ts";
import {
  AdminPackCaptureSessionWorkspace,
  type PackCaptureSessionState,
  type QueuedPackCapture,
} from "./admin-pack-capture-session-workspace.ts";
import {
  AdminPackRevisionWorkspace,
  type PackRevisionArtifactName,
} from "./admin-pack-revision-workspace.ts";
import {
  adoptDiscordAssetThread,
  type AdoptDiscordAssetThreadResult,
} from "../application/adopt-discord-asset-thread.ts";
import {
  provisionDiscordAssetThread,
  type ProvisionDiscordAssetThreadResult,
} from "../application/provision-discord-asset-thread.ts";
import type {
  DiscordForumAdministrationSession,
  DiscordForumSession,
} from "../publish/discord-forum-session.ts";
import {
  bindAssetThreadFile,
  replaceAssetThreadBindingFile,
  unbindAssetThreadFile,
} from "../wiring/asset-thread-bindings-file.ts";
import {
  AssetThreadsError,
  parseAssetThreadBindings,
  serializeAssetThreadBindings,
  type AssetThreadBindings,
} from "../wiring/asset-threads.ts";
import { buildChannelResolver } from "../wiring/channels.ts";
import { AdminThreadProvisioningWorkspace } from "./admin-thread-provisioning-workspace.ts";
import { AdminPublicationWorkspace } from "./admin-publication-workspace.ts";
import { AdminServerConfigurationWorkspace } from "./admin-server-configuration-workspace.ts";
import {
  buildAliasChangePreview,
  buildPackMaintenancePreview,
  parsePackMaintenanceInput,
  type AdminAliasChangePreview,
  type AdminPackMaintenanceInput,
  type AdminPackMaintenancePreview,
} from "./admin-operator-tools.ts";
import {
  applyServerConfigurationFile,
  ServerConfigurationFileError,
} from "../wiring/server-configuration-file.ts";
import type {
  DiscordServerAdministrationSession,
  DiscordServerRouteFacts,
} from "../publish/discord-server-session.ts";

import {
  reviewPackSourceChange,
  serializePackSourceChangeReviewDecision,
  serializePackSourceChangeReviewReceipt,
  validatePackSourceChangeReviewDecision,
} from "../packs/pack-source-change-review.ts";
import {
  serializePackSourceApplicationAuthorization,
  validatePackSourceApplicationAuthorization,
} from "../packs/pack-source-application-authorization.ts";

const REGISTRY_RELATIVE_PATH = "definitions/registry.json" as const;
const PACKS_RELATIVE_PATH = "definitions/packs.json" as const;
const CHANNELS_RELATIVE_PATH = "config/channels.json" as const;
const THREAD_BINDINGS_RELATIVE_PATH = "config/asset-threads.json" as const;
const MAX_ASSET_SEARCH_LIMIT = 100 as const;
const DEFAULT_ASSET_SEARCH_LIMIT = 50 as const;

interface CanonicalFile {
  readonly relativePath:
    | typeof REGISTRY_RELATIVE_PATH
    | typeof PACKS_RELATIVE_PATH
    | typeof CHANNELS_RELATIVE_PATH
    | typeof THREAD_BINDINGS_RELATIVE_PATH;
  readonly canonicalPath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface AdminPackRuntime {
  readonly workspace: ReturnType<typeof createPersistentWorkspace>;
  readonly staging: ReturnType<typeof createStagingStore>;
}

interface LiveState {
  readonly registryFile: CanonicalFile;
  readonly packsFile: CanonicalFile;
  readonly channelsFile: CanonicalFile;
  readonly rawRegistry: Readonly<Record<string, Record<string, unknown>>>;
  readonly rawPacks: readonly unknown[];
  readonly rawChannels: Readonly<Record<string, unknown>>;
  readonly assets: readonly Asset[];
  readonly packs: readonly Pack[];
  readonly byAssetId: ReadonlyMap<string, Asset>;
  readonly byPackId: ReadonlyMap<string, Pack>;
  readonly assetPackIds: ReadonlyMap<string, readonly string[]>;
  readonly registryFingerprint: string;
  readonly audit: AssetMarketIdentityAudit;
}

export interface AdminStatus {
  readonly schemaVersion: 1;
  readonly canonicalState: "controlled_write";
  readonly canonicalStateReadOnly: false;
  readonly registryAssetCount: number;
  readonly packCount: number;
  readonly packMembershipCount: number;
  readonly registryFingerprint: string;
  readonly registrySourceSha256: string;
  readonly packSourceSha256: string;
  readonly channelConfigurationSha256: string;
  readonly auditGapCount: number;
  readonly sourceIntegrity: "verified";
}

export interface AdminAssetSummary {
  readonly id: string;
  readonly displayName: string;
  readonly tradingViewSymbol: string;
  readonly logicalChannel: string;
  readonly packMembershipCount: number;
  readonly packIds: readonly string[];
  readonly currency?: string;
  readonly tradingViewAliases?: readonly string[];
}

export interface AdminAssetSearchResult {
  readonly schemaVersion: 1;
  readonly query: string;
  readonly packId: string | null;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly assets: readonly AdminAssetSummary[];
}

export interface AdminRegistryAssetChangePreview {
  readonly schemaVersion: 1;
  readonly changeId: string;
  readonly operation: "add" | "update";
  readonly asset: AdminAssetSummary;
  readonly previous: AdminAssetSummary | null;
  readonly sourceState: {
    readonly registrySha256: string;
    readonly packsSha256: string;
    readonly channelsSha256: string;
  };
  readonly effects: {
    readonly registryChanged: true;
    readonly packMembershipChanged: false;
    readonly logoChanged: false;
    readonly discordContacted: false;
  };
}

export interface AdminRegistryCsvImportPreview {
  readonly schemaVersion: 1;
  readonly previewId: string;
  readonly fileName: string;
  readonly valid: boolean;
  readonly rowCount: number;
  readonly additionCount: number;
  readonly packMembershipCount: number;
  readonly rows: readonly RegistryCsvImportRow[];
  readonly issues: readonly RegistryCsvImportIssue[];
  readonly sourceState: {
    readonly registrySha256: string;
    readonly packsSha256: string;
    readonly channelsSha256: string;
  };
  readonly effects: {
    readonly registryChanged: boolean;
    readonly packMembershipChanged: boolean;
    readonly discordContacted: false;
  };
}

interface AdminRegistryCsvImportRecord {
  readonly preview: AdminRegistryCsvImportPreview;
  readonly registryAfterBytes: Buffer;
  readonly packsAfterBytes: Buffer;
}

export interface AdminRegistryAssetRetirementPreview {
  readonly schemaVersion: 1;
  readonly operation: "retire";
  readonly previewId: string;
  readonly asset: AdminAssetSummary;
  readonly blockingPackIds: readonly string[];
  readonly blockingThreadRoutes: readonly string[];
  readonly sourceState: {
    readonly registrySha256: string;
    readonly packsSha256: string;
    readonly threadBindingsSha256: string;
  };
}

export interface AdminPackSummary {
  readonly id: string;
  readonly displayName: string;
  readonly logicalChannel: string;
  readonly membershipCount: number;
}

export interface AdminPackDetail extends AdminPackSummary {
  readonly assets: readonly AdminAssetSummary[];
}

export interface AdminDraftRecord {
  readonly draft: PackDraft;
  readonly validation: PackDraftValidationResult;
}

export interface AdminStandaloneRenderAsset {
  readonly id: string;
  readonly displayName: string;
  readonly tradingViewSymbol: string;
  readonly logicalChannel: string;
  readonly currency?: string;
  readonly renderReady: boolean;
  readonly reconciliationIssues: readonly MarketIdentityAuditIssue[];
}

export interface AdminStandaloneRenderOptions {
  readonly schemaVersion: 1;
  readonly timeframes: readonly ChartPublicationTimeframe[];
  /** Every canonical Registry Asset remains discoverable, even when metadata blocks rendering. */
  readonly assets: readonly AdminStandaloneRenderAsset[];
  readonly renderableAssetCount: number;
  readonly reconciliationRequiredCount: number;
  /** Compatibility alias retained for existing clients; equals reconciliationRequiredCount. */
  readonly unavailableAssetCount: number;
}

export interface AdminStandaloneRenderedAsset {
  readonly id: string;
  readonly displayName: string;
  readonly tradingViewSymbol: string;
  readonly logicalChannel: string;
  readonly currency: string;
  readonly renderReady: true;
  readonly reconciliationIssues: readonly MarketIdentityAuditIssue[];
}

export interface AdminStandaloneRenderResult {
  readonly schemaVersion: 1;
  readonly renderId: string;
  readonly asset: AdminStandaloneRenderedAsset;
  readonly timeframe: ChartPublicationTimeframe;
  readonly dataAsOf: string;
  readonly sourceBasename: string;
  readonly outputSha256: string;
  readonly watermarkEnabled: boolean;
  readonly publicationUrl: string;
  readonly receiptUrl: string;
  readonly effects: {
    readonly packWorkspaceChanged: false;
    readonly staged: false;
    readonly released: false;
    readonly discordContacted: false;
  };
}

export interface AdminPackWorkspaceAssetState {
  readonly id: string;
  readonly displayName: string;
  readonly tradingViewSymbol: string;
  readonly currency: string;
  readonly renderReady: boolean;
  readonly reconciliationIssues: readonly MarketIdentityAuditIssue[];
  readonly captured: boolean;
  readonly artifactReady: boolean;
  readonly revisions: number;
  readonly capturedAt: string | null;
  readonly revisionHistory: readonly AdminPackWorkspaceRevisionState[];
}

export interface AdminPackWorkspaceRevisionState {
  readonly revision: number;
  readonly previewId: string;
  readonly acceptedAt: string;
  readonly sourceBasename: string;
  readonly timeframe: ChartPublicationTimeframe;
  readonly dataAsOf: string;
  readonly outputSha256: string;
  readonly current: boolean;
  readonly confirmed: true;
  readonly publicationUrl: string;
  readonly receiptUrl: string;
}

export type AdminPackPublicationBlocker =
  | PackPublishBlocker
  | { readonly code: "discord_unavailable" };

export interface AdminPackPublicationState {
  readonly state: "ready" | "blocked" | "interrupted";
  readonly ready: boolean;
  readonly capturedCount: number;
  readonly totalCount: number;
  readonly stagedCount: number;
  readonly resolvedThreadCount: number;
  readonly blockers: readonly AdminPackPublicationBlocker[];
  readonly interruptedRelease: null | {
    readonly releaseId: string;
    readonly startedAt: string;
    readonly postedCount: number;
    readonly totalCount: number;
  };
}

export interface AdminPackWorkspacePackState {
  readonly id: string;
  readonly displayName: string;
  readonly logicalChannel: string;
  readonly timeframe: ChartPublicationTimeframe;
  readonly state: "empty" | "building" | "complete";
  readonly capturedCount: number;
  readonly totalCount: number;
  readonly remainingRequiredAssetIds: readonly string[];
  readonly publication: AdminPackPublicationState;
  readonly assets: readonly AdminPackWorkspaceAssetState[];
}

export interface AdminPackWorkspaceState {
  readonly schemaVersion: 1;
  readonly publishAvailable: boolean;
  readonly publicationInProgress: boolean;
  readonly packs: readonly AdminPackWorkspacePackState[];
}

export interface AdminPackPublicationPreview {
  readonly schemaVersion: 1;
  readonly previewId: string;
  readonly valid: boolean;
  readonly confirmation: string;
  readonly selectedPackIds: readonly string[];
  readonly supersedePackIds: readonly string[];
  readonly packs: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly action: "publish" | "supersede";
    readonly publication: AdminPackPublicationState;
  }[];
  readonly sourceState: {
    readonly registrySha256: string;
    readonly packsSha256: string;
    readonly channelsSha256: string;
    readonly threadBindingsSha256: string;
    readonly workspaceFingerprint: string;
  };
  readonly effects: {
    readonly releasesCreated: number;
    readonly discordPostsPlanned: number;
    readonly selectedPacksResetOnSuccess: true;
    readonly unselectedPacksChanged: false;
  };
}

export type AdminPackPublicationFailure =
  | Exclude<PublishPackResult, { readonly ok: true }>
  | {
      readonly ok: false;
      readonly outcome: "publication_failed";
      readonly packId: string;
      readonly releaseId: string | null;
      readonly publishedAssetIds: readonly string[];
      readonly detail: string;
    };

export type AdminPackPublicationCleanupWarning = {
  readonly packId: string;
  readonly code:
    | "workspace_reset_failed"
    | "staging_cleanup_failed"
    | "capture_session_cleanup_failed"
    | "revision_history_cleanup_failed";
};

export interface AdminPackPublicationResult {
  readonly schemaVersion: 1;
  readonly outcome: "published" | "partially_published" | "failed";
  readonly previewId: string;
  readonly selectedPackIds: readonly string[];
  readonly published: readonly Extract<PublishPackResult, { readonly ok: true }>[];
  readonly failed: AdminPackPublicationFailure | null;
  readonly notAttemptedPackIds: readonly string[];
  readonly cleanupWarnings: readonly AdminPackPublicationCleanupWarning[];
  readonly effects: {
    readonly discordContacted: boolean;
    readonly releasesCreated: number;
    readonly packsReset: readonly string[];
  };
}

export interface AdminPackResumeResult {
  readonly schemaVersion: 1;
  readonly result: ResumePackResult;
  readonly cleanupWarnings: readonly AdminPackPublicationCleanupWarning[];
}

export interface AdminThreadManagementAssetState {
  readonly id: string;
  readonly displayName: string;
  readonly bindingState: "bound" | "unbound";
  readonly threadId: string | null;
}

export interface AdminThreadManagementPackState {
  readonly id: string;
  readonly displayName: string;
  readonly logicalChannel: string;
  readonly forumConfigured: boolean;
  readonly boundCount: number;
  readonly totalCount: number;
  readonly missingCount: number;
  readonly verificationEligible: boolean;
  readonly assets: readonly AdminThreadManagementAssetState[];
}

export interface AdminThreadManagementState {
  readonly schemaVersion: 1;
  readonly mode: "adoption_only" | "adoption_and_provisioning";
  readonly adoptionAvailable: boolean;
  readonly provisioningAvailable: boolean;
  readonly publicationAvailable: false;
  readonly bindingsSourceSha256: string;
  readonly boundCount: number;
  readonly totalCount: number;
  readonly missingCount: number;
  readonly packs: readonly AdminThreadManagementPackState[];
}

export interface AdminThreadAdoptionResult {
  readonly schemaVersion: 1;
  readonly outcome: "adopted" | "already_adopted";
  readonly packId: string;
  readonly assetId: string;
  readonly thread: {
    readonly threadId: string;
    readonly name: string;
    readonly archived: boolean | null;
    readonly locked: boolean | null;
    readonly appliedTagCount: number;
  };
  readonly sessionClosed: boolean;
  readonly warnings: readonly ("discord_session_close_failed")[];
  readonly effects: {
    readonly discordInspected: true;
    readonly discordContentChanged: false;
    readonly bindingChanged: boolean;
    readonly published: false;
    readonly released: false;
  };
}

export type AdminDiscordForumSessionFactory = () => Promise<DiscordForumSession>;
export type AdminDiscordForumProvisioningSessionFactory = () => Promise<DiscordForumAdministrationSession>;
export type AdminDiscordServerSessionFactory = () => Promise<DiscordServerAdministrationSession>;

export interface AdminServerConfigurationRouteState {
  readonly logicalChannel: string;
  readonly channelId: string | null;
  readonly configured: boolean;
  readonly packIds: readonly string[];
  readonly registryAssetCount: number;
  readonly boundThreadCount: number;
}

export interface AdminServerConfigurationState {
  readonly schemaVersion: 1;
  readonly credential: {
    readonly configured: boolean;
    readonly source: "process_environment";
    readonly editable: false;
    readonly valueExposed: false;
  };
  readonly connectionTestAvailable: boolean;
  readonly publisherTransport: "discord_bot_gateway";
  readonly webhooks: {
    readonly used: false;
    readonly configured: false;
    readonly explanation: string;
  };
  readonly channelsSourceSha256: string;
  readonly threadBindingsSourceSha256: string;
  readonly routes: readonly AdminServerConfigurationRouteState[];
}

export interface AdminServerRouteInspection {
  readonly logicalChannel: string;
  readonly channelId: string;
  readonly state: "ready" | "blocked";
  readonly facts: DiscordServerRouteFacts | null;
  readonly issues: readonly string[];
}

export interface AdminServerConnectionInspection {
  readonly schemaVersion: 1;
  readonly operationallyReady: boolean;
  readonly bot: { readonly userId: string; readonly username: string };
  readonly guild: { readonly id: string; readonly name: string } | null;
  readonly routes: readonly AdminServerRouteInspection[];
  readonly sessionClosed: boolean;
  readonly warnings: readonly ("discord_session_close_failed")[];
  readonly effects: {
    readonly discordInspected: true;
    readonly discordContentChanged: false;
    readonly configurationChanged: false;
  };
}

export interface AdminServerConfigurationIssue {
  readonly code:
    | "route_name_invalid"
    | "route_removal_blocked"
    | "channel_id_invalid"
    | "channel_id_duplicate"
    | "pack_route_unconfigured"
    | "binding_migration_required"
    | "discord_unavailable"
    | "discord_route_blocked"
    | "cross_guild_routes"
    | "no_route_changes";
  readonly message: string;
  readonly logicalChannel?: string;
}

export interface AdminServerConfigurationPreview {
  readonly schemaVersion: 1;
  readonly previewId: string;
  readonly mode: "configuration" | "migration";
  readonly valid: boolean;
  readonly confirmation: string;
  readonly changedRouteCount: number;
  readonly affectedPackIds: readonly string[];
  readonly bindingsToReestablish: number;
  readonly issues: readonly AdminServerConfigurationIssue[];
  readonly routes: readonly {
    readonly logicalChannel: string;
    readonly currentChannelId: string | null;
    readonly nextChannelId: string | null;
    readonly changed: boolean;
    readonly packIds: readonly string[];
    readonly boundThreadCount: number;
    readonly inspection: AdminServerRouteInspection | null;
  }[];
  readonly sourceState: {
    readonly registrySha256: string;
    readonly packsSha256: string;
    readonly channelsSha256: string;
    readonly threadBindingsSha256: string;
  };
  readonly effects: {
    readonly channelsChanged: boolean;
    readonly threadBindingsRemoved: number;
    readonly unaffectedThreadBindingsPreserved: true;
    readonly credentialsChanged: false;
    readonly webhooksChanged: false;
    readonly discordContentChanged: false;
    readonly backupRequired: boolean;
  };
}

interface AdminServerConfigurationPreviewRecord {
  readonly preview: AdminServerConfigurationPreview;
  readonly channelsBeforeBytes: Buffer;
  readonly threadBindingsBeforeBytes: Buffer;
  readonly channelsAfterBytes: Buffer;
  readonly threadBindingsAfterBytes: Buffer;
}

interface AdminPackMaintenancePreviewRecord {
  readonly request: AdminPackMaintenanceInput;
  readonly preview: AdminPackMaintenancePreview;
}

interface AdminAliasChangePreviewRecord {
  readonly preview: AdminAliasChangePreview;
}

export interface AdminThreadForumInspectionResult {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly forum: {
    readonly name: string;
    readonly requiresTag: boolean;
    readonly availableTags: readonly {
      readonly id: string;
      readonly name: string;
      readonly moderated: boolean;
    }[];
  };
  readonly sessionClosed: boolean;
  readonly warnings: readonly ("discord_session_close_failed")[];
  readonly effects: {
    readonly discordInspected: true;
    readonly discordContentChanged: false;
    readonly bindingChanged: false;
    readonly published: false;
    readonly released: false;
  };
}

export interface AdminThreadProvisioningResult {
  readonly schemaVersion: 1;
  readonly outcome: "provisioned";
  readonly packId: string;
  readonly assetId: string;
  readonly thread: {
    readonly threadId: string;
    readonly name: string;
    readonly appliedTagCount: number;
  };
  readonly logoSha256: string;
  readonly sessionClosed: boolean;
  readonly warnings: readonly ("discord_session_close_failed")[];
  readonly effects: {
    readonly discordInspected: true;
    readonly discordContentChanged: true;
    readonly bindingChanged: true;
    readonly published: false;
    readonly released: false;
  };
}

export interface AdminPackThreadRoutingVerificationResult {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly operationallyReady: boolean;
  readonly bindingSourceSha256: string;
  readonly verifiedCount: number;
  readonly totalCount: number;
  readonly assets: readonly {
    readonly assetId: string;
    readonly threadId: string;
    readonly name: string | null;
    readonly state: "ready" | "blocked";
    readonly issues: readonly string[];
  }[];
  readonly sessionClosed: boolean;
  readonly warnings: readonly ("discord_session_close_failed")[];
  readonly effects: {
    readonly discordInspected: true;
    readonly discordContentChanged: false;
    readonly bindingChanged: false;
    readonly published: false;
    readonly released: false;
  };
}

export interface AdminServiceOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly chartDownloadsRoot?: string;
  readonly openDiscordForumSession?: AdminDiscordForumSessionFactory;
  readonly openDiscordForumProvisioningSession?: AdminDiscordForumProvisioningSessionFactory;
  readonly openPublisherSession?: () => Promise<PublisherSessionShape>;
  readonly openDiscordServerSession?: AdminDiscordServerSessionFactory;
  readonly discordCredentialConfigured?: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveRepositoryRoot(requestedPath: string): Promise<string> {
  const requested = resolve(requestedPath);
  try {
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AdminError("repository_root_invalid", "Repository root must be a non-symlink directory.");
    }
    return await realpath(requested);
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError("repository_root_invalid", `Repository root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readCanonicalFile(
  root: string,
  relativePath: CanonicalFile["relativePath"],
): Promise<CanonicalFile> {
  const requested = join(root, relativePath);
  try {
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AdminError("source_path_unsafe", `${relativePath} must be a regular non-symlink file.`);
    }
    const canonicalPath = await realpath(requested);
    if (!pathInside(root, canonicalPath)) {
      throw new AdminError("source_path_unsafe", `${relativePath} escapes the repository root.`);
    }
    const bytes = await readFile(canonicalPath);
    return Object.freeze({ relativePath, canonicalPath, bytes, sha256: sha256(bytes) });
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError("unreadable_source", `Could not read canonical source ${relativePath}.`);
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new AdminError("unreadable_source", `${label} is not valid JSON.`);
  }
}


async function verifyPackPatch(patchBytes: Buffer, packsBytes: Buffer): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "visionx-admin-pack-review-check-"));
  try {
    await mkdir(join(directory, "definitions"), { recursive: true });
    await writeFile(join(directory, "definitions/packs.json"), packsBytes);
    const patchPath = join(directory, "change.patch");
    await writeFile(patchPath, patchBytes);
    return await new Promise<boolean>((done) => {
      const child = spawn("git", ["apply", "--check", "--whitespace=nowarn", patchPath], { cwd: directory, stdio: "ignore", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
      child.once("error", () => done(false));
      child.once("exit", (code) => done(code === 0));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function assetSummary(asset: Asset, packIds: readonly string[]): AdminAssetSummary {
  return Object.freeze({
    id: asset.id,
    displayName: asset.display,
    tradingViewSymbol: asset.tradingView,
    logicalChannel: asset.channel,
    packMembershipCount: packIds.length,
    packIds: Object.freeze([...packIds]),
    ...(asset.currency === undefined ? {} : { currency: asset.currency }),
    ...(asset.tradingViewAliases === undefined ? {} : { tradingViewAliases: Object.freeze([...asset.tradingViewAliases]) }),
  });
}

export class AdminService {
  readonly repositoryRoot: string;
  readonly workspace: AdminWorkspace;
  readonly promotions: AdminPromotionWorkspace;
  readonly assetRegistrations: AdminAssetRegistrationWorkspace;
  readonly packBuilder: AdminPackBuilderWorkspace;
  readonly standaloneRenders: AdminStandaloneRenderWorkspace;
  readonly packRenders: AdminPackRenderWorkspace;
  readonly packCaptureSessions: AdminPackCaptureSessionWorkspace;
  readonly packRevisions: AdminPackRevisionWorkspace;
  readonly threadProvisioning: AdminThreadProvisioningWorkspace;
  readonly publication: AdminPublicationWorkspace;
  readonly serverConfiguration: AdminServerConfigurationWorkspace;
  readonly releases: ReleaseStore;
  #state: LiveState;
  #packMutationLock: Promise<void> = Promise.resolve();
  #threadMutationLock: Promise<void> = Promise.resolve();
  #registryLogoMutationLock: Promise<void> = Promise.resolve();
  #canonicalSourceMutationLock: Promise<void> = Promise.resolve();
  #registryCsvImports = new Map<string, AdminRegistryCsvImportRecord>();
  #publicationPreviews = new Map<string, AdminPackPublicationPreview>();
  #serverConfigurationPreviews = new Map<string, AdminServerConfigurationPreviewRecord>();
  #packMaintenancePreviews = new Map<string, AdminPackMaintenancePreviewRecord>();
  #aliasChangePreviews = new Map<string, AdminAliasChangePreviewRecord>();
  #publicationInProgress = false;
  readonly #openDiscordForumSession?: AdminDiscordForumSessionFactory;
  readonly #openDiscordForumProvisioningSession?: AdminDiscordForumProvisioningSessionFactory;
  readonly #openPublisherSession?: () => Promise<PublisherSessionShape>;
  readonly #openDiscordServerSession?: AdminDiscordServerSessionFactory;
  readonly #discordCredentialConfigured: boolean;

  private constructor(
    repositoryRoot: string,
    workspace: AdminWorkspace,
    promotions: AdminPromotionWorkspace,
    assetRegistrations: AdminAssetRegistrationWorkspace,
    packBuilder: AdminPackBuilderWorkspace,
    standaloneRenders: AdminStandaloneRenderWorkspace,
    packRenders: AdminPackRenderWorkspace,
    packCaptureSessions: AdminPackCaptureSessionWorkspace,
    packRevisions: AdminPackRevisionWorkspace,
    threadProvisioning: AdminThreadProvisioningWorkspace,
    publication: AdminPublicationWorkspace,
    serverConfiguration: AdminServerConfigurationWorkspace,
    releases: ReleaseStore,
    state: LiveState,
    openDiscordForumSession?: AdminDiscordForumSessionFactory,
    openDiscordForumProvisioningSession?: AdminDiscordForumProvisioningSessionFactory,
    openPublisherSession?: () => Promise<PublisherSessionShape>,
    openDiscordServerSession?: AdminDiscordServerSessionFactory,
    discordCredentialConfigured = false,
  ) {
    this.repositoryRoot = repositoryRoot;
    this.workspace = workspace;
    this.promotions = promotions;
    this.assetRegistrations = assetRegistrations;
    this.packBuilder = packBuilder;
    this.standaloneRenders = standaloneRenders;
    this.packRenders = packRenders;
    this.packCaptureSessions = packCaptureSessions;
    this.packRevisions = packRevisions;
    this.threadProvisioning = threadProvisioning;
    this.publication = publication;
    this.serverConfiguration = serverConfiguration;
    this.releases = releases;
    this.#state = state;
    this.#openDiscordForumSession = openDiscordForumSession;
    this.#openDiscordForumProvisioningSession = openDiscordForumProvisioningSession;
    this.#openPublisherSession = openPublisherSession;
    this.#openDiscordServerSession = openDiscordServerSession;
    this.#discordCredentialConfigured = discordCredentialConfigured;
  }

  static async create(options: AdminServiceOptions): Promise<AdminService> {
    const repositoryRoot = await resolveRepositoryRoot(options.repositoryRoot);
    const workspace = await AdminWorkspace.open({ workspaceRoot: options.workspaceRoot });
    if (pathInside(repositoryRoot, workspace.root) || pathInside(workspace.root, repositoryRoot)) {
      throw new AdminError("path_collision", "Repository root and administration workspace must be separate directories.");
    }
    const promotions = await AdminPromotionWorkspace.open(workspace.root);
    const assetRegistrations = await AdminAssetRegistrationWorkspace.open(workspace.root);
    const packBuilder = await AdminPackBuilderWorkspace.open(workspace.root);
    const standaloneRenders = await AdminStandaloneRenderWorkspace.open(workspace.root);
    const packRenders = await AdminPackRenderWorkspace.open(workspace.root);
    const packCaptureSessions = await AdminPackCaptureSessionWorkspace.open(
      workspace.root,
      options.chartDownloadsRoot,
    );
    const packRevisions = await AdminPackRevisionWorkspace.open(workspace.root);
    const threadProvisioning = await AdminThreadProvisioningWorkspace.open(workspace.root);
    const publication = await AdminPublicationWorkspace.open(workspace.root);
    const serverConfiguration = await AdminServerConfigurationWorkspace.open(workspace.root);
    const releases = createReleaseStore(publication.archiveRoot);
    const state = await AdminService.#loadState(repositoryRoot);
    return new AdminService(
      repositoryRoot,
      workspace,
      promotions,
      assetRegistrations,
      packBuilder,
      standaloneRenders,
      packRenders,
      packCaptureSessions,
      packRevisions,
      threadProvisioning,
      publication,
      serverConfiguration,
      releases,
      state,
      options.openDiscordForumSession,
      options.openDiscordForumProvisioningSession,
      options.openPublisherSession,
      options.openDiscordServerSession,
      options.discordCredentialConfigured ?? options.openDiscordServerSession !== undefined,
    );
  }

  static async #loadState(repositoryRoot: string): Promise<LiveState> {
    const registryFile = await readCanonicalFile(repositoryRoot, REGISTRY_RELATIVE_PATH);
    const packsFile = await readCanonicalFile(repositoryRoot, PACKS_RELATIVE_PATH);
    const channelsFile = await readCanonicalFile(repositoryRoot, CHANNELS_RELATIVE_PATH);
    const canonicalPaths = [registryFile.canonicalPath, packsFile.canonicalPath, channelsFile.canonicalPath];
    if (new Set(canonicalPaths).size !== canonicalPaths.length) {
      throw new AdminError("source_path_unsafe", "Canonical source files must be distinct regular files.");
    }

    const registryValue = parseJson(registryFile.bytes, REGISTRY_RELATIVE_PATH);
    const packsValue = parseJson(packsFile.bytes, PACKS_RELATIVE_PATH);
    const channelsValue = parseJson(channelsFile.bytes, CHANNELS_RELATIVE_PATH);
    if (!isRecord(registryValue)) throw new AdminError("invalid_registry", "Registry source must be a JSON object.");
    if (!Array.isArray(packsValue)) throw new AdminError("invalid_packs", "Pack source must be a JSON array.");
    if (!isRecord(channelsValue) || Object.keys(channelsValue).length === 0) {
      throw new AdminError("invalid_channel_configuration", "Channel configuration must be a nonempty JSON object.");
    }
    for (const key of Object.keys(channelsValue)) {
      const result = validateAssetRegistrationChannel(key, channelsValue);
      if (!result.ok) {
        throw new AdminError("invalid_channel_configuration", `Channel configuration key ${key} is unusable.`);
      }
    }

    let assets: readonly Asset[];
    try {
      assets = Object.freeze([...buildRegistry(registryValue as Record<string, Record<string, unknown>>, channelsValue).all()]);
    } catch (error) {
      throw new AdminError("invalid_registry", error instanceof Error ? error.message : String(error));
    }
    let packs: readonly Pack[];
    try {
      packs = Object.freeze([...buildPacks(
        packsValue,
        new Set(assets.map((asset) => asset.id)),
        new Set(Object.keys(channelsValue)),
      )]);
    } catch (error) {
      throw new AdminError("invalid_packs", error instanceof Error ? error.message : String(error));
    }

    const byAssetId = new Map(assets.map((asset) => [asset.id, asset] as const));
    const byPackId = new Map(packs.map((pack) => [pack.id, pack] as const));
    const memberships = new Map<string, string[]>();
    for (const pack of packs) {
      for (const assetId of pack.assets) {
        const existing = memberships.get(assetId) ?? [];
        existing.push(pack.id);
        memberships.set(assetId, existing);
      }
    }
    const assetPackIds = new Map<string, readonly string[]>();
    for (const asset of assets) {
      assetPackIds.set(asset.id, Object.freeze([...(memberships.get(asset.id) ?? [])]));
    }

    const audit = auditAssetMarketIdentity(
      assets,
      packs.map((pack) => Object.freeze({ id: pack.id, assets: Object.freeze([...pack.assets]) })),
    );

    return Object.freeze({
      registryFile,
      packsFile,
      channelsFile,
      rawRegistry: Object.freeze(registryValue as Record<string, Record<string, unknown>>),
      rawPacks: Object.freeze([...packsValue]),
      rawChannels: Object.freeze(channelsValue),
      assets,
      packs,
      byAssetId,
      byPackId,
      assetPackIds,
      registryFingerprint: computeAssetRegistrationRegistryFingerprint(assets, packs),
      audit,
    });
  }

  async refresh(): Promise<AdminStatus> {
    try {
      this.#state = await AdminService.#loadState(this.repositoryRoot);
      return this.status();
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError("source_reload_failed", "Could not refresh canonical source state.");
    }
  }

  status(): AdminStatus {
    const state = this.#state;
    return Object.freeze({
      schemaVersion: 1,
      canonicalState: "controlled_write",
      canonicalStateReadOnly: false,
      registryAssetCount: state.assets.length,
      packCount: state.packs.length,
      packMembershipCount: state.packs.reduce((sum, pack) => sum + pack.assets.length, 0),
      registryFingerprint: state.registryFingerprint,
      registrySourceSha256: state.registryFile.sha256,
      packSourceSha256: state.packsFile.sha256,
      channelConfigurationSha256: state.channelsFile.sha256,
      auditGapCount: state.audit.gaps.length,
      sourceIntegrity: "verified",
    });
  }

  audit(): AssetMarketIdentityAudit {
    return this.#state.audit;
  }

  validAssetIds(): ReadonlySet<string> {
    return new Set(this.#state.assets.map((asset) => asset.id));
  }

  logicalChannels(): readonly string[] {
    return Object.freeze(Object.keys(this.#state.rawChannels).sort((a, b) => a.localeCompare(b, "en")));
  }

  async serverConfigurationState(): Promise<AdminServerConfigurationState> {
    const { file, bindings } = await this.#readThreadBindings();
    const routes = this.logicalChannels().map((logicalChannel) => {
      const raw = this.#state.rawChannels[logicalChannel];
      const channelId = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
      const packIds = this.#state.packs
        .filter((pack) => pack.channel === logicalChannel)
        .map((pack) => pack.id);
      const boundThreadCount = packIds.reduce(
        (sum, packId) => sum + Object.keys(bindings.packs[packId] ?? {}).length,
        0,
      );
      return Object.freeze({
        logicalChannel,
        channelId,
        configured: channelId !== null,
        packIds: Object.freeze(packIds),
        registryAssetCount: this.#state.assets.filter((asset) => asset.channel === logicalChannel).length,
        boundThreadCount,
      });
    });
    return Object.freeze({
      schemaVersion: 1,
      credential: Object.freeze({
        configured: this.#discordCredentialConfigured,
        source: "process_environment" as const,
        editable: false as const,
        valueExposed: false as const,
      }),
      connectionTestAvailable: this.#openDiscordServerSession !== undefined,
      publisherTransport: "discord_bot_gateway" as const,
      webhooks: Object.freeze({
        used: false as const,
        configured: false as const,
        explanation: "VisionX publishes through the authenticated Discord bot gateway; no webhook secret is stored or required.",
      }),
      channelsSourceSha256: this.#state.channelsFile.sha256,
      threadBindingsSourceSha256: file.sha256,
      routes: Object.freeze(routes),
    });
  }

  async #inspectServerRouteMap(
    routes: Readonly<Record<string, string>>,
  ): Promise<AdminServerConnectionInspection> {
    if (this.#openDiscordServerSession === undefined) {
      throw new AdminError(
        "discord_operations_unavailable",
        "Discord server inspection is unavailable until the Administration process is started with a bot credential.",
        503,
      );
    }

    let session: DiscordServerAdministrationSession;
    try {
      session = await this.#openDiscordServerSession();
    } catch (error) {
      throw new AdminError(
        "server_connection_failed",
        `Discord connection failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }

    const warnings: Array<"discord_session_close_failed"> = [];
    let sessionClosed = false;
    const inspections: AdminServerRouteInspection[] = [];
    try {
      for (const logicalChannel of Object.keys(routes).sort((left, right) => left.localeCompare(right, "en"))) {
        const channelId = routes[logicalChannel] ?? "";
        if (channelId.length === 0) {
          inspections.push(Object.freeze({
            logicalChannel,
            channelId,
            state: "blocked" as const,
            facts: null,
            issues: Object.freeze(["No Discord forum channel ID is configured."]),
          }));
          continue;
        }
        try {
          const facts = await session.inspectForum(channelId);
          const issues = facts.missingPermissions.map(
            (permission) => `Missing required bot permission: ${permission}.`,
          );
          inspections.push(Object.freeze({
            logicalChannel,
            channelId,
            state: issues.length === 0 ? "ready" as const : "blocked" as const,
            facts,
            issues: Object.freeze(issues),
          }));
        } catch (error) {
          inspections.push(Object.freeze({
            logicalChannel,
            channelId,
            state: "blocked" as const,
            facts: null,
            issues: Object.freeze([error instanceof Error ? error.message : String(error)]),
          }));
        }
      }
    } finally {
      try {
        await session.close();
        sessionClosed = true;
      } catch {
        warnings.push("discord_session_close_failed");
      }
    }

    const guilds = new Map<string, string>();
    for (const route of inspections) {
      if (route.facts !== null) guilds.set(route.facts.guildId, route.facts.guildName);
    }
    const crossGuild = guilds.size > 1;
    const routesWithGuildIssues = crossGuild
      ? inspections.map((route) => Object.freeze({
          ...route,
          state: "blocked" as const,
          issues: Object.freeze([...route.issues, "Configured routes resolve to more than one Discord guild."]),
        }))
      : inspections;
    const guildEntry = guilds.size === 1 ? [...guilds.entries()][0] : undefined;
    return Object.freeze({
      schemaVersion: 1,
      operationallyReady:
        routesWithGuildIssues.length > 0 &&
        routesWithGuildIssues.every((route) => route.state === "ready") &&
        guilds.size === 1,
      bot: session.bot,
      guild: guildEntry === undefined
        ? null
        : Object.freeze({ id: guildEntry[0], name: guildEntry[1] }),
      routes: Object.freeze(routesWithGuildIssues),
      sessionClosed,
      warnings: Object.freeze(warnings),
      effects: Object.freeze({
        discordInspected: true as const,
        discordContentChanged: false as const,
        configurationChanged: false as const,
      }),
    });
  }

  async inspectServerConfiguration(): Promise<AdminServerConnectionInspection> {
    const routes: Record<string, string> = {};
    for (const logicalChannel of this.logicalChannels()) {
      const value = this.#state.rawChannels[logicalChannel];
      routes[logicalChannel] = typeof value === "string" ? value.trim() : "";
    }
    return this.#inspectServerRouteMap(routes);
  }

  async prepareServerConfiguration(
    input: { readonly routes: unknown },
    mode: "configuration" | "migration",
  ): Promise<AdminServerConfigurationPreview> {
    await this.refresh();
    const issues: AdminServerConfigurationIssue[] = [];
    if (!isRecord(input.routes)) {
      throw new AdminError("invalid_request", "Server route configuration must be an object.");
    }

    const currentNames = this.logicalChannels();
    const suppliedNames = Object.keys(input.routes).sort((left, right) => left.localeCompare(right, "en"));
    const { file: bindingsFile, bindings } = await this.#readThreadBindings();
    const currentRoutes: Record<string, string> = {};
    for (const logicalChannel of currentNames) {
      const value = this.#state.rawChannels[logicalChannel];
      currentRoutes[logicalChannel] = typeof value === "string" ? value.trim() : "";
    }

    for (const logicalChannel of suppliedNames) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(logicalChannel)) {
        issues.push(Object.freeze({
          code: "route_name_invalid" as const,
          logicalChannel,
          message: `Logical route ${logicalChannel || "(blank)"} must be a lowercase stable name of 1 to 64 characters, beginning with a letter.`,
        }));
      }
    }

    for (const logicalChannel of currentNames.filter((name) => !suppliedNames.includes(name))) {
      const packIds = this.#state.packs.filter((pack) => pack.channel === logicalChannel).map((pack) => pack.id);
      const registryAssetCount = this.#state.assets.filter((asset) => asset.channel === logicalChannel).length;
      const boundThreadCount = packIds.reduce(
        (sum, packId) => sum + Object.keys(bindings.packs[packId] ?? {}).length,
        0,
      );
      if (packIds.length > 0 || registryAssetCount > 0 || boundThreadCount > 0) {
        const dependencies = [
          ...(packIds.length === 0 ? [] : [`Packs ${packIds.join(", ")}`]),
          ...(registryAssetCount === 0 ? [] : [`${registryAssetCount} Registry Asset${registryAssetCount === 1 ? "" : "s"}`]),
          ...(boundThreadCount === 0 ? [] : [`${boundThreadCount} persistent thread binding${boundThreadCount === 1 ? "" : "s"}`]),
        ];
        issues.push(Object.freeze({
          code: "route_removal_blocked" as const,
          logicalChannel,
          message: `Route ${logicalChannel} cannot be removed because it is still used by ${dependencies.join(" and ")}. Reassign those dependencies first.`,
        }));
      }
    }

    const nextRoutes: Record<string, string> = {};
    const seenIds = new Map<string, string>();
    for (const logicalChannel of suppliedNames) {
      const raw = input.routes[logicalChannel];
      const isNew = !currentNames.includes(logicalChannel);
      if (
        typeof raw !== "string" ||
        raw.trim() !== raw ||
        (raw.length > 0 && !/^[0-9]{17,20}$/u.test(raw)) ||
        (isNew && raw.length === 0)
      ) {
        issues.push(Object.freeze({
          code: "channel_id_invalid" as const,
          logicalChannel,
          message: `${logicalChannel} must use one normalized 17- to 20-digit Discord Channel ID${isNew ? "" : " or remain explicitly unconfigured"}.`,
        }));
        nextRoutes[logicalChannel] = typeof raw === "string" ? raw.trim() : "";
        continue;
      }
      nextRoutes[logicalChannel] = raw;
      if (raw.length > 0) {
        const prior = seenIds.get(raw);
        if (prior !== undefined) {
          issues.push(Object.freeze({
            code: "channel_id_duplicate" as const,
            logicalChannel,
            message: `${logicalChannel} and ${prior} cannot resolve to the same Discord channel.`,
          }));
        } else {
          seenIds.set(raw, logicalChannel);
        }
      }
    }

    for (const pack of this.#state.packs) {
      if ((nextRoutes[pack.channel] ?? "").length === 0) {
        issues.push(Object.freeze({
          code: "pack_route_unconfigured" as const,
          logicalChannel: pack.channel,
          message: `Pack ${pack.id} requires route ${pack.channel} to remain configured.`,
        }));
      }
    }

    const allNames = [...new Set([...currentNames, ...suppliedNames])].sort((left, right) => left.localeCompare(right, "en"));
    const changedRoutes = allNames.filter((logicalChannel) => {
      const current = Object.hasOwn(currentRoutes, logicalChannel) ? currentRoutes[logicalChannel] : undefined;
      const next = Object.hasOwn(nextRoutes, logicalChannel) ? nextRoutes[logicalChannel] : undefined;
      return current !== next;
    });
    if (changedRoutes.length === 0) {
      issues.push(Object.freeze({
        code: "no_route_changes" as const,
        message: "The candidate does not add, remove, or change any Discord route.",
      }));
    }
    const affectedPackIds = this.#state.packs
      .filter((pack) => changedRoutes.includes(pack.channel))
      .map((pack) => pack.id);
    const bindingsToReestablish = affectedPackIds.reduce(
      (sum, packId) => sum + Object.keys(bindings.packs[packId] ?? {}).length,
      0,
    );
    if (mode === "configuration" && bindingsToReestablish > 0) {
      issues.push(Object.freeze({
        code: "binding_migration_required" as const,
        message: `${bindingsToReestablish} persistent thread binding${bindingsToReestablish === 1 ? "" : "s"} depend on changed routes. Use Server Migration so exact backups are preserved and affected bindings are cleared deliberately.`,
      }));
    }

    let inspection: AdminServerConnectionInspection | null = null;
    if (issues.length === 0) {
      if (this.#openDiscordServerSession === undefined) {
        issues.push(Object.freeze({
          code: "discord_unavailable" as const,
          message: "A live Discord connection test is required before channel configuration can be applied.",
        }));
      } else {
        inspection = await this.#inspectServerRouteMap(nextRoutes);
        if (!inspection.operationallyReady) {
          const crossGuild = new Set(
            inspection.routes.flatMap((route) => route.facts === null ? [] : [route.facts.guildId]),
          ).size > 1;
          if (crossGuild) {
            issues.push(Object.freeze({
              code: "cross_guild_routes" as const,
              message: "All configured VisionX routes must belong to one Discord guild.",
            }));
          }
          for (const route of inspection.routes.filter((entry) => entry.state === "blocked")) {
            issues.push(Object.freeze({
              code: "discord_route_blocked" as const,
              logicalChannel: route.logicalChannel,
              message: `${route.logicalChannel}: ${route.issues.join(" ")}`,
            }));
          }
        }
      }
    }

    const nextBindings: AssetThreadBindings = mode === "migration"
      ? Object.freeze({
          schemaVersion: 1 as const,
          packs: Object.freeze(Object.fromEntries(
            Object.entries(bindings.packs).filter(([packId]) => !affectedPackIds.includes(packId)),
          )),
        })
      : bindings;
    const channelsAfterBytes = Buffer.from(
      `${JSON.stringify(Object.fromEntries(suppliedNames.map((name) => [name, nextRoutes[name] ?? ""])), null, 2)}\n`,
      "utf8",
    );
    const threadBindingsAfterBytes = serializeAssetThreadBindings(nextBindings);
    const sourceState = Object.freeze({
      registrySha256: this.#state.registryFile.sha256,
      packsSha256: this.#state.packsFile.sha256,
      channelsSha256: this.#state.channelsFile.sha256,
      threadBindingsSha256: bindingsFile.sha256,
    });
    const confirmation = mode === "migration"
      ? `MIGRATE ${changedRoutes.length} ROUTE${changedRoutes.length === 1 ? "" : "S"}`
      : "APPLY SERVER CONFIGURATION";
    const previewId = createHash("sha256").update(JSON.stringify({
      mode,
      sourceState,
      channelsAfterSha256: sha256(channelsAfterBytes),
      threadBindingsAfterSha256: sha256(threadBindingsAfterBytes),
    })).digest("hex").slice(0, 32);
    const inspectionByRoute = new Map(
      (inspection?.routes ?? []).map((route) => [route.logicalChannel, route] as const),
    );
    const preview: AdminServerConfigurationPreview = Object.freeze({
      schemaVersion: 1,
      previewId,
      mode,
      valid: issues.length === 0,
      confirmation,
      changedRouteCount: changedRoutes.length,
      affectedPackIds: Object.freeze(affectedPackIds),
      bindingsToReestablish,
      issues: Object.freeze(issues),
      routes: Object.freeze(allNames.map((logicalChannel) => {
        const packIds = this.#state.packs.filter((pack) => pack.channel === logicalChannel).map((pack) => pack.id);
        return Object.freeze({
          logicalChannel,
          currentChannelId: Object.hasOwn(currentRoutes, logicalChannel) ? currentRoutes[logicalChannel] || null : null,
          nextChannelId: Object.hasOwn(nextRoutes, logicalChannel) ? nextRoutes[logicalChannel] || null : null,
          changed: changedRoutes.includes(logicalChannel),
          packIds: Object.freeze(packIds),
          boundThreadCount: packIds.reduce(
            (sum, packId) => sum + Object.keys(bindings.packs[packId] ?? {}).length,
            0,
          ),
          inspection: inspectionByRoute.get(logicalChannel) ?? null,
        });
      })),
      sourceState,
      effects: Object.freeze({
        channelsChanged: changedRoutes.length > 0,
        threadBindingsRemoved: mode === "migration" ? bindingsToReestablish : 0,
        unaffectedThreadBindingsPreserved: true as const,
        credentialsChanged: false as const,
        webhooksChanged: false as const,
        discordContentChanged: false as const,
        backupRequired: mode === "migration",
      }),
    });
    if (preview.valid) {
      if (this.#serverConfigurationPreviews.size >= 20) {
        const oldest = this.#serverConfigurationPreviews.keys().next().value as string | undefined;
        if (oldest !== undefined) this.#serverConfigurationPreviews.delete(oldest);
      }
      this.#serverConfigurationPreviews.set(previewId, Object.freeze({
        preview,
        channelsBeforeBytes: Buffer.from(this.#state.channelsFile.bytes),
        threadBindingsBeforeBytes: Buffer.from(bindingsFile.bytes),
        channelsAfterBytes,
        threadBindingsAfterBytes,
      }));
    }
    return preview;
  }

  prepareServerConfigurationChange(input: { readonly routes: unknown }): Promise<AdminServerConfigurationPreview> {
    return this.prepareServerConfiguration(input, "configuration");
  }

  prepareServerMigration(input: { readonly routes: unknown }): Promise<AdminServerConfigurationPreview> {
    return this.prepareServerConfiguration(input, "migration");
  }

  async applyServerConfiguration(
    previewId: string,
    confirmation: unknown,
  ): Promise<Readonly<Record<string, unknown>>> {
    const record = this.#serverConfigurationPreviews.get(previewId);
    if (record === undefined) {
      throw new AdminError(
        "server_configuration_preview_not_found",
        "Server-configuration preview was not found or is no longer valid.",
        404,
      );
    }
    if (confirmation !== record.preview.confirmation) {
      throw new AdminError(
        "server_configuration_confirmation_invalid",
        `Confirmation must equal ${record.preview.confirmation} exactly.`,
      );
    }
    return this.#withCanonicalSourceMutationLock(async () => {
      await this.refresh();
      const { file: bindingsFile } = await this.#readThreadBindings();
      if (
        this.#state.registryFile.sha256 !== record.preview.sourceState.registrySha256 ||
        this.#state.packsFile.sha256 !== record.preview.sourceState.packsSha256 ||
        this.#state.channelsFile.sha256 !== record.preview.sourceState.channelsSha256 ||
        bindingsFile.sha256 !== record.preview.sourceState.threadBindingsSha256
      ) {
        this.#serverConfigurationPreviews.delete(previewId);
        throw new AdminError(
          "server_configuration_state_changed",
          "Registry, Pack, Channel, or thread-binding state changed after review.",
          409,
        );
      }

      const liveCandidateRoutes = JSON.parse(record.channelsAfterBytes.toString("utf8")) as Record<string, string>;
      const liveRevalidation = await this.#inspectServerRouteMap(liveCandidateRoutes);
      if (!liveRevalidation.operationallyReady) {
        throw new AdminError(
          "server_configuration_blocked",
          "The reviewed Discord destination is no longer operationally ready. No source files were changed.",
          409,
          {
            blockedRoutes: liveRevalidation.routes
              .filter((route) => route.state === "blocked")
              .map((route) => route.logicalChannel),
          },
        );
      }

      // A live Discord test may take long enough for canonical context to move.
      // Recheck every reviewed source after the test and before preserving
      // migration evidence or replacing either installation-owned file.
      await this.refresh();
      const { file: revalidatedBindingsFile } = await this.#readThreadBindings();
      if (
        this.#state.registryFile.sha256 !== record.preview.sourceState.registrySha256 ||
        this.#state.packsFile.sha256 !== record.preview.sourceState.packsSha256 ||
        this.#state.channelsFile.sha256 !== record.preview.sourceState.channelsSha256 ||
        revalidatedBindingsFile.sha256 !== record.preview.sourceState.threadBindingsSha256
      ) {
        this.#serverConfigurationPreviews.delete(previewId);
        throw new AdminError(
          "server_configuration_state_changed",
          "Registry, Pack, Channel, or thread-binding state changed during final Discord validation.",
          409,
        );
      }

      if (record.preview.mode === "migration") {
        await this.serverConfiguration.stageMigrationEvidence({
          migrationId: previewId,
          channelsBefore: record.channelsBeforeBytes,
          threadBindingsBefore: record.threadBindingsBeforeBytes,
          channelsAfter: record.channelsAfterBytes,
          threadBindingsAfter: record.threadBindingsAfterBytes,
          preview: record.preview as unknown as Readonly<Record<string, unknown>>,
        });
      }

      let applied;
      try {
        applied = await applyServerConfigurationFile({
          repositoryRoot: this.repositoryRoot,
          expectedChannelsSha256: record.preview.sourceState.channelsSha256,
          expectedThreadBindingsSha256: record.preview.sourceState.threadBindingsSha256,
          channelsAfterBytes: record.channelsAfterBytes,
          threadBindingsAfterBytes: record.threadBindingsAfterBytes,
        });
      } catch (error) {
        if (error instanceof ServerConfigurationFileError) {
          const code = error.code === "stale_source_state"
            ? "server_configuration_state_changed"
            : error.code === "rollback_failed"
              ? "rollback_failed"
              : "source_write_failed";
          throw new AdminError(code, error.message, code === "server_configuration_state_changed" ? 409 : 500);
        }
        throw error;
      }

      this.#serverConfigurationPreviews.delete(previewId);
      await this.refresh();
      const warnings: string[] = [];
      if (record.preview.mode === "migration") {
        try {
          await this.serverConfiguration.completeMigration(previewId, Object.freeze({
            schemaVersion: 1,
            migrationId: previewId,
            completedAt: new Date().toISOString(),
            sourceState: applied,
          }));
        } catch {
          warnings.push("migration_completion_receipt_write_failed");
        }
      }
      return Object.freeze({
        schemaVersion: 1,
        previewId,
        mode: record.preview.mode,
        applied: true,
        affectedPackIds: record.preview.affectedPackIds,
        bindingsToReestablish: record.preview.bindingsToReestablish,
        sourceState: applied,
        backupId: record.preview.mode === "migration" ? previewId : null,
        warnings: Object.freeze([
          ...warnings,
          ...liveRevalidation.warnings,
        ]),
        liveValidation: Object.freeze({
          bot: liveRevalidation.bot,
          guild: liveRevalidation.guild,
          routeCount: liveRevalidation.routes.length,
          operationallyReady: true as const,
        }),
        effects: record.preview.effects,
        status: this.status(),
      });
    });
  }

  async #readThreadBindings(): Promise<{
    readonly file: CanonicalFile;
    readonly bindings: AssetThreadBindings;
  }> {
    const file = await readCanonicalFile(this.repositoryRoot, THREAD_BINDINGS_RELATIVE_PATH);
    let value: unknown;
    try {
      value = JSON.parse(file.bytes.toString("utf8")) as unknown;
    } catch {
      throw new AdminError("invalid_thread_bindings", "Thread bindings are not valid JSON.", 500);
    }

    let bindings: AssetThreadBindings;
    try {
      bindings = parseAssetThreadBindings(value);
    } catch {
      throw new AdminError("invalid_thread_bindings", "Thread bindings do not match the supported schema.", 500);
    }

    for (const [packId, assets] of Object.entries(bindings.packs)) {
      const pack = this.#state.byPackId.get(packId);
      if (pack === undefined) {
        throw new AdminError("invalid_thread_bindings", `Thread bindings reference unknown Pack ${packId}.`, 500);
      }
      for (const assetId of Object.keys(assets)) {
        if (!pack.assets.includes(assetId)) {
          throw new AdminError(
            "invalid_thread_bindings",
            `Thread bindings reference Asset ${assetId} outside Pack ${packId}.`,
            500,
          );
        }
      }
    }

    return Object.freeze({ file, bindings });
  }

  async threadManagementState(): Promise<AdminThreadManagementState> {
    const { file, bindings } = await this.#readThreadBindings();
    const resolveChannel = buildChannelResolver(this.#state.rawChannels as Record<string, unknown>);
    let boundCount = 0;
    const packs = this.#state.packs.map((pack) => {
      const assets = pack.assets.map((assetId) => {
        const asset = this.#state.byAssetId.get(assetId);
        if (asset === undefined) {
          throw new AdminError("invalid_registry", `Pack ${pack.id} references an unknown Asset.`, 500);
        }
        const threadId = bindings.packs[pack.id]?.[asset.id] ?? null;
        if (threadId !== null) boundCount += 1;
        return Object.freeze({
          id: asset.id,
          displayName: asset.display,
          bindingState: threadId === null ? "unbound" as const : "bound" as const,
          threadId,
        });
      });
      const packBoundCount = assets.filter((asset) => asset.bindingState === "bound").length;
      return Object.freeze({
        id: pack.id,
        displayName: pack.display,
        logicalChannel: pack.channel,
        forumConfigured: resolveChannel(pack.channel) !== null,
        boundCount: packBoundCount,
        totalCount: assets.length,
        missingCount: assets.length - packBoundCount,
        verificationEligible:
          assets.length > 0 &&
          packBoundCount === assets.length &&
          resolveChannel(pack.channel) !== null,
        assets: Object.freeze(assets),
      });
    });
    const totalCount = packs.reduce((sum, pack) => sum + pack.totalCount, 0);
    return Object.freeze({
      schemaVersion: 1,
      mode: this.#openDiscordForumProvisioningSession === undefined
        ? "adoption_only"
        : "adoption_and_provisioning",
      adoptionAvailable: this.#openDiscordForumSession !== undefined,
      provisioningAvailable: this.#openDiscordForumProvisioningSession !== undefined,
      publicationAvailable: false,
      bindingsSourceSha256: file.sha256,
      boundCount,
      totalCount,
      missingCount: totalCount - boundCount,
      packs: Object.freeze(packs),
    });
  }

  async inspectPackForum(input: {
    readonly packId: string;
    readonly confirmation: unknown;
  }): Promise<AdminThreadForumInspectionResult> {
    if (input.confirmation !== "inspect_forum_tags") {
      throw new AdminError(
        "thread_forum_inspection_confirmation_invalid",
        "Forum tag inspection requires an explicit current confirmation.",
      );
    }
    if (this.#openDiscordForumProvisioningSession === undefined) {
      throw new AdminError(
        "discord_operations_unavailable",
        "Discord forum inspection is unavailable until the administration process has an explicit bot token.",
        503,
      );
    }
    await this.refresh();
    const pack = this.#state.byPackId.get(input.packId);
    if (pack === undefined) {
      throw new AdminError("pack_not_found", `Pack ${input.packId} was not found.`, 404, { packId: input.packId });
    }
    const forumChannelId = buildChannelResolver(this.#state.rawChannels as Record<string, unknown>)(pack.channel);
    if (forumChannelId === null) {
      throw new AdminError("thread_forum_inspection_failed", "The selected Pack does not have a configured Discord forum.", 409);
    }

    let session: DiscordForumAdministrationSession | null = null;
    let facts;
    let operationError: unknown;
    try {
      session = await this.#openDiscordForumProvisioningSession();
      facts = await session.inspectForum(forumChannelId);
      if (facts.forumChannelId !== forumChannelId) {
        throw new Error("Discord forum inspection returned a different channel identity.");
      }
    } catch (error) {
      operationError = error;
    }
    let sessionClosed = true;
    if (session !== null) {
      try { await session.close(); }
      catch { sessionClosed = false; }
    }
    if (operationError !== undefined || facts === undefined) {
      throw new AdminError(
        "thread_forum_inspection_failed",
        "Discord forum inspection failed. No Discord content or local binding was changed.",
        502,
        { sessionClosed },
      );
    }
    if (facts.availableTags.length > 20) {
      throw new AdminError("thread_forum_inspection_failed", "Discord forum inspection returned more than 20 available tags.", 502);
    }
    const seen = new Set<string>();
    for (const tag of facts.availableTags) {
      if (!/^[0-9]{17,20}$/u.test(tag.id) || tag.name.length === 0 || seen.has(tag.id)) {
        throw new AdminError("thread_forum_inspection_failed", "Discord forum inspection returned invalid tag facts.", 502);
      }
      seen.add(tag.id);
    }
    return Object.freeze({
      schemaVersion: 1,
      packId: pack.id,
      forum: Object.freeze({
        name: facts.name,
        requiresTag: facts.requiresTag,
        availableTags: Object.freeze(facts.availableTags.map((tag) => Object.freeze({
          id: tag.id,
          name: tag.name,
          moderated: tag.moderated,
        }))),
      }),
      sessionClosed,
      warnings: Object.freeze(sessionClosed ? [] : ["discord_session_close_failed"] as const),
      effects: Object.freeze({
        discordInspected: true,
        discordContentChanged: false,
        bindingChanged: false,
        published: false,
        released: false,
      }),
    });
  }

  async stageThreadProvisioningLogo(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly bytes: Buffer;
  }): Promise<Readonly<Record<string, unknown>>> {
    if (this.#openDiscordForumProvisioningSession === undefined) {
      throw new AdminError("discord_operations_unavailable", "Discord thread provisioning is unavailable.", 503);
    }
    await this.refresh();
    const pack = this.#state.byPackId.get(input.packId);
    if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${input.packId} was not found.`, 404);
    if (!pack.assets.includes(input.assetId)) {
      throw new AdminError("thread_provisioning_failed", `Asset ${input.assetId} does not belong to Pack ${input.packId}.`, 400);
    }
    const { bindings } = await this.#readThreadBindings();
    if (bindings.packs[input.packId]?.[input.assetId] !== undefined) {
      throw new AdminError("thread_binding_conflict", "This Pack Asset already has a persistent Discord thread binding.", 409);
    }
    const stored = await this.threadProvisioning.saveLogo(input.packId, input.assetId, input.bytes);
    return Object.freeze({
      schemaVersion: 1,
      packId: stored.packId,
      assetId: stored.assetId,
      evidence: stored.evidence,
      effects: Object.freeze({ discordContacted: false, repositoryChanged: false }),
    });
  }

  async stageThreadProvisioningCanonicalLogo(input: {
    readonly packId: string;
    readonly assetId: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    const bytes = await this.readRegistryAssetLogo(input.assetId);
    const staged = await this.stageThreadProvisioningLogo({ ...input, bytes });
    return Object.freeze({ ...staged, source: "canonical_registry_logo" });
  }

  async #withRegistryLogoMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#registryLogoMutationLock;
    let release!: () => void;
    this.#registryLogoMutationLock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await prior;
    try { return await operation(); }
    finally { release(); }
  }

  async #withCanonicalSourceMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#canonicalSourceMutationLock;
    let release!: () => void;
    this.#canonicalSourceMutationLock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await prior;
    try { return await operation(); }
    finally { release(); }
  }

  async #withThreadMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#threadMutationLock;
    let release!: () => void;
    this.#threadMutationLock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await prior;
    try { return await operation(); }
    finally { release(); }
  }

  #threadRoutingVerificationFailure(
    result: Exclude<VerifyPackDiscordThreadRoutingResult, { readonly ok: true } | { readonly outcome: "thread_issues" }>,
    sessionClosed: boolean,
  ): never {
    switch (result.outcome) {
      case "unknown_pack":
        throw new AdminError("pack_not_found", `Pack ${result.packId} was not found.`, 404, { packId: result.packId });
      case "forum_channel_unresolved":
        throw new AdminError("thread_routing_verification_failed", "The selected Pack does not have a configured Discord forum.", 409, { outcome: result.outcome });
      case "missing_bindings":
        throw new AdminError(
          "thread_routing_incomplete",
          "Every Pack Asset requires a persistent thread binding before live routing verification.",
          409,
          { missingAssetIds: result.missingAssetIds },
        );
      case "invalid_binding":
      case "duplicate_binding":
        throw new AdminError("invalid_thread_bindings", "Persistent thread bindings are not coherent enough for verification.", 500, { outcome: result.outcome });
      case "discord_inspection_failed":
        throw new AdminError(
          "thread_routing_verification_failed",
          `Discord inspection failed while verifying Asset ${result.assetId}. No Discord content or local binding was changed.`,
          502,
          { outcome: result.outcome, assetId: result.assetId, sessionClosed },
        );
    }
  }

  async verifyPackThreadRouting(input: {
    readonly packId: string;
    readonly confirmation: unknown;
  }): Promise<AdminPackThreadRoutingVerificationResult> {
    if (input.confirmation !== "verify_pack_routing") {
      throw new AdminError(
        "thread_routing_verification_confirmation_invalid",
        "Live Pack routing verification requires an explicit current confirmation.",
      );
    }
    if (this.#openDiscordForumSession === undefined) {
      throw new AdminError(
        "discord_operations_unavailable",
        "Discord thread verification is unavailable until the administration process has an explicit bot token.",
        503,
      );
    }

    return this.#withThreadMutationLock(async () => {
      await this.refresh();
      const before = await this.#readThreadBindings();
      let session: DiscordForumSession | null = null;
      let result: VerifyPackDiscordThreadRoutingResult | undefined;
      let operationError: unknown;
      try {
        result = await verifyPackDiscordThreadRouting({
          packs: this.#state.packs,
          resolveChannel: buildChannelResolver(this.#state.rawChannels as Record<string, unknown>),
          resolveThread: (packId, assetId) => before.bindings.packs[packId]?.[assetId] ?? null,
          inspectThread: async (threadId) => {
            session ??= await this.#openDiscordForumSession!();
            return session.inspectThread(threadId);
          },
        }, input.packId);
      } catch (error) {
        operationError = error;
      }

      let sessionClosed = true;
      const openedSession = session as DiscordForumSession | null;
      if (openedSession !== null) {
        try { await openedSession.close(); }
        catch { sessionClosed = false; }
      }
      const after = await this.#readThreadBindings();
      if (after.file.sha256 !== before.file.sha256) {
        throw new AdminError(
          "thread_routing_state_changed",
          "Persistent thread bindings changed during live verification. The result was discarded.",
          409,
          { sessionClosed },
        );
      }
      if (operationError !== undefined) {
        throw new AdminError(
          "thread_routing_verification_failed",
          "Live Pack routing verification failed without changing Discord content or local bindings.",
          502,
          { sessionClosed },
        );
      }
      if (result === undefined) throw new AdminError("internal_error", "Pack routing verification produced no result.", 500);
      if (!result.ok && result.outcome !== "thread_issues") {
        return this.#threadRoutingVerificationFailure(result, sessionClosed);
      }

      const inspections = result.inspections;
      const assets = Object.freeze(inspections.map((item) => Object.freeze({
        assetId: item.assetId,
        threadId: item.threadId,
        name: item.name,
        state: item.issues.length === 0 ? "ready" as const : "blocked" as const,
        issues: Object.freeze([...item.issues]),
      })));
      const verifiedCount = assets.filter((asset) => asset.state === "ready").length;
      return Object.freeze({
        schemaVersion: 1,
        packId: result.packId,
        operationallyReady: result.ok && sessionClosed,
        bindingSourceSha256: before.file.sha256,
        verifiedCount,
        totalCount: assets.length,
        assets,
        sessionClosed,
        warnings: Object.freeze(sessionClosed ? [] : ["discord_session_close_failed"] as const),
        effects: Object.freeze({
          discordInspected: true,
          discordContentChanged: false,
          bindingChanged: false,
          published: false,
          released: false,
        }),
      });
    });
  }

  #threadAdoptionFailure(result: Exclude<AdoptDiscordAssetThreadResult, { readonly ok: true }>): never {
    const details = Object.freeze({ outcome: result.outcome });
    switch (result.outcome) {
      case "invalid_thread_id":
        throw new AdminError("thread_adoption_failed", "threadId must be a 17-to-20-digit Discord snowflake.", 400, details);
      case "unknown_pack":
        throw new AdminError("pack_not_found", `Pack ${result.packId} was not found.`, 404, { packId: result.packId });
      case "asset_not_in_pack":
        throw new AdminError("thread_adoption_failed", `Asset ${result.assetId} does not belong to Pack ${result.packId}.`, 400, details);
      case "forum_channel_unresolved":
        throw new AdminError("thread_adoption_failed", "The selected Pack does not have a configured Discord forum.", 409, details);
      case "thread_not_found":
        throw new AdminError("thread_adoption_failed", "The Discord thread was not found or is not visible to the bot.", 404, details);
      case "thread_parent_mismatch":
        throw new AdminError("thread_adoption_failed", "The Discord thread does not belong to the selected Pack forum.", 409, details);
      case "discord_inspection_failed":
        throw new AdminError("thread_adoption_failed", "Discord thread inspection failed. No binding was changed.", 502, details);
    }
  }

  async #inspectThreadCandidate(
    packId: string,
    assetId: string,
    threadId: string,
    bindThread: (
      verifiedPackId: string,
      verifiedAssetId: string,
      verifiedThreadId: string,
    ) => Promise<{ readonly changed: boolean }>,
  ): Promise<{
    readonly result: Extract<AdoptDiscordAssetThreadResult, { readonly ok: true }>;
    readonly sessionClosed: boolean;
  }> {
    let session: DiscordForumSession | null = null;
    let result: AdoptDiscordAssetThreadResult | undefined;
    let operationError: unknown;
    try {
      result = await adoptDiscordAssetThread({
        packs: this.#state.packs,
        resolveChannel: buildChannelResolver(this.#state.rawChannels as Record<string, unknown>),
        inspectThread: async (requestedThreadId) => {
          session ??= await this.#openDiscordForumSession!();
          return session.inspectThread(requestedThreadId);
        },
        bindThread,
      }, packId, assetId, threadId);
    } catch (error) {
      operationError = error;
    }

    let sessionClosed = true;
    const openedSession = session as DiscordForumSession | null;
    if (openedSession !== null) {
      try { await openedSession.close(); }
      catch { sessionClosed = false; }
    }
    if (operationError !== undefined) {
      if (operationError instanceof AssetThreadsError) {
        throw new AdminError(
          "thread_binding_write_failed",
          "The thread was verified, but its persistent binding could not be changed safely.",
          409,
          { sessionClosed },
        );
      }
      throw new AdminError(
        "thread_adoption_failed",
        "Discord thread inspection failed. No automatic retry was attempted.",
        502,
        { sessionClosed },
      );
    }
    if (result === undefined) {
      throw new AdminError("internal_error", "Discord thread inspection produced no result.", 500);
    }
    if (!result.ok) return this.#threadAdoptionFailure(result);
    return Object.freeze({ result, sessionClosed });
  }

  #threadProvisioningFailure(
    result: Exclude<ProvisionDiscordAssetThreadResult, { readonly ok: true }>,
    sessionClosed: boolean,
  ): never {
    const details: Record<string, unknown> = { outcome: result.outcome, sessionClosed };
    if (
      result.outcome === "invalid_created_thread_retained" ||
      result.outcome === "binding_failed_thread_retained"
    ) details.retainedThreadId = result.thread.threadId;
    switch (result.outcome) {
      case "invalid_title":
        throw new AdminError("thread_provisioning_failed", result.detail, 400, details);
      case "invalid_tag_id":
      case "duplicate_tag_id":
        throw new AdminError("thread_provisioning_failed", "The selected Discord tag IDs are invalid.", 400, details);
      case "too_many_tags":
        throw new AdminError("thread_provisioning_failed", `At most ${result.maximum} Discord tags may be selected.`, 400, details);
      case "unknown_pack":
        throw new AdminError("pack_not_found", `Pack ${result.packId} was not found.`, 404, details);
      case "unknown_asset":
        throw new AdminError("asset_not_found", `Asset ${result.assetId} was not found.`, 404, details);
      case "asset_not_in_pack":
        throw new AdminError("thread_provisioning_failed", "The selected Asset does not belong to the selected Pack.", 400, details);
      case "forum_channel_unresolved":
      case "already_bound":
        throw new AdminError("thread_binding_conflict", "The Pack forum or Asset binding changed before provisioning.", 409, details);
      case "discord_provision_failed":
      case "invalid_created_thread_deleted":
      case "binding_failed_thread_deleted":
        throw new AdminError("thread_provisioning_failed", "Discord thread provisioning failed and no persistent binding was added. Do not retry without a fresh confirmation.", 502, details);
      case "invalid_created_thread_retained":
      case "binding_failed_thread_retained":
        throw new AdminError("thread_provisioning_failed", "A provisional Discord thread could not be bound or removed. Resolve the retained thread before any retry.", 502, details);
    }
  }

  async provisionNewThread(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly title: string;
    readonly appliedTagIds: readonly string[];
    readonly logoSha256: string;
    readonly confirmation: unknown;
  }): Promise<AdminThreadProvisioningResult> {
    if (input.confirmation !== "provision_new_thread") {
      throw new AdminError(
        "thread_provisioning_confirmation_invalid",
        "New-thread provisioning requires an explicit current confirmation.",
      );
    }
    if (this.#openDiscordForumProvisioningSession === undefined) {
      throw new AdminError("discord_operations_unavailable", "Discord thread provisioning is unavailable.", 503);
    }
    return this.#withThreadMutationLock(async () => {
      await this.refresh();
      const { bindings } = await this.#readThreadBindings();
      if (bindings.packs[input.packId]?.[input.assetId] !== undefined) {
        throw new AdminError("thread_binding_conflict", "This Pack Asset already has a persistent Discord thread binding.", 409);
      }
      const logo = await this.threadProvisioning.readLogo(input.packId, input.assetId, input.logoSha256);
      let session: DiscordForumAdministrationSession | null = null;
      let result: ProvisionDiscordAssetThreadResult | undefined;
      let operationError: unknown;
      try {
        result = await provisionDiscordAssetThread({
          packs: this.#state.packs,
          assets: this.#state.assets,
          resolveChannel: buildChannelResolver(this.#state.rawChannels as Record<string, unknown>),
          resolveThread: (packId, assetId) => bindings.packs[packId]?.[assetId] ?? null,
          createThread: async (createInput) => {
            session ??= await this.#openDiscordForumProvisioningSession!();
            return session.createThread(createInput);
          },
          deleteThread: async (threadId) => {
            if (session === null) throw new Error("Provisioning compensation session was not opened.");
            await session.deleteThread(threadId);
          },
          bindThread: async (packId, assetId, threadId) => {
            const written = await bindAssetThreadFile(
              join(this.repositoryRoot, THREAD_BINDINGS_RELATIVE_PATH),
              packId,
              assetId,
              threadId,
            );
            return Object.freeze({ changed: written.changed });
          },
        }, {
          packId: input.packId,
          assetId: input.assetId,
          title: input.title,
          appliedTagIds: Object.freeze([...input.appliedTagIds]),
          logo,
        });
      } catch (error) {
        operationError = error;
      }
      let sessionClosed = true;
      const openedSession = session as DiscordForumAdministrationSession | null;
      if (openedSession !== null) {
        try { await openedSession.close(); }
        catch { sessionClosed = false; }
      }
      if (operationError !== undefined) {
        throw new AdminError("thread_provisioning_failed", "Thread provisioning failed without an automatic retry.", 502, { sessionClosed });
      }
      if (result === undefined) throw new AdminError("internal_error", "Thread provisioning produced no result.", 500);
      if (!result.ok) return this.#threadProvisioningFailure(result, sessionClosed);
      return Object.freeze({
        schemaVersion: 1,
        outcome: "provisioned",
        packId: result.packId,
        assetId: result.assetId,
        thread: Object.freeze({
          threadId: result.thread.threadId,
          name: result.thread.name,
          appliedTagCount: result.thread.appliedTagIds.length,
        }),
        logoSha256: logo.evidence.sha256,
        sessionClosed,
        warnings: Object.freeze(sessionClosed ? [] : ["discord_session_close_failed"] as const),
        effects: Object.freeze({
          discordInspected: true,
          discordContentChanged: true,
          bindingChanged: true,
          published: false,
          released: false,
        }),
      });
    });
  }

  async adoptExistingThread(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly threadId: string;
    readonly confirmation: unknown;
  }): Promise<AdminThreadAdoptionResult> {
    if (input.confirmation !== "adopt_existing_thread") {
      throw new AdminError(
        "thread_adoption_confirmation_invalid",
        "Existing-thread adoption requires an explicit current confirmation.",
      );
    }
    if (this.#openDiscordForumSession === undefined) {
      throw new AdminError(
        "discord_operations_unavailable",
        "Discord thread inspection is unavailable until the administration process has an explicit bot token.",
        503,
      );
    }

    return this.#withThreadMutationLock(async () => {
      await this.refresh();
      const { bindings } = await this.#readThreadBindings();
      const currentThreadId = bindings.packs[input.packId]?.[input.assetId];
      if (currentThreadId !== undefined && currentThreadId !== input.threadId) {
        throw new AdminError(
          "thread_binding_conflict",
          "This Pack Asset already has a different persistent Discord thread binding.",
          409,
          { packId: input.packId, assetId: input.assetId },
        );
      }
      for (const [boundPackId, assets] of Object.entries(bindings.packs)) {
        for (const [boundAssetId, boundThreadId] of Object.entries(assets)) {
          if (
            boundThreadId === input.threadId &&
            (boundPackId !== input.packId || boundAssetId !== input.assetId)
          ) {
            throw new AdminError(
              "thread_binding_conflict",
              "This Discord thread is already the persistent destination for another Pack Asset.",
              409,
            );
          }
        }
      }

      let session: DiscordForumSession | null = null;
      let result: AdoptDiscordAssetThreadResult | undefined;
      let operationError: unknown;
      try {
        result = await adoptDiscordAssetThread({
          packs: this.#state.packs,
          resolveChannel: buildChannelResolver(this.#state.rawChannels as Record<string, unknown>),
          inspectThread: async (threadId) => {
            session ??= await this.#openDiscordForumSession!();
            return session.inspectThread(threadId);
          },
          bindThread: async (packId, assetId, threadId) => {
            const written = await bindAssetThreadFile(
              join(this.repositoryRoot, THREAD_BINDINGS_RELATIVE_PATH),
              packId,
              assetId,
              threadId,
            );
            return Object.freeze({ changed: written.changed });
          },
        }, input.packId, input.assetId, input.threadId);
      } catch (error) {
        operationError = error;
      }

      let sessionClosed = true;
      const openedSession = session as DiscordForumSession | null;
      if (openedSession !== null) {
        try { await openedSession.close(); }
        catch { sessionClosed = false; }
      }

      if (operationError !== undefined) {
        if (operationError instanceof AssetThreadsError) {
          throw new AdminError(
            "thread_binding_write_failed",
            "The thread was verified, but its persistent binding could not be recorded safely.",
            409,
          );
        }
        throw new AdminError("thread_adoption_failed", "Discord thread adoption failed. No retry was attempted.", 502);
      }
      if (result === undefined) {
        throw new AdminError("internal_error", "Thread adoption produced no result.", 500);
      }
      if (!result.ok) return this.#threadAdoptionFailure(result);

      return Object.freeze({
        schemaVersion: 1,
        outcome: result.outcome,
        packId: result.packId,
        assetId: result.assetId,
        thread: Object.freeze({
          threadId: result.thread.threadId,
          name: result.thread.name,
          archived: result.thread.archived,
          locked: result.thread.locked,
          appliedTagCount: result.thread.appliedTagIds.length,
        }),
        sessionClosed,
        warnings: Object.freeze(sessionClosed ? [] : ["discord_session_close_failed"] as const),
        effects: Object.freeze({
          discordInspected: true,
          discordContentChanged: false,
          bindingChanged: result.outcome === "adopted",
          published: false,
          released: false,
        }),
      });
    });
  }

  async inspectExistingThreadBinding(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly threadId: string;
    readonly confirmation: unknown;
  }): Promise<Readonly<Record<string, unknown>>> {
    if (input.confirmation !== "inspect_bound_thread") {
      throw new AdminError(
        "thread_binding_inspection_confirmation_invalid",
        "Bound-thread inspection requires an explicit current confirmation.",
      );
    }
    if (this.#openDiscordForumSession === undefined) {
      throw new AdminError(
        "discord_operations_unavailable",
        "Discord thread inspection is unavailable until the administration process has an explicit bot token.",
        503,
      );
    }

    return this.#withThreadMutationLock(async () => {
      await this.refresh();
      const before = await this.#readThreadBindings();
      const currentThreadId = before.bindings.packs[input.packId]?.[input.assetId];
      if (currentThreadId !== input.threadId) {
        throw new AdminError(
          "thread_binding_state_changed",
          "The persistent binding changed after it was loaded. Refresh before inspecting it.",
          409,
        );
      }
      const inspected = await this.#inspectThreadCandidate(
        input.packId,
        input.assetId,
        input.threadId,
        async () => Object.freeze({ changed: false }),
      );
      const after = await this.#readThreadBindings();
      if (
        after.file.sha256 !== before.file.sha256 ||
        after.bindings.packs[input.packId]?.[input.assetId] !== input.threadId
      ) {
        throw new AdminError(
          "thread_binding_state_changed",
          "The persistent binding changed during Discord inspection. The result was discarded.",
          409,
          { sessionClosed: inspected.sessionClosed },
        );
      }
      return Object.freeze({
        schemaVersion: 1,
        outcome: "inspected",
        packId: input.packId,
        assetId: input.assetId,
        bindingSourceSha256: before.file.sha256,
        thread: Object.freeze({
          threadId: inspected.result.thread.threadId,
          name: inspected.result.thread.name,
          archived: inspected.result.thread.archived,
          locked: inspected.result.thread.locked,
          appliedTagCount: inspected.result.thread.appliedTagIds.length,
        }),
        sessionClosed: inspected.sessionClosed,
        warnings: Object.freeze(inspected.sessionClosed ? [] : ["discord_session_close_failed"] as const),
        effects: Object.freeze({
          discordInspected: true,
          discordContentChanged: false,
          bindingChanged: false,
          published: false,
          released: false,
        }),
      });
    });
  }

  async replaceExistingThreadBinding(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly currentThreadId: string;
    readonly nextThreadId: string;
    readonly confirmation: unknown;
  }): Promise<Readonly<Record<string, unknown>>> {
    if (input.confirmation !== "replace_thread_binding") {
      throw new AdminError(
        "thread_binding_replace_confirmation_invalid",
        "Thread-binding replacement requires an explicit current confirmation.",
      );
    }
    if (this.#openDiscordForumSession === undefined) {
      throw new AdminError(
        "discord_operations_unavailable",
        "Discord thread inspection is unavailable until the administration process has an explicit bot token.",
        503,
      );
    }
    if (input.currentThreadId === input.nextThreadId) {
      throw new AdminError(
        "thread_binding_conflict",
        "The replacement thread must differ from the current persistent binding.",
        409,
      );
    }

    return this.#withThreadMutationLock(async () => {
      await this.refresh();
      const before = await this.#readThreadBindings();
      if (before.bindings.packs[input.packId]?.[input.assetId] !== input.currentThreadId) {
        throw new AdminError(
          "thread_binding_state_changed",
          "The persistent binding changed after it was loaded. Refresh before replacing it.",
          409,
        );
      }
      for (const [boundPackId, assets] of Object.entries(before.bindings.packs)) {
        for (const [boundAssetId, boundThreadId] of Object.entries(assets)) {
          if (
            boundThreadId === input.nextThreadId &&
            (boundPackId !== input.packId || boundAssetId !== input.assetId)
          ) {
            throw new AdminError(
              "thread_binding_conflict",
              "The replacement Discord thread is already bound to another Pack Asset.",
              409,
            );
          }
        }
      }
      const inspected = await this.#inspectThreadCandidate(
        input.packId,
        input.assetId,
        input.nextThreadId,
        async (packId, assetId, threadId) => {
          const written = await replaceAssetThreadBindingFile(
            join(this.repositoryRoot, THREAD_BINDINGS_RELATIVE_PATH),
            packId,
            assetId,
            input.currentThreadId,
            threadId,
          );
          return Object.freeze({ changed: written.changed });
        },
      );
      return Object.freeze({
        schemaVersion: 1,
        outcome: "rebound",
        packId: input.packId,
        assetId: input.assetId,
        previousThreadId: input.currentThreadId,
        thread: Object.freeze({
          threadId: inspected.result.thread.threadId,
          name: inspected.result.thread.name,
          archived: inspected.result.thread.archived,
          locked: inspected.result.thread.locked,
          appliedTagCount: inspected.result.thread.appliedTagIds.length,
        }),
        sessionClosed: inspected.sessionClosed,
        warnings: Object.freeze(inspected.sessionClosed ? [] : ["discord_session_close_failed"] as const),
        effects: Object.freeze({
          discordInspected: true,
          discordContentChanged: false,
          bindingChanged: true,
          published: false,
          released: false,
        }),
      });
    });
  }

  async removeExistingThreadBinding(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly currentThreadId: string;
    readonly confirmation: unknown;
  }): Promise<Readonly<Record<string, unknown>>> {
    if (input.confirmation !== "remove_thread_binding") {
      throw new AdminError(
        "thread_binding_remove_confirmation_invalid",
        "Thread-binding removal requires an explicit current confirmation.",
      );
    }
    return this.#withThreadMutationLock(async () => {
      await this.refresh();
      const before = await this.#readThreadBindings();
      if (before.bindings.packs[input.packId]?.[input.assetId] !== input.currentThreadId) {
        throw new AdminError(
          "thread_binding_state_changed",
          "The persistent binding changed after it was loaded. Refresh before removing it.",
          409,
        );
      }
      let written;
      try {
        written = await unbindAssetThreadFile(
          join(this.repositoryRoot, THREAD_BINDINGS_RELATIVE_PATH),
          input.packId,
          input.assetId,
          input.currentThreadId,
        );
      } catch (error) {
        if (error instanceof AssetThreadsError) {
          throw new AdminError(
            "thread_binding_write_failed",
            "The persistent binding could not be removed safely.",
            409,
          );
        }
        throw error;
      }
      return Object.freeze({
        schemaVersion: 1,
        outcome: "unbound",
        packId: input.packId,
        assetId: input.assetId,
        removedThreadId: input.currentThreadId,
        bindingSourceSha256: sha256(written.bytes),
        effects: Object.freeze({
          discordContacted: false,
          discordContentChanged: false,
          bindingChanged: true,
          published: false,
          released: false,
        }),
      });
    });
  }

  standaloneRenderOptions(): AdminStandaloneRenderOptions {
    const auditByAssetId = new Map(this.#state.audit.assets.map((entry) => [entry.assetId, entry] as const));
    const assets = [...this.#state.assets]
      .sort((a, b) => a.id.localeCompare(b.id, "en"))
      .map((asset) => {
        const audit = auditByAssetId.get(asset.id);
        if (audit === undefined) {
          throw new AdminError("internal_error", `Asset ${asset.id} is missing from the market-identity audit.`, 500);
        }
        const renderReady = audit.marketIdentityStatus === "complete" && audit.currencyStatus === "valid";
        return Object.freeze({
          id: asset.id,
          displayName: asset.display,
          tradingViewSymbol: asset.tradingView,
          logicalChannel: asset.channel,
          ...(audit.currency === undefined ? {} : { currency: audit.currency }),
          renderReady,
          reconciliationIssues: Object.freeze([...audit.issues]),
        });
      });
    const renderableAssetCount = assets.filter((asset) => asset.renderReady).length;
    const reconciliationRequiredCount = assets.length - renderableAssetCount;
    return Object.freeze({
      schemaVersion: 1,
      timeframes: Object.freeze([...SUPPORTED_CHART_PUBLICATION_TIMEFRAMES]),
      assets: Object.freeze(assets),
      renderableAssetCount,
      reconciliationRequiredCount,
      unavailableAssetCount: reconciliationRequiredCount,
    });
  }

  async renderStandaloneChart(input: {
    readonly assetId: string;
    readonly timeframe: unknown;
    readonly sourceFilename: string;
    readonly sourceBytes: Buffer;
    readonly watermarkEnabled?: boolean;
  }): Promise<AdminStandaloneRenderResult> {
    const asset = this.#state.byAssetId.get(input.assetId);
    if (asset === undefined) {
      throw new AdminError("asset_not_found", `Asset ${input.assetId} was not found.`, 404, { assetId: input.assetId });
    }
    const identityAudit = this.#state.audit.assets.find((entry) => entry.assetId === asset.id);
    if (
      identityAudit === undefined ||
      identityAudit.marketIdentityStatus !== "complete" ||
      identityAudit.currencyStatus !== "valid" ||
      identityAudit.currency === undefined
    ) {
      throw new AdminError(
        "invalid_standalone_render",
        `Asset ${asset.id} needs qualified TradingView identity and canonical currency before rendering.`,
        400,
        { assetId: asset.id, reconciliationIssues: identityAudit?.issues ?? [] },
      );
    }
    const timeframe = validateChartPublicationTimeframe(input.timeframe);
    if (!timeframe.ok) {
      throw new AdminError("invalid_standalone_render", timeframe.detail);
    }

    const task = await this.standaloneRenders.createTask(input.sourceFilename, input.sourceBytes);
    const rendered = await previewChartPublicationFile({
      inputPath: task.sourcePath,
      request: {
        context: "standalone",
        assetId: asset.id,
        timeframe: timeframe.timeframe,
      },
      outputPath: task.outputPath,
      receiptPath: task.receiptPath,
      registryPath: this.#state.registryFile.canonicalPath,
      channelsPath: this.#state.channelsFile.canonicalPath,
      packsPath: this.#state.packsFile.canonicalPath,
      watermarkEnabled: input.watermarkEnabled !== false,
    });
    if (!rendered.ok) {
      await this.standaloneRenders.discardTask(task.renderId);
      throw new AdminError(
        "standalone_render_failed",
        rendered.detail,
        400,
        { reason: rendered.reason },
      );
    }
    if (rendered.context !== "standalone") {
      await this.standaloneRenders.discardTask(task.renderId);
      throw new AdminError("internal_error", "Standalone renderer returned an incompatible context.", 500);
    }

    return Object.freeze({
      schemaVersion: 1,
      renderId: task.renderId,
      asset: Object.freeze({
        id: asset.id,
        displayName: asset.display,
        tradingViewSymbol: asset.tradingView,
        logicalChannel: asset.channel,
        currency: identityAudit.currency,
        renderReady: true,
        reconciliationIssues: Object.freeze([]),
      }),
      timeframe: rendered.timeframe,
      dataAsOf: rendered.dataAsOf,
      sourceBasename: rendered.sourceBasename,
      outputSha256: rendered.outputSha256,
      watermarkEnabled: rendered.receipt.branding.watermark.opacity > 0,
      publicationUrl: `/api/v1/standalone-renders/${task.renderId}/publication.png`,
      receiptUrl: `/api/v1/standalone-renders/${task.renderId}/receipt.json`,
      effects: Object.freeze({
        packWorkspaceChanged: false,
        staged: false,
        released: false,
        discordContacted: false,
      }),
    });
  }

  readStandaloneRenderArtifact(
    renderId: string,
    artifact: StandaloneRenderArtifactName,
  ): Promise<Buffer> {
    return this.standaloneRenders.readArtifact(renderId, artifact);
  }

  #packRuntime(): AdminPackRuntime {
    return Object.freeze({
      workspace: createPersistentWorkspace({
        packs: this.#state.packs,
        path: this.packRenders.sessionPath,
      }),
      staging: createStagingStore(this.packRenders.stagingRoot),
    });
  }

  #publicationDependencies(
    runtime: AdminPackRuntime,
    bindings: AssetThreadBindings,
  ) {
    const resolveChannel = buildChannelResolver(this.#state.rawChannels as Record<string, unknown>);
    return Object.freeze({
      workspace: runtime.workspace,
      staging: runtime.staging,
      releases: this.releases,
      resolveChannel,
      resolveAssetThread: (packId: string, assetId: string): string | null =>
        bindings.packs[packId]?.[assetId] ?? null,
    });
  }

  async #packPublicationState(
    pack: Pack,
    runtime: AdminPackRuntime,
    bindings: AssetThreadBindings,
    supersedeInterrupted: boolean,
  ): Promise<AdminPackPublicationState> {
    const dependencies = this.#publicationDependencies(runtime, bindings);
    const ordinary = inspectPackPublishReadiness(dependencies, pack.id, {
      supersedeInterrupted,
    });
    const withoutSupersession = supersedeInterrupted
      ? inspectPackPublishReadiness(dependencies, pack.id, { supersedeInterrupted: false })
      : ordinary;
    const interruptedBlocker = withoutSupersession.blockers.find(
      (blocker): blocker is Extract<PackPublishBlocker, { readonly code: "interrupted_release_exists" }> =>
        blocker.code === "interrupted_release_exists",
    ) ?? null;
    const blockers: AdminPackPublicationBlocker[] = [...ordinary.blockers];
    if (this.#openPublisherSession === undefined) {
      blockers.push(Object.freeze({ code: "discord_unavailable" as const }));
    }
    const interruptedRelease = interruptedBlocker === null ? null : Object.freeze({
      releaseId: interruptedBlocker.releaseId,
      startedAt: interruptedBlocker.startedAt,
      postedCount: interruptedBlocker.postedCount,
      totalCount: interruptedBlocker.totalCount,
    });
    return Object.freeze({
      state: interruptedRelease !== null && !supersedeInterrupted
        ? "interrupted" as const
        : blockers.length === 0
          ? "ready" as const
          : "blocked" as const,
      ready: blockers.length === 0,
      capturedCount: ordinary.capturedCount,
      totalCount: ordinary.totalCount,
      stagedCount: ordinary.stagedCount,
      resolvedThreadCount: ordinary.resolvedThreadCount,
      blockers: Object.freeze(blockers),
      interruptedRelease,
    });
  }

  async packWorkspaceState(): Promise<AdminPackWorkspaceState> {
    const runtime = this.#packRuntime();
    await this.packRevisions.reconcile(runtime.workspace, await this.packRenders.listAcceptedPreviews());
    const { bindings } = await this.#readThreadBindings();
    const auditByAssetId = new Map(this.#state.audit.assets.map((entry) => [entry.assetId, entry] as const));
    const packs = await Promise.all(this.#state.packs.map(async (pack) => {
      const assets = await Promise.all(pack.assets.map(async (assetId) => {
        const asset = this.#state.byAssetId.get(assetId);
        if (asset === undefined) throw new AdminError("invalid_registry", `Pack ${pack.id} references an unknown Asset.`);
        const audit = auditByAssetId.get(asset.id);
        if (audit === undefined) throw new AdminError("internal_error", `Asset ${asset.id} is missing from the market-identity audit.`, 500);
        const capture = runtime.workspace.captureOf(asset.id);
        const revisionHistory = await this.packRevisions.list(pack.id, asset.id);
        return Object.freeze({
          id: asset.id,
          displayName: asset.display,
          tradingViewSymbol: asset.tradingView,
          currency: audit.currency ?? "",
          renderReady: audit.marketIdentityStatus === "complete" && audit.currencyStatus === "valid",
          reconciliationIssues: Object.freeze([...audit.issues]),
          captured: capture !== null,
          artifactReady: runtime.staging.has(asset.id),
          revisions: capture?.revisions ?? 0,
          capturedAt: capture?.capturedAt ?? null,
          revisionHistory: Object.freeze(revisionHistory.map((revision) => Object.freeze({
            revision: revision.revision,
            previewId: revision.previewId,
            acceptedAt: revision.acceptedAt,
            sourceBasename: revision.sourceBasename,
            timeframe: revision.timeframe,
            dataAsOf: revision.dataAsOf,
            outputSha256: revision.outputSha256,
            current: capture?.revisions === revision.revision,
            confirmed: true as const,
            publicationUrl: `/api/v1/pack-workspace/packs/${pack.id}/assets/${asset.id}/revisions/${revision.revision}/publication.png`,
            receiptUrl: `/api/v1/pack-workspace/packs/${pack.id}/assets/${asset.id}/revisions/${revision.revision}/receipt.json`,
          }))),
        });
      }));
      const remainingRequiredAssetIds = Object.freeze([...runtime.workspace.pendingAssets(pack.id)]);
      return Object.freeze({
        id: pack.id,
        displayName: pack.display,
        logicalChannel: pack.channel,
        timeframe: defaultChartPublicationTimeframeForPack(pack),
        state: runtime.workspace.packState(pack.id),
        capturedCount: pack.assets.length - remainingRequiredAssetIds.length,
        totalCount: pack.assets.length,
        remainingRequiredAssetIds,
        publication: await this.#packPublicationState(pack, runtime, bindings, false),
        assets: Object.freeze(assets),
      });
    }));
    return Object.freeze({
      schemaVersion: 1,
      publishAvailable: this.#openPublisherSession !== undefined,
      publicationInProgress: this.#publicationInProgress,
      packs: Object.freeze(packs),
    });
  }

  async #publicationWorkspaceFingerprint(
    packIds: readonly string[],
    runtime: AdminPackRuntime,
  ): Promise<string> {
    const packEvidence = [];
    for (const packId of packIds) {
      const pack = this.#state.byPackId.get(packId);
      if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404);
      const assets = [];
      for (const assetId of pack.assets) {
        const capture = runtime.workspace.captureOf(assetId);
        const staged = runtime.staging.get(assetId);
        let stagedSha256: string | null = null;
        if (staged !== null) {
          try { stagedSha256 = sha256(await readFile(staged.path)); }
          catch { stagedSha256 = "unreadable"; }
        }
        assets.push(Object.freeze({
          assetId,
          capture: capture === null ? null : Object.freeze({
            capturedAt: capture.capturedAt,
            revisions: capture.revisions,
          }),
          stagedSha256,
        }));
      }
      const releases = this.releases.listReleases(pack.id)
        .map((release) => Object.freeze({
          releaseId: release.releaseId,
          startedAt: release.startedAt,
          publishedAt: release.publishedAt,
          postedAssetIds: Object.freeze(release.analyses
            .filter((analysis) => analysis.discordMessageId !== null)
            .map((analysis) => analysis.assetId)),
        }))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.releaseId.localeCompare(right.releaseId));
      packEvidence.push(Object.freeze({
        packId,
        assets: Object.freeze(assets),
        releases: Object.freeze(releases),
      }));
    }
    return sha256(Buffer.from(JSON.stringify(packEvidence), "utf8"));
  }

  async #buildPackPublicationPreview(
    packIds: readonly string[],
    supersedePackIds: readonly string[],
    previewId: string,
  ): Promise<AdminPackPublicationPreview> {
    if (packIds.length === 0) {
      throw new AdminError("invalid_request", "Select at least one Pack for publication.");
    }
    if (new Set(packIds).size !== packIds.length || new Set(supersedePackIds).size !== supersedePackIds.length) {
      throw new AdminError("invalid_request", "Pack publication selections must not contain duplicates.");
    }
    const selected = new Set(packIds);
    const supersede = new Set(supersedePackIds);
    if ([...supersede].some((packId) => !selected.has(packId))) {
      throw new AdminError("invalid_request", "A superseded Pack must also be selected for publication.");
    }
    for (const packId of selected) {
      if (!this.#state.byPackId.has(packId)) {
        throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404, { packId });
      }
    }

    const canonicalPackIds = this.#state.packs.filter((pack) => selected.has(pack.id)).map((pack) => pack.id);
    const canonicalSupersedePackIds = canonicalPackIds.filter((packId) => supersede.has(packId));
    const runtime = this.#packRuntime();
    await this.packRevisions.reconcile(runtime.workspace, await this.packRenders.listAcceptedPreviews());
    const { file: bindingsFile, bindings } = await this.#readThreadBindings();
    const packs = await Promise.all(canonicalPackIds.map(async (packId) => {
      const pack = this.#state.byPackId.get(packId);
      if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404);
      return Object.freeze({
        id: pack.id,
        displayName: pack.display,
        action: supersede.has(pack.id) ? "supersede" as const : "publish" as const,
        publication: await this.#packPublicationState(pack, runtime, bindings, supersede.has(pack.id)),
      });
    }));
    const workspaceFingerprint = await this.#publicationWorkspaceFingerprint(canonicalPackIds, runtime);
    const confirmation = `PUBLISH ${canonicalPackIds.length} PACK${canonicalPackIds.length === 1 ? "" : "S"}`;
    return Object.freeze({
      schemaVersion: 1,
      previewId,
      valid: packs.every((pack) => pack.publication.ready),
      confirmation,
      selectedPackIds: Object.freeze(canonicalPackIds),
      supersedePackIds: Object.freeze(canonicalSupersedePackIds),
      packs: Object.freeze(packs),
      sourceState: Object.freeze({
        registrySha256: this.#state.registryFile.sha256,
        packsSha256: this.#state.packsFile.sha256,
        channelsSha256: this.#state.channelsFile.sha256,
        threadBindingsSha256: bindingsFile.sha256,
        workspaceFingerprint,
      }),
      effects: Object.freeze({
        releasesCreated: canonicalPackIds.length,
        discordPostsPlanned: packs.reduce((sum, pack) => sum + pack.publication.totalCount, 0),
        selectedPacksResetOnSuccess: true as const,
        unselectedPacksChanged: false as const,
      }),
    });
  }

  async preparePackPublication(input: {
    readonly packIds: readonly string[];
    readonly supersedePackIds?: readonly string[];
  }): Promise<AdminPackPublicationPreview> {
    await this.refresh();
    const previewId = randomBytes(16).toString("hex");
    const preview = await this.#buildPackPublicationPreview(
      input.packIds,
      input.supersedePackIds ?? [],
      previewId,
    );
    this.#publicationPreviews.set(previewId, preview);
    return preview;
  }

  async applyPackPublication(
    previewId: string,
    confirmation: unknown,
  ): Promise<AdminPackPublicationResult> {
    return this.#withPackMutationLock(async () => {
      const preview = this.#publicationPreviews.get(previewId);
      if (preview === undefined) {
        throw new AdminError("pack_publication_preview_not_found", "Publication preview was not found or was already used.", 404);
      }
      if (confirmation !== preview.confirmation) {
        throw new AdminError(
          "pack_publication_confirmation_invalid",
          `Publication requires the exact confirmation ${preview.confirmation}.`,
        );
      }
      if (this.#publicationInProgress) {
        throw new AdminError("pack_publication_in_progress", "Another publication operation is already running.", 409);
      }
      if (this.#openPublisherSession === undefined) {
        throw new AdminError("discord_operations_unavailable", "Publishing is unavailable until the Administration process has a Discord bot token.", 503);
      }

      this.#publicationInProgress = true;
      try {
        await this.refresh();
        const current = await this.#buildPackPublicationPreview(
          preview.selectedPackIds,
          preview.supersedePackIds,
          preview.previewId,
        );
        const sameState =
          current.sourceState.registrySha256 === preview.sourceState.registrySha256 &&
          current.sourceState.packsSha256 === preview.sourceState.packsSha256 &&
          current.sourceState.channelsSha256 === preview.sourceState.channelsSha256 &&
          current.sourceState.threadBindingsSha256 === preview.sourceState.threadBindingsSha256 &&
          current.sourceState.workspaceFingerprint === preview.sourceState.workspaceFingerprint;
        if (!sameState) {
          this.#publicationPreviews.delete(previewId);
          throw new AdminError(
            "pack_publication_state_changed",
            "Pack, capture-session, staging, route, or Release state changed after review. Create a new publication preview.",
            409,
          );
        }
        if (!current.valid) {
          this.#publicationPreviews.delete(previewId);
          throw new AdminError(
            "pack_publication_blocked",
            "Every selected Pack must be complete, staged, session-valid, routed, and free from unresolved Release blockers.",
            409,
            { packs: current.packs },
          );
        }

        this.#publicationPreviews.delete(previewId);
        const runtime = this.#packRuntime();
        const { bindings } = await this.#readThreadBindings();
        const baseDependencies = this.#publicationDependencies(runtime, bindings);
        const published: Extract<PublishPackResult, { readonly ok: true }>[] = [];
        let failed: AdminPackPublicationFailure | null = null;
        const notAttemptedPackIds: string[] = [];
        const cleanupWarnings: AdminPackPublicationCleanupWarning[] = [];

        for (let index = 0; index < current.selectedPackIds.length; index += 1) {
          const packId = current.selectedPackIds[index];
          if (packId === undefined) continue;
          let result: Extract<PublishPackResult, { readonly ok: true }> | AdminPackPublicationFailure;
          const releaseIdsBefore = new Set(this.releases.listReleases(packId).map((release) => release.releaseId));
          try {
            result = await publishPack({
              ...baseDependencies,
              openPublisher: this.#openPublisherSession,
              assetDisplay: (assetId) => this.#state.byAssetId.get(assetId)?.display ?? assetId,
              now: () => new Date().toISOString(),
            }, packId, {
              supersedeInterrupted: current.supersedePackIds.includes(packId),
            });
          } catch (error) {
            const createdRelease = this.releases.listReleases(packId)
              .filter((release) => !releaseIdsBefore.has(release.releaseId))
              .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
            if (createdRelease !== null && createdRelease.publishedAt !== null) {
              let workspaceReset = true;
              let stagingCleared = true;
              try { runtime.workspace.resetPack(packId); }
              catch {
                workspaceReset = false;
                cleanupWarnings.push(Object.freeze({ packId, code: "workspace_reset_failed" as const }));
              }
              try { runtime.staging.clear(createdRelease.analyses.map((analysis) => analysis.assetId)); }
              catch {
                stagingCleared = false;
                cleanupWarnings.push(Object.freeze({ packId, code: "staging_cleanup_failed" as const }));
              }
              if (!workspaceReset) {
                result = Object.freeze({
                  ok: false,
                  outcome: "publication_failed",
                  packId,
                  releaseId: createdRelease.releaseId,
                  publishedAssetIds: Object.freeze(createdRelease.analyses.map((analysis) => analysis.assetId)),
                  detail: `Discord publication completed, but the Pack workspace could not be reset: ${error instanceof Error ? error.message : String(error)}`,
                });
              } else {
                result = Object.freeze({
                  ok: true,
                  outcome: "published",
                  packId,
                  releaseId: createdRelease.releaseId,
                  publishedAssetIds: Object.freeze(createdRelease.analyses.map((analysis) => analysis.assetId)),
                  cleared: stagingCleared,
                });
              }
            } else {
              result = Object.freeze({
                ok: false,
                outcome: "publication_failed",
                packId,
                releaseId: createdRelease?.releaseId ?? null,
                publishedAssetIds: Object.freeze(createdRelease?.analyses
                  .filter((analysis) => analysis.discordMessageId !== null)
                  .map((analysis) => analysis.assetId) ?? []),
                detail: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (!result.ok) {
            failed = result;
            notAttemptedPackIds.push(...current.selectedPackIds.slice(index + 1));
            break;
          }
          if (!result.cleared) {
            cleanupWarnings.push(Object.freeze({ packId, code: "staging_cleanup_failed" as const }));
          }
          published.push(result);
          const pack = this.#state.byPackId.get(packId);
          if (pack !== undefined) {
            try { await this.packCaptureSessions.clearAcceptedAssets(packId, pack.assets); }
            catch { cleanupWarnings.push(Object.freeze({ packId, code: "capture_session_cleanup_failed" as const })); }
            try { await this.packRevisions.clearPack(pack); }
            catch { cleanupWarnings.push(Object.freeze({ packId, code: "revision_history_cleanup_failed" as const })); }
          }
        }

        return Object.freeze({
          schemaVersion: 1,
          outcome: failed === null
            ? "published" as const
            : published.length === 0
              ? "failed" as const
              : "partially_published" as const,
          previewId,
          selectedPackIds: current.selectedPackIds,
          published: Object.freeze(published),
          failed,
          notAttemptedPackIds: Object.freeze(notAttemptedPackIds),
          cleanupWarnings: Object.freeze(cleanupWarnings),
          effects: Object.freeze({
            discordContacted: published.length > 0 ||
              failed?.outcome === "publish_interrupted" ||
              (failed?.outcome === "publication_failed" && failed.publishedAssetIds.length > 0),
            releasesCreated: published.length + (
              failed?.outcome === "publish_interrupted" ||
              (failed?.outcome === "publication_failed" && failed.releaseId !== null)
                ? 1
                : 0
            ),
            packsReset: Object.freeze(published.map((result) => result.packId)),
          }),
        });
      } finally {
        this.#publicationInProgress = false;
      }
    });
  }

  async resumePackPublication(
    packId: string,
    confirmation: unknown,
  ): Promise<AdminPackResumeResult> {
    return this.#withPackMutationLock(async () => {
      if (confirmation !== `RESUME ${packId.toUpperCase()}`) {
        throw new AdminError(
          "pack_publication_confirmation_invalid",
          `Resume requires the exact confirmation RESUME ${packId.toUpperCase()}.`,
        );
      }
      if (this.#openPublisherSession === undefined) {
        throw new AdminError("discord_operations_unavailable", "Release resume is unavailable until the Administration process has a Discord bot token.", 503);
      }
      if (this.#publicationInProgress) {
        throw new AdminError("pack_publication_in_progress", "Another publication operation is already running.", 409);
      }
      this.#publicationInProgress = true;
      try {
        await this.refresh();
        const pack = this.#state.byPackId.get(packId);
        if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404);
        const runtime = this.#packRuntime();
        const result = await resumeInterruptedRelease({
          workspace: runtime.workspace,
          staging: runtime.staging,
          releases: this.releases,
          openPublisher: this.#openPublisherSession,
          now: () => new Date().toISOString(),
        }, packId);
        const cleanupWarnings: AdminPackPublicationCleanupWarning[] = [];
        if (result.ok) {
          if (!result.cleared) {
            cleanupWarnings.push(Object.freeze({ packId, code: "staging_cleanup_failed" as const }));
          }
          try { await this.packCaptureSessions.clearAcceptedAssets(packId, pack.assets); }
          catch { cleanupWarnings.push(Object.freeze({ packId, code: "capture_session_cleanup_failed" as const })); }
          try { await this.packRevisions.clearPack(pack); }
          catch { cleanupWarnings.push(Object.freeze({ packId, code: "revision_history_cleanup_failed" as const })); }
        }
        return Object.freeze({ schemaVersion: 1, result, cleanupWarnings: Object.freeze(cleanupWarnings) });
      } finally {
        this.#publicationInProgress = false;
      }
    });
  }

  async packCaptureSessionState(packId: string): Promise<PackCaptureSessionState> {
    const pack = this.#state.byPackId.get(packId);
    if (pack === undefined) {
      throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404, { packId });
    }
    return this.packCaptureSessions.state(pack);
  }

  async configurePackCaptureDownloadsFolder(path: string): Promise<Readonly<Record<string, unknown>>> {
    return this.#withPackMutationLock(async () => {
      await this.refresh();
      const pendingPreviewIds: string[] = [];
      for (const pack of this.#state.packs) {
        const session = await this.packCaptureSessions.state(pack);
        pendingPreviewIds.push(...session.candidates
          .filter((candidate) => candidate.state === "pending")
          .map((candidate) => candidate.previewId));
      }
      const downloadsFolder = await this.packCaptureSessions.configureDownloadsRoot(path);
      let discardedPendingPreviewCount = 0;
      for (const previewId of pendingPreviewIds) {
        try {
          await this.packRenders.discardPreview(previewId);
          discardedPendingPreviewCount += 1;
        } catch { /* stale previews are safe to ignore while resetting capture sessions */ }
      }
      const clearedSessionCount = await this.packCaptureSessions.clearAllSessions();
      return Object.freeze({
        schemaVersion: 1,
        downloadsFolder,
        clearedSessionCount,
        discardedPendingPreviewCount,
        effects: Object.freeze({
          workspaceChanged: false,
          stagingChanged: false,
          released: false,
          discordContacted: false,
        }),
      });
    });
  }

  async startPackCaptureSession(packId: string): Promise<Readonly<Record<string, unknown>>> {
    return this.#withPackMutationLock(async () => {
      await this.refresh();
      const pack = this.#state.byPackId.get(packId);
      if (pack === undefined) {
        throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404, { packId });
      }
      const prior = await this.packCaptureSessions.state(pack);
      const session = await this.packCaptureSessions.start(pack);
      await Promise.all(
        prior.candidates
          .filter((candidate) => candidate.state === "pending")
          .map((candidate) => this.packRenders.discardPreview(candidate.previewId).catch(() => undefined)),
      );
      return Object.freeze({
        schemaVersion: 1,
        session,
        effects: Object.freeze({
          workspaceChanged: false,
          stagingChanged: false,
          released: false,
          discordContacted: false,
        }),
      });
    });
  }

  async scanPackCaptureSession(packId: string): Promise<Readonly<Record<string, unknown>>> {
    return this.#withPackMutationLock(async () => {
      await this.refresh();
      const pack = this.#state.byPackId.get(packId);
      if (pack === undefined) {
        throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404, { packId });
      }
      const registry = buildRegistry(
        this.#state.rawRegistry as Record<string, Record<string, unknown>>,
        this.#state.rawChannels as Record<string, unknown>,
      );
      const plan = await this.packCaptureSessions.planScan(pack, createResolver(registry));
      const created: string[] = [];
      const queued: QueuedPackCapture[] = [];
      try {
        for (const candidate of plan.queued) {
          const preview = await this.previewPackWorkspaceChart({
            packId: pack.id,
            assetId: candidate.assetId,
            sourceFilename: candidate.filename,
            sourceBytes: candidate.sourceBytes,
          });
          const previewId = preview["previewId"];
          if (typeof previewId !== "string" || !/^[a-f0-9]{32}$/u.test(previewId)) {
            throw new AdminError("internal_error", "Pack scanner received an invalid preview identity.", 500);
          }
          created.push(previewId);
          queued.push(Object.freeze({
            assetId: candidate.assetId,
            filename: candidate.filename,
            sourceSha256: candidate.sourceSha256,
            size: candidate.size,
            modifiedAt: candidate.modifiedAt,
            exportedAt: candidate.exportedAt,
            previewId,
          }));
        }
        const before = await this.packCaptureSessions.state(pack);
        const session = await this.packCaptureSessions.commitScan(pack, plan.sessionId, queued);
        const replacedPreviewIds = new Set(
          queued
            .map((item) => before.candidates.find((candidate) => candidate.assetId === item.assetId))
            .filter((candidate) => candidate?.state === "pending")
            .map((candidate) => candidate?.previewId)
            .filter((previewId): previewId is string => previewId !== undefined),
        );
        for (const previewId of replacedPreviewIds) {
          await this.packRenders.discardPreview(previewId).catch(() => undefined);
        }
        return Object.freeze({
          schemaVersion: 1,
          session,
          scan: Object.freeze({
            scannedAt: plan.scannedAt,
            queued: Object.freeze(queued.map((item) => Object.freeze({
              assetId: item.assetId,
              filename: item.filename,
              sourceSha256: item.sourceSha256,
              exportedAt: item.exportedAt,
              previewId: item.previewId,
              publicationUrl: `/api/v1/pack-workspace/previews/${item.previewId}/publication.png`,
              receiptUrl: `/api/v1/pack-workspace/previews/${item.previewId}/receipt.json`,
            }))),
            unchangedAssetIds: plan.unchangedAssetIds,
            ignored: plan.ignored,
          }),
          effects: Object.freeze({
            previewsQueued: queued.length,
            workspaceChanged: false,
            stagingChanged: false,
            released: false,
            discordContacted: false,
          }),
        });
      } catch (error) {
        await Promise.all(created.map((previewId) =>
          this.packRenders.discardPreview(previewId).catch(() => undefined)
        ));
        throw error;
      }
    });
  }

  async previewPackWorkspaceChart(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly sourceFilename: string;
    readonly sourceBytes: Buffer;
  }): Promise<Readonly<Record<string, unknown>>> {
    await this.refresh();
    const pack = this.#state.byPackId.get(input.packId);
    if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${input.packId} was not found.`, 404, { packId: input.packId });
    const asset = this.#state.byAssetId.get(input.assetId);
    if (asset === undefined) throw new AdminError("asset_not_found", `Asset ${input.assetId} was not found.`, 404, { assetId: input.assetId });
    if (!pack.assets.includes(asset.id)) {
      throw new AdminError("invalid_pack_render_preview", `Asset ${asset.id} does not belong to Pack ${pack.id}.`);
    }
    if (asset.currency === undefined || asset.tradingView.indexOf(":") <= 0) {
      throw new AdminError("invalid_pack_render_preview", `Asset ${asset.id} needs qualified TradingView identity and canonical currency before rendering.`);
    }

    const task = await this.packRenders.createPreview(input.sourceFilename, input.sourceBytes);
    try {
      const rendered = await previewChartPublicationFile({
        inputPath: task.sourcePath,
        request: { context: "pack", assetId: asset.id, packId: pack.id },
        outputPath: task.outputPath,
        receiptPath: task.receiptPath,
        registryPath: this.#state.registryFile.canonicalPath,
        channelsPath: this.#state.channelsFile.canonicalPath,
        packsPath: this.#state.packsFile.canonicalPath,
      });
      if (!rendered.ok) {
        throw new AdminError("invalid_pack_render_preview", rendered.detail, 400, { reason: rendered.reason });
      }
      if (rendered.context !== "pack" || rendered.packId !== pack.id) {
        throw new AdminError("internal_error", "Pack preview renderer returned an incompatible context.", 500);
      }
      const record = await this.packRenders.finalizePreview(task, {
        packId: pack.id,
        assetId: asset.id,
        sourceBasename: rendered.sourceBasename,
        timeframe: rendered.timeframe,
        dataAsOf: rendered.dataAsOf,
        outputSha256: rendered.outputSha256,
        registrySourceSha256: this.#state.registryFile.sha256,
        packSourceSha256: this.#state.packsFile.sha256,
        channelConfigurationSha256: this.#state.channelsFile.sha256,
      });
      const current = this.#packRuntime().workspace.captureOf(asset.id);
      return Object.freeze({
        schemaVersion: 1,
        previewId: record.previewId,
        packId: pack.id,
        asset: Object.freeze({ id: asset.id, displayName: asset.display, tradingViewSymbol: asset.tradingView, currency: asset.currency }),
        timeframe: record.timeframe,
        dataAsOf: record.dataAsOf,
        sourceBasename: record.sourceBasename,
        outputSha256: record.outputSha256,
        nextRevision: (current?.revisions ?? 0) + 1,
        publicationUrl: `/api/v1/pack-workspace/previews/${record.previewId}/publication.png`,
        receiptUrl: `/api/v1/pack-workspace/previews/${record.previewId}/receipt.json`,
        effects: Object.freeze({ workspaceChanged: false, staged: false, released: false, discordContacted: false }),
      });
    } catch (error) {
      await this.packRenders.discardPreview(task.previewId).catch(() => undefined);
      throw error;
    }
  }

  readPackWorkspacePreviewArtifact(
    previewId: string,
    artifact: PackRenderPreviewArtifactName,
  ): Promise<Buffer> {
    return this.packRenders.readPreviewArtifact(previewId, artifact);
  }

  readPackWorkspaceRevisionArtifact(
    packId: string,
    assetId: string,
    revision: number,
    artifact: PackRevisionArtifactName,
  ): Promise<Buffer> {
    return this.packRevisions.readArtifact(packId, assetId, revision, artifact);
  }

  async discardPackWorkspacePreview(previewId: string): Promise<void> {
    return this.#withPackMutationLock(async () => {
      await this.packCaptureSessions.removePendingPreview(previewId);
      await this.packRenders.discardPreview(previewId);
    });
  }

  async #withPackMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#packMutationLock;
    let release!: () => void;
    this.#packMutationLock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await prior;
    try { return await operation(); }
    finally { release(); }
  }

  deletePackWorkspaceRevision(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly revision: number;
    readonly confirmation: unknown;
    readonly expectedCurrentRevision: unknown;
  }): Promise<Readonly<Record<string, unknown>>> {
    if (input.confirmation !== "delete_revision") {
      throw new AdminError("pack_revision_delete_confirmation_invalid", "Delete Revision requires an explicit current confirmation.");
    }
    if (
      !Number.isSafeInteger(input.revision) || input.revision < 1 ||
      !Number.isSafeInteger(input.expectedCurrentRevision) || Number(input.expectedCurrentRevision) < 1
    ) {
      throw new AdminError("invalid_request", "Revision identities must be positive safe integers.");
    }
    return this.#withPackMutationLock(async () => {
      await this.refresh();
      const pack = this.#state.byPackId.get(input.packId);
      if (pack === undefined) {
        throw new AdminError("pack_not_found", `Pack ${input.packId} was not found.`, 404);
      }
      const asset = this.#state.byAssetId.get(input.assetId);
      if (asset === undefined) {
        throw new AdminError("asset_not_found", `Asset ${input.assetId} was not found.`, 404);
      }
      if (!pack.assets.includes(asset.id)) {
        throw new AdminError("invalid_request", `Asset ${asset.id} does not belong to Pack ${pack.id}.`);
      }

      const runtime = this.#packRuntime();
      await this.packRevisions.reconcile(runtime.workspace, await this.packRenders.listAcceptedPreviews());
      const capture = runtime.workspace.captureOf(asset.id);
      if (capture === null || capture.revisions !== Number(input.expectedCurrentRevision)) {
        throw new AdminError("pack_revision_state_conflict", `${asset.id.toUpperCase()} changed after revision deletion was confirmed.`, 409);
      }
      const history = await this.packRevisions.list(pack.id, asset.id);
      const target = history.find((revision) => revision.revision === input.revision);
      if (target === undefined) {
        throw new AdminError("pack_revision_not_found", `Revision ${input.revision} was not found.`, 404);
      }
      const deletingCurrent = target.revision === capture.revisions;
      const previous = history.filter((revision) => revision.revision < target.revision).at(-1);

      if (deletingCurrent) {
        if (previous === undefined) {
          if (!runtime.workspace.resetAsset(asset.id)) {
            throw new AdminError("pack_revision_state_conflict", `${asset.id.toUpperCase()} current Analysis disappeared.`, 409);
          }
          runtime.staging.unstage(asset.id);
        } else {
          runtime.staging.stage(asset.id, previous.publicationPath);
          if (!runtime.workspace.resetAsset(asset.id)) {
            throw new AdminError("pack_revision_state_conflict", `${asset.id.toUpperCase()} current Analysis disappeared.`, 409);
          }
          for (let revision = 1; revision <= previous.revision; revision += 1) {
            runtime.workspace.capture(asset.id, previous.acceptedAt);
          }
        }
      }

      await this.packCaptureSessions.removeAcceptedRevision(pack.id, asset.id, target.revision);
      await this.packRevisions.delete(pack.id, asset.id, target.revision);
      const current = runtime.workspace.captureOf(asset.id);
      return Object.freeze({
        schemaVersion: 1,
        deleted: true,
        packId: pack.id,
        assetId: asset.id,
        deletedRevision: target.revision,
        restoredRevision: deletingCurrent ? previous?.revision ?? null : current?.revisions ?? null,
        captured: current !== null,
        currentRevision: current?.revisions ?? 0,
        remainingRevisionCount: history.length - 1,
        effects: Object.freeze({
          workspaceChanged: deletingCurrent,
          stagingChanged: deletingCurrent,
          released: false,
          discordContacted: false,
        }),
      });
    });
  }

  acceptPackWorkspacePreview(previewId: string): Promise<Readonly<Record<string, unknown>>> {
    return this.#withPackMutationLock(async () => {
      await this.refresh();
      const claimed = await this.packRenders.claimPreview(previewId);
      const record = claimed.record;
      if (
        record.registrySourceSha256 !== this.#state.registryFile.sha256 ||
        record.packSourceSha256 !== this.#state.packsFile.sha256 ||
        record.channelConfigurationSha256 !== this.#state.channelsFile.sha256
      ) {
        await this.packRenders.releaseClaim(previewId);
        throw new AdminError("pack_render_preview_state_conflict", "Registry, Pack, or channel definitions changed after this preview. Render a new preview.", 409);
      }

      const runtime = this.#packRuntime();
      let accepted;
      try {
        accepted = await acceptPackChartPublicationFile({
          sourceBasename: record.sourceBasename,
          outputPath: claimed.task.outputPath,
          receiptPath: claimed.task.receiptPath,
          outputBasename: "publication.png",
          receiptBasename: "receipt.json",
          outputSha256: record.outputSha256,
          assetId: record.assetId,
          packId: record.packId,
          timeframe: record.timeframe,
          dataAsOf: record.dataAsOf,
        }, {
          workspace: runtime.workspace,
          staging: runtime.staging,
          validate: (path) => validateImage(path, DEFAULT_VALIDATION_POLICY),
          now: () => new Date().toISOString(),
        });
      } catch {
        throw new AdminError("pack_render_preview_state_conflict", "Pack preview acceptance stopped in an indeterminate state. Do not retry this preview.", 500);
      }
      if (!accepted.ok) {
        await this.packRenders.releaseClaim(previewId);
        throw new AdminError("invalid_pack_render_preview", "Pack preview could not be accepted.", 400, { outcome: accepted.outcome });
      }
      try {
        await this.packRevisions.commit(claimed, accepted.revisions, accepted.capturedAt);
        await this.packRenders.completeClaim(previewId);
        await this.packCaptureSessions.markAccepted(previewId, accepted.revisions);
      }
      catch {
        throw new AdminError("pack_render_preview_state_conflict", "Pack capture succeeded but its evidence could not be finalized. Do not retry this preview.", 500);
      }
      return Object.freeze({
        schemaVersion: 1,
        previewId,
        accepted: true,
        assetId: accepted.assetId,
        packId: accepted.packId,
        timeframe: accepted.timeframe,
        dataAsOf: accepted.dataAsOf,
        capturedAt: accepted.capturedAt,
        revisions: accepted.revisions,
        confirmed: true,
        packState: accepted.packState,
        capturedCount: accepted.capturedCount,
        totalCount: accepted.totalCount,
        remainingRequiredAssetIds: accepted.remainingRequiredAssetIds,
        effects: Object.freeze({ staged: true, workspaceChanged: true, released: false, discordContacted: false }),
      });
    });
  }

  #packResetFailure(result: Exclude<ResetPackWorkspaceResult, { readonly ok: true }>): never {
    if (result.outcome === "analysis_not_found") {
      throw new AdminError("pack_workspace_analysis_not_found", result.detail, 409);
    }
    if (result.outcome === "state_conflict") {
      throw new AdminError("pack_workspace_reset_state_conflict", result.detail, 409);
    }
    throw new AdminError("invalid_request", result.detail);
  }

  resetPackWorkspaceAsset(input: {
    readonly packId: string;
    readonly assetId: string;
    readonly confirmation: unknown;
    readonly expectedRevisions: unknown;
  }): Promise<Readonly<Record<string, unknown>>> {
    if (input.confirmation !== "reset_asset") {
      throw new AdminError("pack_workspace_reset_confirmation_invalid", "Reset Asset requires an explicit current confirmation.");
    }
    if (!Number.isSafeInteger(input.expectedRevisions) || Number(input.expectedRevisions) < 1) {
      throw new AdminError("invalid_request", "expectedRevisions must be a positive safe integer.");
    }
    return this.#withPackMutationLock(async () => {
      await this.refresh();
      const pack = this.#state.byPackId.get(input.packId);
      if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${input.packId} was not found.`, 404, { packId: input.packId });
      const asset = this.#state.byAssetId.get(input.assetId);
      if (asset === undefined) throw new AdminError("asset_not_found", `Asset ${input.assetId} was not found.`, 404, { assetId: input.assetId });
      if (!pack.assets.includes(asset.id)) {
        throw new AdminError("invalid_request", `Asset ${asset.id} does not belong to Pack ${pack.id}.`);
      }
      const result = resetPackWorkspaceAsset({
        packId: pack.id,
        assetId: asset.id,
        expectedRevisions: Number(input.expectedRevisions),
      }, this.#packRuntime());
      if (!result.ok) return this.#packResetFailure(result);
      await this.packRevisions.clearAsset(pack.id, asset.id);
      await this.packCaptureSessions.clearAcceptedAssets(pack.id, [asset.id]);
      return Object.freeze({
        schemaVersion: 1,
        ...result,
        effects: Object.freeze({
          workspaceChanged: true,
          stagingCleared: result.stagingCleared,
          released: false,
          discordContacted: false,
        }),
      });
    });
  }

  resetPackWorkspacePack(input: {
    readonly packId: string;
    readonly confirmation: unknown;
    readonly expectedCapturedAssetIds: unknown;
  }): Promise<Readonly<Record<string, unknown>>> {
    if (input.confirmation !== "reset_pack") {
      throw new AdminError("pack_workspace_reset_confirmation_invalid", "Reset Pack requires an explicit current confirmation.");
    }
    if (
      !Array.isArray(input.expectedCapturedAssetIds) ||
      input.expectedCapturedAssetIds.some((assetId) => typeof assetId !== "string")
    ) {
      throw new AdminError("invalid_request", "expectedCapturedAssetIds must be an array of Asset IDs.");
    }
    const expectedCapturedAssetIds = Object.freeze([...input.expectedCapturedAssetIds] as string[]);
    return this.#withPackMutationLock(async () => {
      await this.refresh();
      const pack = this.#state.byPackId.get(input.packId);
      if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${input.packId} was not found.`, 404, { packId: input.packId });
      const result = resetPackWorkspacePack({
        packId: pack.id,
        expectedCapturedAssetIds,
      }, this.#packRuntime());
      if (!result.ok) return this.#packResetFailure(result);
      await this.packRevisions.clearPack(pack);
      await this.packCaptureSessions.clearAcceptedAssets(pack.id, result.resetAssetIds);
      return Object.freeze({
        schemaVersion: 1,
        ...result,
        effects: Object.freeze({
          workspaceChanged: true,
          stagingCleared: result.stagingCleared,
          released: false,
          discordContacted: false,
        }),
      });
    });
  }

  promotionContext(): PackPromotionContext {
    return currentPackPromotionContext({
      assets: this.#state.assets,
      packs: this.#state.packs,
      channels: this.#state.rawChannels,
      registryBytes: Buffer.from(this.#state.registryFile.bytes),
      packsBytes: Buffer.from(this.#state.packsFile.bytes),
      channelsBytes: Buffer.from(this.#state.channelsFile.bytes),
    });
  }

  async stagePackBuilderAssetLogo(
    packId: string,
    assetId: string,
    bytes: Buffer,
  ): Promise<Readonly<Record<string, unknown>>> {
    const stored = await this.packBuilder.saveAssetLogo(
      packId,
      assetId,
      bytes,
    );
    return Object.freeze({
      schemaVersion: 1,
      packId,
      assetId: stored.assetId,
      evidence: stored.evidence,
    });
  }

  async previewPackCreation(
    value: unknown,
    registryOnly = false,
  ): Promise<CreatePackPreview> {
    await this.refresh();

    if (registryOnly) {
      if (!isRecord(value) || !Array.isArray(value.members)) {
        throw new AdminError("invalid_pack_builder_input", "Registry-owned Pack input must contain a members array.");
      }
      const members: Array<Record<string, unknown>> = [];
      const memberIds: string[] = [];
      for (const member of value.members) {
        if (!isRecord(member) || typeof member.id !== "string") {
          throw new AdminError(
            "invalid_pack_builder_input",
            "Pack members must identify one current Registry Asset ID.",
          );
        }
        members.push(member);
        memberIds.push(member.id);
      }
      const missingAssetIds = memberIds.filter((assetId) => !this.#state.byAssetId.has(assetId));
      if (missingAssetIds.length > 0) {
        throw new AdminError(
          "asset_not_found",
          `Pack members must already exist in Registry: ${missingAssetIds.join(", ")}.`,
          400,
          { assetIds: Object.freeze(missingAssetIds) },
        );
      }
      for (const member of members) {
        if (Object.keys(member).length !== 1) {
          throw new AdminError(
            "invalid_pack_builder_input",
            "Pack members must contain only one current Registry Asset ID. Manage identity and logos in Registry.",
          );
        }
      }
    }

    const prepareCurrent = (
      assetLogos?: ReadonlyMap<
        string,
        ValidatedAssetLogo
      >,
    ) =>
      prepareCreatePackWithMissingAssets({
        value,
        registryBytes: Buffer.from(
          this.#state.registryFile.bytes,
        ),
        packsBytes: Buffer.from(
          this.#state.packsFile.bytes,
        ),
        channelsBytes: Buffer.from(
          this.#state.channelsFile.bytes,
        ),
        assetLogos,
      });

    const requirePrepared = (
      candidate: ReturnType<
        typeof prepareCreatePackWithMissingAssets
      >,
    ) => {
      if (candidate.ok) return candidate.value;

      const code =
        candidate.reason ===
          "existing_asset_currency_missing"
          ? "existing_asset_currency_missing"
          : candidate.reason ===
              "tradingview_conflict"
            ? "tradingview_conflict"
            : candidate.reason ===
                "display_conflict"
              ? "display_conflict"
              : candidate.reason ===
                  "pack_already_exists"
                ? "pack_already_exists"
                : candidate.reason ===
                    "unknown_channel" ||
                    candidate.reason ===
                      "unresolved_channel"
                  ? "pack_channel_not_configured"
                  : "invalid_pack_builder_input";

      throw new AdminError(
        code,
        candidate.detail,
        code === "pack_already_exists"
          ? 409
          : 400,
        {
          ...(candidate.memberIndex === undefined
            ? {}
            : {
                memberIndex:
                  candidate.memberIndex,
              }),
          ...(candidate.field === undefined
            ? {}
            : {
                field: candidate.field,
              }),
        },
      );
    };

    const initial = requirePrepared(
      prepareCurrent(),
    );
    const assetLogos =
      new Map<string, ValidatedAssetLogo>();

    for (const member of initial.preview.members) {
      if (member.existing) continue;

      let bytes: Buffer;
      try {
        bytes =
          await this.packBuilder.readAssetLogo(
            initial.input.pack.id,
            member.id,
          );
      } catch (error) {
        if (
          error instanceof AdminError &&
          error.code ===
            "asset_logo_not_found"
        ) {
          throw new AdminError(
            "asset_logo_not_found",
            error.message,
            404,
            { assetId: member.id },
          );
        }
        throw error;
      }

      const validated =
        await validateAssetLogo(bytes);

      if (!validated.ok) {
        throw new AdminError(
          "invalid_asset_logo",
          validated.detail,
          400,
          {
            assetId: member.id,
            reason: validated.reason,
          },
        );
      }

      assetLogos.set(member.id, validated);
    }

    const prepared = requirePrepared(
      prepareCurrent(assetLogos),
    );

    await this.packBuilder.savePreview(
      prepared.input.pack.id,
      serializeCreatePackWithMissingAssetsInput(
        prepared.input,
      ),
      serializeCreatePackPreview(
        prepared.preview,
      ),
    );

    return prepared.preview;
  }

  previewRegistryPackCreation(value: unknown): Promise<CreatePackPreview> {
    return this.previewPackCreation(value, true);
  }

  async createPackFromPreview(
    packId: string,
    previewId: unknown,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (
      typeof previewId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(previewId)
    ) {
      throw new AdminError(
        "invalid_request",
        "previewId must be a lowercase SHA-256 identity.",
      );
    }

    return this.#withCanonicalSourceMutationLock(async () => {
      await this.refresh();
    const state =
      await this.packBuilder.readState(packId);

    if (
      state.input === undefined ||
      state.preview === undefined
    ) {
      throw new AdminError(
        "pack_builder_preview_not_found",
        "Create a current Pack preview before applying.",
        404,
      );
    }

    if (
      !isRecord(state.preview) ||
      state.preview.previewId !== previewId
    ) {
      throw new AdminError(
        "pack_builder_preview_mismatch",
        "The submitted preview is not the current stored preview.",
        409,
      );
    }

    const logoEvidence = state.preview.assetLogos;
    if (!Array.isArray(logoEvidence)) {
      throw new AdminError(
        "pack_builder_preview_mismatch",
        "The current stored preview has invalid Asset-logo evidence.",
        409,
      );
    }

    const assetLogoInputs: Array<{
      readonly assetId: string;
      readonly path: string;
    }> = [];
    const seenAssetIds = new Set<string>();

    for (const entry of logoEvidence) {
      if (
        !isRecord(entry) ||
        typeof entry.assetId !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(
          entry.assetId,
        ) ||
        seenAssetIds.has(entry.assetId)
      ) {
        throw new AdminError(
          "pack_builder_preview_mismatch",
          "The current stored preview has invalid Asset-logo evidence.",
          409,
        );
      }

      seenAssetIds.add(entry.assetId);
      assetLogoInputs.push({
        assetId: entry.assetId,
        path:
          await this.packBuilder.assetLogoPath(
            packId,
            entry.assetId,
            false,
          ),
      });
    }

    const paths =
      await this.packBuilder.paths(packId);

    const applied =
      await applyCreatePackWithMissingAssetsFile({
        repositoryRoot: this.repositoryRoot,
        inputPath: paths.input,
        previewPath: paths.preview,
        receiptOutputPath: paths.receipt,
        assetLogoInputs,
      });

    if (!applied.ok) {
      const code =
        applied.reason === "stale_registry_state"
          ? "stale_registry_state"
          : applied.reason === "stale_pack_state"
            ? "stale_pack_state"
            : applied.reason ===
                "stale_channel_state"
              ? "stale_channel_state"
              : applied.reason ===
                    "preview_mismatch" ||
                  applied.reason ===
                    "asset_logo_mismatch" ||
                  applied.reason ===
                    "invalid_asset_logo"
                ? "pack_builder_preview_mismatch"
                : applied.reason ===
                    "asset_logo_not_found"
                  ? "asset_logo_not_found"
                  : applied.reason ===
                      "application_already_completed"
                    ? "application_already_completed"
                    : applied.reason ===
                        "output_already_exists"
                      ? "output_already_exists"
                      : applied.reason ===
                          "rollback_failed"
                        ? "rollback_failed"
                        : applied.reason ===
                            "rollback_verification_failed"
                          ? "rollback_verification_failed"
                          : applied.reason ===
                              "application_receipt_finalize_failed"
                            ? "application_receipt_finalize_failed"
                            : "pack_builder_transaction_failed";

      const conflictCodes = new Set([
        "stale_registry_state",
        "stale_pack_state",
        "stale_channel_state",
        "pack_builder_preview_mismatch",
        "asset_logo_not_found",
        "output_already_exists",
        "application_already_completed",
      ]);

      throw new AdminError(
        code,
        applied.detail,
        conflictCodes.has(code) ? 409 : 500,
        {
          safelyRestored:
            applied.safelyRestored,
        },
      );
    }

    await this.refresh();

    return Object.freeze({
      schemaVersion: 1,
      created: true,
      packId,
      receiptSha256: applied.receiptSha256,
      receiptByteSize: applied.receiptByteSize,
      receipt: applied.receipt,
      status: this.status(),
    });
    });
  }

  async packCreationState(packId: string): Promise<Readonly<Record<string, unknown>>> {
    const state = await this.packBuilder.readState(packId);
    return Object.freeze({ schemaVersion: 1, packId, ...state });
  }

  async draftArtifact(draftId: string): Promise<{ readonly draft: PackDraft; readonly bytes: Buffer }> {
    const draft = await this.workspace.readDraft(draftId, this.validAssetIds());
    const bytes = await this.workspace.exportDraft(draftId, this.validAssetIds());
    return Object.freeze({ draft, bytes });
  }

  searchAssets(options: { readonly query?: string; readonly packId?: string; readonly offset?: number; readonly limit?: number } = {}): AdminAssetSearchResult {
    const query = options.query?.trim() ?? "";
    const packId = options.packId?.trim() || null;
    if (packId !== null && !this.#state.byPackId.has(packId)) {
      throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404, { packId });
    }
    const offset = options.offset ?? 0;
    const limit = options.limit ?? DEFAULT_ASSET_SEARCH_LIMIT;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ASSET_SEARCH_LIMIT) {
      throw new AdminError("invalid_request", `offset must be nonnegative and limit must be between 1 and ${MAX_ASSET_SEARCH_LIMIT}.`);
    }
    const needles = query
      .toLocaleLowerCase("en-US")
      .split(/\s+/u)
      .filter((token) => token.length > 0);
    const matching = [...this.#state.assets]
      .filter((asset) => {
        const packIds = this.#state.assetPackIds.get(asset.id) ?? [];
        if (packId !== null && !packIds.includes(packId)) return false;
        const searchable = [
          asset.id,
          asset.display,
          asset.tradingView,
          asset.channel,
          asset.currency ?? "",
          ...packIds,
          ...packIds.map((packId) => this.#state.byPackId.get(packId)?.display ?? ""),
        ].map((value) => value.toLocaleLowerCase("en-US"));
        return needles.every((needle) => searchable.some((value) => value.includes(needle)));
      })
      .sort((a, b) => a.id.localeCompare(b.id, "en"));
    const assets = matching.slice(offset, offset + limit).map((asset) => assetSummary(asset, this.#state.assetPackIds.get(asset.id) ?? []));
    return Object.freeze({
      schemaVersion: 1,
      query,
      packId,
      offset,
      limit,
      total: matching.length,
      assets: Object.freeze(assets),
    });
  }

  getAsset(assetId: string): AdminAssetSummary {
    const asset = this.#state.byAssetId.get(assetId);
    if (asset === undefined) throw new AdminError("asset_not_found", `Asset ${assetId} was not found.`, 404, { assetId });
    return assetSummary(asset, this.#state.assetPackIds.get(asset.id) ?? []);
  }


  registryOptions(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      schemaVersion: 1,
      logicalChannels: Object.freeze(Object.entries(this.#state.rawChannels)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([logicalChannel, discordChannelId]) => Object.freeze({
          logicalChannel,
          discordChannelId: String(discordChannelId),
        }))),
    });
  }

  async prepareRegistryAssetChange(value: unknown): Promise<AdminRegistryAssetChangePreview> {
    if (!isRecord(value)) throw new AdminError("invalid_request", "Registry Asset change must be an object.");
    const allowed = new Set(["operation", "asset"]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new AdminError("invalid_request", `Registry Asset change contains unknown fields: ${unknown.join(", ")}.`);
    if (value.operation !== "add" && value.operation !== "update") {
      throw new AdminError("invalid_request", "Registry Asset change operation must be add or update.");
    }
    if (!isRecord(value.asset)) throw new AdminError("invalid_request", "Registry Asset change asset must be an object.");
    const assetFields = new Set(["id", "displayName", "tradingViewSymbol", "currency", "channel"]);
    const unknownAsset = Object.keys(value.asset).filter((key) => !assetFields.has(key));
    if (unknownAsset.length > 0) throw new AdminError("invalid_request", `Registry Asset contains unknown fields: ${unknownAsset.join(", ")}.`);
    const { id, displayName, tradingViewSymbol, currency, channel } = value.asset;
    if (![id, displayName, tradingViewSymbol, currency, channel].every((entry) => typeof entry === "string" && entry.trim() === entry && entry.length > 0)) {
      throw new AdminError("invalid_request", "Asset ID, display name, TradingView symbol, currency, and channel are required exact strings.");
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id as string)) {
      throw new AdminError("invalid_request", "Asset ID must be a stable lowercase slug of 1 to 64 characters.");
    }
    const parts = (tradingViewSymbol as string).split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new AdminError("invalid_request", "TradingView symbol must be a qualified MARKET:SYMBOL identity.");
    }
    const previous = this.#state.byAssetId.get(id as string);
    if (value.operation === "add" && previous !== undefined) {
      throw new AdminError("asset_id_already_exists", `Asset ${id as string} already exists.`, 409);
    }
    if (value.operation === "update" && previous === undefined) {
      throw new AdminError("asset_not_found", `Asset ${id as string} was not found.`, 404);
    }
    const now = new Date().toISOString();
    const changeId = `ui-${(id as string).slice(0, 35)}-${randomBytes(6).toString("hex")}`;
    const input = {
      schemaVersion: 2,
      operation: value.operation === "add" ? "add" : "update_identity",
      asset: {
        id,
        displayName,
        symbol: parts[1],
        market: parts[0],
        tradingViewSymbol,
        currency,
        channel,
      },
      targetPackIds: [],
      decision: {
        reviewerId: "visionx-local-operator",
        decidedAt: now,
        referenceId: `visionx.registry.${changeId}`,
        notes: "Prepared through the local Registry management interface.",
      },
      ...(previous === undefined ? {} : {
        expectedCurrent: {
          display: previous.display,
          tradingView: previous.tradingView,
          channel: previous.channel,
        },
      }),
    };
    const validated = validateAssetRegistrationInput(input, this.#state.rawChannels);
    if (!validated.ok) this.#assetFailure(validated.reason, validated.detail, "proposal");
    const inputBytes = Buffer.from(`${JSON.stringify(validated.input, null, 2)}\n`, "utf8");
    await this.assetRegistrations.writeArtifact(changeId, "registration-input.json", inputBytes);
    const proposalResult = await proposeAssetRegistrationFile({
      inputPath: await this.assetRegistrations.artifactPath(changeId, "registration-input.json", false),
      outputPath: await this.assetRegistrations.artifactPath(changeId, "asset-proposal.json"),
      ...this.#assetRegistrationCanonicalPaths(),
    });
    if (!proposalResult.ok) this.#assetFailure(proposalResult.reason, proposalResult.detail, "proposal");
    const proposalBytes = await this.assetRegistrations.readArtifact(changeId, "asset-proposal.json");
    await this.storeAssetRegistrationPlanningAuthorization(changeId, {
      schemaVersion: 1,
      decision: "approved",
      proposalSha256: sha256(proposalBytes),
      reviewerId: "visionx-local-operator",
      decidedAt: now,
      referenceId: `visionx.registry.${changeId}.plan`,
      packPlacements: [],
    });
    await this.generateAssetRegistrationPlan(changeId);
    await this.generateAssetRegistrationSourceChange(changeId);
    await this.reviewAssetRegistration(changeId, {
      schemaVersion: 1,
      decision: "approved",
      reviewerId: "visionx-local-operator",
      decidedAt: now,
      referenceId: `visionx.registry.${changeId}.review`,
    });
    const [reviewBytes, patchBytes, sourceChangeBytes] = await Promise.all([
      this.assetRegistrations.readArtifact(changeId, "asset-source-review.json"),
      this.assetRegistrations.readArtifact(changeId, "asset-source.patch"),
      this.assetRegistrations.readArtifact(changeId, "asset-source-change.json"),
    ]);
    await this.storeAssetRegistrationApplicationAuthorization(changeId, {
      schemaVersion: 1,
      decision: "approved",
      sourceChangeReviewSha256: sha256(reviewBytes),
      sourcePatchSha256: sha256(patchBytes),
      sourceChangeReceiptSha256: sha256(sourceChangeBytes),
      reviewerId: "visionx-local-operator",
      decidedAt: now,
      referenceId: `visionx.registry.${changeId}.apply`,
    });
    const proposedAsset: Asset = Object.freeze({
      id: id as string,
      display: displayName as string,
      tradingView: tradingViewSymbol as string,
      currency: currency as string,
      channel: channel as string,
      ...(previous?.tradingViewAliases === undefined ? {} : { tradingViewAliases: previous.tradingViewAliases }),
    });
    return Object.freeze({
      schemaVersion: 1,
      changeId,
      operation: value.operation,
      asset: assetSummary(proposedAsset, this.#state.assetPackIds.get(id as string) ?? []),
      previous: previous === undefined ? null : assetSummary(previous, this.#state.assetPackIds.get(previous.id) ?? []),
      sourceState: Object.freeze({
        registrySha256: this.#state.registryFile.sha256,
        packsSha256: this.#state.packsFile.sha256,
        channelsSha256: this.#state.channelsFile.sha256,
      }),
      effects: Object.freeze({
        registryChanged: true,
        packMembershipChanged: false,
        logoChanged: false,
        discordContacted: false,
      }),
    });
  }

  async applyPreparedRegistryAssetChange(changeId: string, confirmation: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (confirmation !== "APPLY REGISTRY ASSET CHANGE") {
      throw new AdminError("application_confirmation_invalid", "Confirmation must equal APPLY REGISTRY ASSET CHANGE exactly.");
    }
    return this.applyAssetRegistration(changeId, "APPLY ASSET SOURCE CHANGE");
  }

  prepareRegistryCsvImport(input: { readonly fileName: unknown; readonly csvText: unknown }): AdminRegistryCsvImportPreview {
    if (
      typeof input.fileName !== "string" ||
      input.fileName.trim() !== input.fileName ||
      input.fileName.length < 1 || input.fileName.length > 255 ||
      /[\u0000-\u001F\u007F]/u.test(input.fileName)
    ) {
      throw new AdminError("invalid_request", "CSV filename must be a single-line value of 1 to 255 characters.");
    }
    if (typeof input.csvText !== "string") throw new AdminError("invalid_request", "CSV import body must be UTF-8 text.");
    const candidate = previewRegistryCsvImport({
      csvText: input.csvText,
      rawRegistry: this.#state.rawRegistry,
      rawPacks: this.#state.rawPacks,
      channels: this.#state.rawChannels,
      assets: this.#state.assets,
      packs: this.#state.packs,
    });
    const sourceState = Object.freeze({
      registrySha256: this.#state.registryFile.sha256,
      packsSha256: this.#state.packsFile.sha256,
      channelsSha256: this.#state.channelsFile.sha256,
    });
    const previewId = sha256(Buffer.from(JSON.stringify({
      fileName: input.fileName,
      csvSha256: sha256(Buffer.from(input.csvText, "utf8")),
      sourceState,
    }), "utf8"));
    const valid = candidate.issues.length === 0 && candidate.registryAfterBytes !== null && candidate.packsAfterBytes !== null;
    const preview: AdminRegistryCsvImportPreview = Object.freeze({
      schemaVersion: 1,
      previewId,
      fileName: input.fileName,
      valid,
      rowCount: candidate.rows.length,
      additionCount: valid ? candidate.rows.length : 0,
      packMembershipCount: valid ? candidate.packMembershipCount : 0,
      rows: candidate.rows,
      issues: candidate.issues,
      sourceState,
      effects: Object.freeze({
        registryChanged: valid && candidate.rows.length > 0,
        packMembershipChanged: valid && candidate.packMembershipCount > 0,
        discordContacted: false,
      }),
    });
    if (valid) {
      if (this.#registryCsvImports.size >= 20) {
        const oldest = this.#registryCsvImports.keys().next().value as string | undefined;
        if (oldest !== undefined) this.#registryCsvImports.delete(oldest);
      }
      this.#registryCsvImports.set(previewId, Object.freeze({
        preview,
        registryAfterBytes: candidate.registryAfterBytes as Buffer,
        packsAfterBytes: candidate.packsAfterBytes as Buffer,
      }));
    }
    return preview;
  }

  async applyRegistryCsvImport(previewId: string, confirmation: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (confirmation !== "APPLY REGISTRY CSV IMPORT") {
      throw new AdminError("application_confirmation_invalid", "Confirmation must equal APPLY REGISTRY CSV IMPORT exactly.");
    }
    const record = this.#registryCsvImports.get(previewId);
    if (record === undefined) throw new AdminError("registry_csv_import_not_found", "CSV import preview was not found or is no longer valid.", 404);
    return this.#withCanonicalSourceMutationLock(async () => {
      await this.refresh();
      if (
        this.#state.registryFile.sha256 !== record.preview.sourceState.registrySha256 ||
        this.#state.packsFile.sha256 !== record.preview.sourceState.packsSha256 ||
        this.#state.channelsFile.sha256 !== record.preview.sourceState.channelsSha256
      ) {
        this.#registryCsvImports.delete(previewId);
        throw new AdminError("stale_registry_state", "Registry, Pack, or channel state changed after CSV review.", 409);
      }
      try {
        const applied = await applyRegistryCsvImportFile({
          repositoryRoot: this.repositoryRoot,
          expectedRegistrySha256: record.preview.sourceState.registrySha256,
          expectedPacksSha256: record.preview.sourceState.packsSha256,
          expectedChannelsSha256: record.preview.sourceState.channelsSha256,
          registryAfterBytes: record.registryAfterBytes,
          packsAfterBytes: record.packsAfterBytes,
        });
        this.#registryCsvImports.delete(previewId);
        await this.refresh();
        return Object.freeze({
          schemaVersion: 1,
          previewId,
          importedAssetCount: record.preview.additionCount,
          packMembershipCount: record.preview.packMembershipCount,
          sourceState: applied,
          effects: Object.freeze({
            registryChanged: true,
            packMembershipChanged: record.preview.packMembershipCount > 0,
            discordContacted: false,
          }),
          status: this.status(),
        });
      } catch (error) {
        if (error instanceof RegistryCsvImportFileError) {
          if (error.code === "stale_source_state") {
            this.#registryCsvImports.delete(previewId);
            throw new AdminError("stale_registry_state", error.message, 409);
          }
          if (error.code === "invalid_candidate") {
            this.#registryCsvImports.delete(previewId);
            throw new AdminError("invalid_registry_csv_import", error.message);
          }
          throw new AdminError(error.code === "rollback_failed" ? "rollback_failed" : "source_write_failed", error.message, 500);
        }
        throw error;
      }
    });
  }

  async inspectRegistryAssetLogo(assetId: string): Promise<Readonly<Record<string, unknown>>> {
    this.getAsset(assetId);
    try {
      const status = await inspectCanonicalAssetLogo(this.repositoryRoot, assetId);
      return Object.freeze({
        schemaVersion: 1,
        assetId,
        exists: status.exists,
        evidence: status.evidence,
        url: status.exists ? `/api/v1/assets/${encodeURIComponent(assetId)}/logo` : null,
      });
    } catch (error) {
      if (error instanceof AssetLogoFileError && error.code === "logo_directory_unsafe") {
        return Object.freeze({ schemaVersion: 1, assetId, exists: false, evidence: null, url: null });
      }
      throw this.#mapAssetLogoError(error);
    }
  }

  #mapAssetLogoError(error: unknown): AdminError {
    if (!(error instanceof AssetLogoFileError)) {
      return new AdminError("internal_error", error instanceof Error ? error.message : String(error), 500);
    }
    const code = error.code === "logo_not_found" ? "asset_logo_not_found"
      : error.code === "invalid_asset_logo" ? "invalid_asset_logo"
      : error.code === "logo_state_conflict" ? "stale_asset_state"
      : error.code === "invalid_asset_id" ? "invalid_request"
      : "source_write_failed";
    const status = code === "asset_logo_not_found" ? 404 : code === "stale_asset_state" ? 409 : code === "source_write_failed" ? 500 : 400;
    return new AdminError(code as never, error.message, status);
  }

  async readRegistryAssetLogo(assetId: string): Promise<Buffer> {
    this.getAsset(assetId);
    try {
      return (await readCanonicalAssetLogo(this.repositoryRoot, assetId)).bytes;
    } catch (error) {
      throw this.#mapAssetLogoError(error);
    }
  }

  async storeRegistryAssetLogo(assetId: string, bytes: Buffer, expectedCurrentSha256: string | null, confirmation: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (confirmation !== "STORE REGISTRY ASSET LOGO") {
      throw new AdminError("application_confirmation_invalid", "Confirmation must equal STORE REGISTRY ASSET LOGO exactly.");
    }
    return this.#withRegistryLogoMutationLock(async () => {
      await this.refresh();
      this.getAsset(assetId);
      try {
        const logo = await writeCanonicalAssetLogo(this.repositoryRoot, assetId, bytes, expectedCurrentSha256);
        return Object.freeze({ schemaVersion: 1, assetId, exists: true, evidence: logo.evidence, url: `/api/v1/assets/${encodeURIComponent(assetId)}/logo` });
      } catch (error) {
        throw this.#mapAssetLogoError(error);
      }
    });
  }

  async removeRegistryAssetLogo(assetId: string, expectedCurrentSha256: string, confirmation: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (confirmation !== "REMOVE REGISTRY ASSET LOGO") {
      throw new AdminError("application_confirmation_invalid", "Confirmation must equal REMOVE REGISTRY ASSET LOGO exactly.");
    }
    return this.#withRegistryLogoMutationLock(async () => {
      await this.refresh();
      this.getAsset(assetId);
      try {
        await deleteCanonicalAssetLogo(this.repositoryRoot, assetId, expectedCurrentSha256);
        return Object.freeze({ schemaVersion: 1, assetId, exists: false, evidence: null, url: null, removed: true });
      } catch (error) {
        throw this.#mapAssetLogoError(error);
      }
    });
  }

  async previewRegistryAssetRetirement(assetId: string): Promise<AdminRegistryAssetRetirementPreview> {
    const asset = this.getAsset(assetId);
    const bindingsBytes = await readFile(join(this.repositoryRoot, THREAD_BINDINGS_RELATIVE_PATH));
    let bindings: AssetThreadBindings;
    try {
      bindings = parseAssetThreadBindings(JSON.parse(bindingsBytes.toString("utf8")) as unknown);
    } catch (error) {
      throw new AdminError("invalid_thread_bindings", error instanceof Error ? error.message : String(error));
    }
    const blockingThreadRoutes = Object.entries(bindings.packs)
      .flatMap(([packId, assets]) => Object.prototype.hasOwnProperty.call(assets, assetId) ? [`${packId}/${assetId}`] : []);
    const payload = Object.freeze({
      schemaVersion: 1,
      operation: "retire" as const,
      asset,
      blockingPackIds: asset.packIds,
      blockingThreadRoutes: Object.freeze(blockingThreadRoutes),
      sourceState: Object.freeze({
        registrySha256: this.#state.registryFile.sha256,
        packsSha256: this.#state.packsFile.sha256,
        threadBindingsSha256: sha256(bindingsBytes),
      }),
    });
    return Object.freeze({ ...payload, previewId: sha256(Buffer.from(JSON.stringify(payload), "utf8")) });
  }

  async retireRegistryAsset(assetId: string, previewId: unknown, confirmation: unknown): Promise<Readonly<Record<string, unknown>>> {
    return this.#withCanonicalSourceMutationLock(async () => {
      await this.refresh();
      const preview = await this.previewRegistryAssetRetirement(assetId);
      if (preview.previewId !== previewId) {
        throw new AdminError("stale_asset_state", "Registry, Pack membership, or Thread routing changed after the retirement preview.", 409);
      }
      if (preview.blockingPackIds.length > 0 || preview.blockingThreadRoutes.length > 0) {
        throw new AdminError("stale_asset_state", "Remove the Asset from every Pack and local Thread route before retiring it.", 409, {
          packIds: preview.blockingPackIds,
          threadRoutes: preview.blockingThreadRoutes,
        });
      }
      if (confirmation !== `RETIRE ${assetId.toUpperCase()}`) {
        throw new AdminError("application_confirmation_invalid", `Confirmation must equal RETIRE ${assetId.toUpperCase()} exactly.`);
      }
      try {
        retireAsset(
          join(this.repositoryRoot, REGISTRY_RELATIVE_PATH),
          join(this.repositoryRoot, CHANNELS_RELATIVE_PATH),
          assetId,
          new Set(this.#state.packs.flatMap((pack) => pack.assets)),
        );
      } catch (error) {
        if (error instanceof RegistryError) throw new AdminError("stale_asset_state", error.message, 409);
        throw error;
      }
      await this.refresh();
      return Object.freeze({ schemaVersion: 1, assetId, retired: true, canonicalLogoRetained: true, status: this.status() });
    });
  }

  async operatorToolsState(): Promise<Readonly<Record<string, unknown>>> {
    const releasePacks = this.releases.listPackIds();
    const records = releasePacks.flatMap((packId) => this.releases.listReleases(packId));
    return Object.freeze({
      schemaVersion: 1,
      status: this.status(),
      marketIdentityAudit: Object.freeze({
        ok: this.#state.audit.ok,
        gapCount: this.#state.audit.gaps.length,
        gaps: Object.freeze(this.#state.audit.gaps.map((gap) => Object.freeze({ ...gap }))),
      }),
      exportAudit: Object.freeze({
        available: this.packCaptureSessions.downloadsRoot !== null,
        downloadsFolder: this.packCaptureSessions.downloadsRoot,
      }),
      archive: Object.freeze({
        packCount: releasePacks.length,
        releaseCount: records.length,
        publishedCount: records.filter((record) => record.publishedAt !== null).length,
        interruptedCount: records.filter((record) => record.publishedAt === null).length,
      }),
      specialistTools: Object.freeze({
        classification: "development_or_recovery_only",
        exposedInAdministration: false,
        tools: Object.freeze([
          "TradingView login and chart loading",
          "button inspection and snapshot spike",
          "fixture posting",
          "legacy runtime helpers",
        ]),
      }),
    });
  }

  async auditChartExports(): Promise<Readonly<Record<string, unknown>>> {
    const root = this.packCaptureSessions.downloadsRoot;
    if (root === null) throw new AdminError("chart_downloads_not_configured", "Configure a Chart Downloads folder before running the export audit.", 409);
    const registry = buildRegistry(this.#state.rawRegistry as Record<string, Record<string, unknown>>, this.#state.rawChannels as Record<string, unknown>);
    const resolver = createResolver(registry);
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".png"))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    const resolved: { readonly file: string; readonly identity: { readonly id: string; readonly display: string } }[] = [];
    const unknown: { readonly file: string; readonly symbol: string }[] = [];
    const unparseable: { readonly file: string }[] = [];
    for (const entry of entries) {
      const file = entry.name;
      const candidatePath = join(root, file);
      const candidateStat = await stat(candidatePath);
      if (!candidateStat.isFile()) continue;
      const result = resolver.resolve(file);
      if (result.ok) resolved.push(Object.freeze({ file, identity: Object.freeze({ id: result.asset.id, display: result.asset.display }) }));
      else if (result.reason === "unknown_symbol") unknown.push(Object.freeze({ file, symbol: result.symbol }));
      else unparseable.push(Object.freeze({ file }));
    }
    const duplicates = findDuplicates(resolved, unknown);
    return Object.freeze({
      schemaVersion: 1,
      scannedCount: entries.length,
      resolvedCount: resolved.length,
      unresolvedCount: unknown.length + unparseable.length,
      duplicateGroupCount: duplicates.length,
      resolved: Object.freeze(resolved),
      unknown: Object.freeze(unknown),
      unparseable: Object.freeze(unparseable),
      duplicates: Object.freeze(duplicates.map((group) => Object.freeze({ ...group, files: Object.freeze([...group.files]) }))),
      effects: Object.freeze({ repositoryChanged: false, workspaceChanged: false, stagingChanged: false, discordContacted: false }),
    });
  }

  async packMaintenanceState(): Promise<Readonly<Record<string, unknown>>> {
    const runtime = this.#packRuntime();
    const { bindings } = await this.#readThreadBindings();
    const packs = this.#state.packs.map((pack, order) => Object.freeze({
      id: pack.id,
      displayName: pack.display,
      logicalChannel: pack.channel,
      order,
      state: runtime.workspace.packState(pack.id),
      capturedCount: runtime.workspace.capturedFor(pack.id).length,
      boundThreadCount: Object.keys(bindings.packs[pack.id] ?? {}).length,
      releaseCount: this.releases.listReleases(pack.id).length,
      assetIds: Object.freeze([...pack.assets]),
      assets: Object.freeze(pack.assets.map((assetId) => this.getAsset(assetId))),
    }));
    const heldAssets = this.#state.assets
      .filter((asset) => (this.#state.assetPackIds.get(asset.id) ?? []).length === 0)
      .map((asset) => assetSummary(asset, []));
    return Object.freeze({
      schemaVersion: 1,
      packsSourceSha256: this.#state.packsFile.sha256,
      logicalChannels: Object.freeze(this.logicalChannels()),
      packs: Object.freeze(packs),
      heldAssets: Object.freeze(heldAssets),
    });
  }

  async #currentPackMaintenancePreview(request: AdminPackMaintenanceInput): Promise<AdminPackMaintenancePreview> {
    const pack = this.#state.byPackId.get(request.packId);
    if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${request.packId} was not found.`, 404);
    const runtime = this.#packRuntime();
    const { bindings } = await this.#readThreadBindings();
    return buildPackMaintenancePreview({
      value: request,
      packs: this.#state.packs,
      assets: this.#state.assets,
      channelNames: new Set(this.logicalChannels()),
      packsSha256: this.#state.packsFile.sha256,
      workspaceState: runtime.workspace.packState(pack.id),
      capturedCount: runtime.workspace.capturedFor(pack.id).length,
      boundThreadCount: Object.keys(bindings.packs[pack.id] ?? {}).length,
    });
  }

  async preparePackMaintenance(value: unknown): Promise<AdminPackMaintenancePreview> {
    await this.refresh();
    let normalizedValue = value;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.operation === "update" && typeof record.packId === "string" && (record.logicalChannel === "" || record.logicalChannel === undefined)) {
        const current = this.#state.byPackId.get(record.packId);
        if (current !== undefined) normalizedValue = { ...record, logicalChannel: current.channel };
      }
    }
    const request = parsePackMaintenanceInput(normalizedValue);
    const preview = await this.#currentPackMaintenancePreview(request);
    this.#packMaintenancePreviews.clear();
    this.#packMaintenancePreviews.set(preview.previewId, Object.freeze({ request, preview }));
    return preview;
  }

  async applyPackMaintenance(previewId: unknown, confirmation: unknown): Promise<Readonly<Record<string, unknown>>> {
    return this.#withCanonicalSourceMutationLock(async () => {
      if (typeof previewId !== "string") throw new AdminError("invalid_request", "Pack maintenance preview ID is required.");
      const stored = this.#packMaintenancePreviews.get(previewId);
      if (stored === undefined) throw new AdminError("pack_maintenance_preview_not_found", "Pack maintenance preview was not found or has expired.", 404);
      await this.refresh();
      const currentPreview = await this.#currentPackMaintenancePreview(stored.request);
      if (currentPreview.previewId !== previewId) throw new AdminError("stale_pack_state", "Pack definitions, Workspace state, or Thread bindings changed after review.", 409);
      if (!currentPreview.ready) throw new AdminError("pack_maintenance_blocked", "Resolve every Pack maintenance blocker before applying the change.", 409, { blockers: currentPreview.blockers });
      if (confirmation !== currentPreview.confirmation) throw new AdminError("application_confirmation_invalid", `Confirmation must equal ${currentPreview.confirmation} exactly.`);
      const packsPath = join(this.repositoryRoot, PACKS_RELATIVE_PATH);
      const originalBytes = this.#state.packsFile.bytes;
      const validIds = new Set(this.#state.assets.map((asset) => asset.id));
      const channelNames = new Set(this.logicalChannels());
      try {
        if (stored.request.operation === "delete") {
          deletePack(packsPath, validIds, channelNames, stored.request.packId);
        } else {
          const request = stored.request;
          const current = this.#state.byPackId.get(request.packId);
          if (current === undefined) throw new AdminError("pack_not_found", `Pack ${request.packId} was not found.`, 404);
          if (current.display !== request.displayName) renamePackDisplay(packsPath, validIds, channelNames, request.packId, request.displayName);
          if (current.channel !== request.logicalChannel) reassignPackChannel(packsPath, validIds, channelNames, request.packId, request.logicalChannel);
          let workingAssets = [...current.assets];
          for (const assetId of request.assetIds) {
            if (!workingAssets.includes(assetId)) {
              addPackAsset(packsPath, validIds, channelNames, request.packId, assetId);
              workingAssets.push(assetId);
            }
          }
          for (const assetId of [...workingAssets]) {
            if (!request.assetIds.includes(assetId)) {
              removePackAsset(packsPath, validIds, channelNames, request.packId, assetId);
              workingAssets = workingAssets.filter((id) => id !== assetId);
            }
          }
          if (workingAssets.some((id, index) => request.assetIds[index] !== id)) {
            reorderPackAssets(packsPath, validIds, channelNames, request.packId, request.assetIds);
          }
          if (this.#state.packs.some((pack, index) => request.packOrder[index] !== pack.id)) {
            reorderPacks(packsPath, validIds, channelNames, request.packOrder);
          }
        }
      } catch (error) {
        await writeFile(packsPath, originalBytes);
        await this.refresh();
        if (error instanceof AdminError) throw error;
        if (error instanceof PackError) throw new AdminError("pack_maintenance_failed", error.message, 409);
        throw error;
      }
      await this.refresh();
      this.#packMaintenancePreviews.delete(previewId);
      return Object.freeze({
        schemaVersion: 1,
        operation: stored.request.operation,
        packId: stored.request.packId,
        applied: true,
        status: this.status(),
        effects: Object.freeze({ packsChanged: true, registryChanged: false, threadBindingsChanged: false, workspaceChanged: false, archiveChanged: false, discordContacted: false }),
      });
    });
  }

  async prepareRegistryAliasChange(assetId: string, value: unknown): Promise<AdminAliasChangePreview> {
    await this.refresh();
    const asset = this.#state.byAssetId.get(assetId);
    if (asset === undefined) throw new AdminError("asset_not_found", `Asset ${assetId} was not found.`, 404);
    const preview = buildAliasChangePreview({ value, asset, registrySha256: this.#state.registryFile.sha256, allAssets: this.#state.assets });
    this.#aliasChangePreviews.clear();
    this.#aliasChangePreviews.set(preview.previewId, Object.freeze({ preview }));
    return preview;
  }

  async applyRegistryAliasChange(assetId: string, previewId: unknown, confirmation: unknown): Promise<Readonly<Record<string, unknown>>> {
    return this.#withCanonicalSourceMutationLock(async () => {
      if (typeof previewId !== "string") throw new AdminError("invalid_request", "Alias change preview ID is required.");
      const stored = this.#aliasChangePreviews.get(previewId);
      if (stored === undefined || stored.preview.assetId !== assetId) throw new AdminError("alias_preview_not_found", "Alias change preview was not found or has expired.", 404);
      await this.refresh();
      const asset = this.#state.byAssetId.get(assetId);
      if (asset === undefined) throw new AdminError("asset_not_found", `Asset ${assetId} was not found.`, 404);
      const currentPreview = buildAliasChangePreview({
        value: { assetId, operation: stored.preview.operation, alias: stored.preview.alias },
        asset,
        registrySha256: this.#state.registryFile.sha256,
        allAssets: this.#state.assets,
      });
      if (currentPreview.previewId !== previewId) throw new AdminError("stale_asset_state", "Registry aliases changed after review.", 409);
      if (confirmation !== currentPreview.confirmation) throw new AdminError("application_confirmation_invalid", `Confirmation must equal ${currentPreview.confirmation} exactly.`);
      const registryPath = join(this.repositoryRoot, REGISTRY_RELATIVE_PATH);
      const channelsPath = join(this.repositoryRoot, CHANNELS_RELATIVE_PATH);
      const originalBytes = this.#state.registryFile.bytes;
      try {
        if (currentPreview.operation === "add") addAssetAlias(registryPath, channelsPath, assetId, currentPreview.alias);
        else removeAssetAlias(registryPath, channelsPath, assetId, currentPreview.alias);
      } catch (error) {
        await writeFile(registryPath, originalBytes);
        await this.refresh();
        if (error instanceof RegistryError) throw new AdminError("alias_change_failed", error.message, 409);
        throw error;
      }
      await this.refresh();
      this.#aliasChangePreviews.delete(previewId);
      return Object.freeze({
        schemaVersion: 1,
        asset: this.getAsset(assetId),
        operation: currentPreview.operation,
        alias: currentPreview.alias,
        applied: true,
        effects: Object.freeze({ registryChanged: true, packMembershipChanged: false, logoChanged: false, discordContacted: false }),
      });
    });
  }

  releaseArchiveState(): Readonly<Record<string, unknown>> {
    const currentPackIds = new Set(this.#state.packs.map((pack) => pack.id));
    const packIds = this.releases.listPackIds();
    const releases = packIds.flatMap((packId) => this.releases.listReleases(packId).map((record) => this.#releaseSummary(record, currentPackIds.has(packId))));
    releases.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt), "en"));
    return Object.freeze({
      schemaVersion: 1,
      releaseCount: releases.length,
      publishedCount: releases.filter((record) => record.state === "published").length,
      interruptedCount: releases.filter((record) => record.state === "interrupted").length,
      releases: Object.freeze(releases),
    });
  }

  #releaseSummary(record: ReleaseRecord, packCurrent: boolean): Readonly<Record<string, unknown>> {
    const postedCount = record.analyses.filter((analysis) => analysis.discordMessageId !== null).length;
    return Object.freeze({
      releaseId: record.releaseId,
      version: record.version,
      packId: record.packId,
      packDisplayName: record.packDisplay,
      packCurrent,
      state: record.publishedAt === null ? "interrupted" as const : "published" as const,
      startedAt: record.startedAt,
      publishedAt: record.publishedAt,
      analysisCount: record.analyses.length,
      postedCount,
      destinationId: record.version === 1 ? record.channelId : record.forumChannelId,
      detailUrl: `/api/v1/releases/${encodeURIComponent(record.packId)}/${encodeURIComponent(record.releaseId)}`,
      recordUrl: `/api/v1/releases/${encodeURIComponent(record.packId)}/${encodeURIComponent(record.releaseId)}/release.json`,
    });
  }

  releaseArchiveDetail(packId: string, releaseId: string): Readonly<Record<string, unknown>> {
    let record: ReleaseRecord;
    try { record = this.releases.getRelease(packId, releaseId); }
    catch (error) { throw new AdminError("release_not_found", error instanceof Error ? error.message : "Release was not found.", 404); }
    return Object.freeze({
      schemaVersion: 1,
      ...this.#releaseSummary(record, this.#state.byPackId.has(packId)),
      corrections: Object.freeze([...record.corrections]),
      analyses: Object.freeze(record.analyses.map((analysis) => Object.freeze({
        assetId: analysis.assetId,
        displayName: analysis.display,
        capturedAt: analysis.capturedAt,
        imageFile: analysis.imageFile,
        threadId: "threadId" in analysis ? analysis.threadId : null,
        discordMessageId: analysis.discordMessageId,
        postedAt: analysis.postedAt,
        imageUrl: `/api/v1/releases/${encodeURIComponent(packId)}/${encodeURIComponent(releaseId)}/images/${encodeURIComponent(analysis.imageFile)}`,
      }))),
    });
  }

  releaseRecordBytes(packId: string, releaseId: string): Buffer {
    try { return this.releases.recordBytes(packId, releaseId); }
    catch (error) { throw new AdminError("release_not_found", error instanceof Error ? error.message : "Release was not found.", 404); }
  }

  async releaseImageBytes(packId: string, releaseId: string, imageFile: string): Promise<Buffer> {
    let record: ReleaseRecord;
    try { record = this.releases.getRelease(packId, releaseId); }
    catch (error) { throw new AdminError("release_not_found", error instanceof Error ? error.message : "Release was not found.", 404); }
    if (!record.analyses.some((analysis) => analysis.imageFile === imageFile)) throw new AdminError("release_artifact_not_found", "Release image was not found.", 404);
    try { return await readFile(this.releases.imagePath(packId, releaseId, imageFile)); }
    catch (error) { throw new AdminError("release_artifact_not_found", error instanceof Error ? error.message : "Release image was not found.", 404); }
  }

  listPacks(): readonly AdminPackSummary[] {
    return Object.freeze(this.#state.packs.map((pack) => Object.freeze({
      id: pack.id,
      displayName: pack.display,
      logicalChannel: pack.channel,
      membershipCount: pack.assets.length,
    })));
  }

  getPack(packId: string): AdminPackDetail {
    const pack = this.#state.byPackId.get(packId);
    if (pack === undefined) throw new AdminError("pack_not_found", `Pack ${packId} was not found.`, 404, { packId });
    return Object.freeze({
      id: pack.id,
      displayName: pack.display,
      logicalChannel: pack.channel,
      membershipCount: pack.assets.length,
      assets: Object.freeze(pack.assets.map((assetId) => this.getAsset(assetId))),
    });
  }

  async listDrafts(): Promise<readonly AdminDraftRecord[]> {
    const ids = this.validAssetIds();
    const drafts = await this.workspace.listDrafts();
    return Object.freeze(drafts.map((draft) => Object.freeze({ draft, validation: validatePackDraft(draft, ids) })));
  }

  async getDraft(draftId: string): Promise<AdminDraftRecord> {
    const draft = await this.workspace.readDraft(draftId);
    return Object.freeze({ draft, validation: validatePackDraft(draft, this.validAssetIds()) });
  }

  async createDraft(value: unknown): Promise<AdminDraftRecord> {
    const draft = parsePackDraft(value, this.validAssetIds());
    const saved = await this.workspace.createDraft(draft, this.validAssetIds());
    return Object.freeze({ draft: saved, validation: validatePackDraft(saved, this.validAssetIds()) });
  }

  async updateDraft(draftId: string, expectedRevision: number, value: unknown): Promise<AdminDraftRecord> {
    const draft = parsePackDraft(value, this.validAssetIds());
    if (draft.id !== draftId) throw new AdminError("invalid_request", "Route draft id must match draft.id.");
    const saved = await this.workspace.updateDraft({ expectedRevision, draft }, this.validAssetIds());
    return Object.freeze({ draft: saved, validation: validatePackDraft(saved, this.validAssetIds()) });
  }

  async deleteDraft(draftId: string, expectedRevision: number): Promise<void> {
    await this.workspace.deleteDraft({ draftId, expectedRevision }, this.validAssetIds());
  }

  async validateDraft(draftId: string): Promise<PackDraftValidationResult> {
    const draft = await this.workspace.readDraft(draftId);
    return validatePackDraft(draft, this.validAssetIds());
  }

  async exportDraft(draftId: string): Promise<Buffer> {
    return this.workspace.exportDraft(draftId);
  }

  async createPackPromotionProposal(draftId: string, requestValue: unknown): Promise<{ readonly promotionId: string; readonly artifacts: readonly unknown[] }> {
    const context = this.promotionContext();
    const validated = validatePackDraftPromotionRequest(requestValue, context.channels);
    if (!validated.ok) throw new AdminError(validated.reason as never, validated.detail);
    if (validated.value.draftId !== draftId) throw new AdminError("invalid_request", "Route draft id must match promotion request draftId.");
    const requestBytes = serializePackDraftPromotionRequest(validated.value);
    const draft = await this.draftArtifact(draftId);
    const proposed = proposePackDraftPromotion({ requestValue: validated.value, requestBytes, draftBytes: draft.bytes, context });
    if (!proposed.ok) throw new AdminError(proposed.reason as never, proposed.detail);
    const proposalBytes = serializePackSourceProposal(proposed.value);
    const promotionId = promotionSha256(requestBytes);
    const artifacts = await this.promotions.writeArtifacts(draftId, promotionId, {
      "promotion-request.json": requestBytes,
      "pack-proposal.json": proposalBytes,
    });
    return Object.freeze({ promotionId, artifacts });
  }

  async planPackPromotion(draftId: string, promotionId: string, authorizationValue: unknown): Promise<{ readonly promotionId: string; readonly artifacts: readonly unknown[] }> {
    const requestBytes = await this.promotions.readArtifact(draftId, promotionId, "promotion-request.json");
    const proposalBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-proposal.json");
    const requestValue = JSON.parse(requestBytes.toString("utf8")) as unknown;
    const proposalValue = JSON.parse(proposalBytes.toString("utf8")) as unknown;
    const authorization = validatePackSourcePlanningAuthorization(authorizationValue);
    if (!authorization.ok) throw new AdminError(authorization.reason as never, authorization.detail);
    const authorizationBytes = serializePackSourcePlanningAuthorization(authorization.value);
    const draft = await this.draftArtifact(draftId);
    const planned = planPackSourceChange({ requestValue, requestBytes, draftBytes: draft.bytes, proposalValue, proposalBytes, authorizationValue: authorization.value, authorizationBytes, context: this.promotionContext() });
    if (!planned.ok) throw new AdminError(planned.reason as never, planned.detail);
    const planBytes = serializePackSourceApplicationPlan(planned.value);
    const artifacts = await this.promotions.writeArtifacts(draftId, promotionId, {
      "planning-authorization.json": authorizationBytes,
      "pack-application-plan.json": planBytes,
    });
    return Object.freeze({ promotionId, artifacts });
  }

  async generatePackPromotionSourceChange(draftId: string, promotionId: string): Promise<{ readonly promotionId: string; readonly artifacts: readonly unknown[] }> {
    const requestBytes = await this.promotions.readArtifact(draftId, promotionId, "promotion-request.json");
    const proposalBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-proposal.json");
    const authorizationBytes = await this.promotions.readArtifact(draftId, promotionId, "planning-authorization.json");
    const planBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-application-plan.json");
    const draft = await this.draftArtifact(draftId);
    const generated = generatePackSourceChange({
      requestValue: JSON.parse(requestBytes.toString("utf8")) as unknown, requestBytes, draftBytes: draft.bytes,
      proposalValue: JSON.parse(proposalBytes.toString("utf8")) as unknown, proposalBytes,
      authorizationValue: JSON.parse(authorizationBytes.toString("utf8")) as unknown, authorizationBytes,
      planValue: JSON.parse(planBytes.toString("utf8")) as unknown, planBytes, context: this.promotionContext(),
    });
    if (!generated.ok) throw new AdminError(generated.reason as never, generated.detail);
    const receiptBytes = serializePackSourceChangeReceipt(generated.value.receipt);
    const artifacts = await this.promotions.writeArtifacts(draftId, promotionId, {
      "pack-source.patch": generated.value.patch,
      "pack-source-change.json": receiptBytes,
      "packs-after.json": generated.value.packsAfter,
    });
    return Object.freeze({ promotionId, artifacts });
  }


  async reviewPackPromotion(draftId: string, promotionId: string, decisionValue: unknown): Promise<{ readonly promotionId: string; readonly artifacts: readonly unknown[] }> {
    const requestBytes = await this.promotions.readArtifact(draftId, promotionId, "promotion-request.json");
    const proposalBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-proposal.json");
    const planningAuthorizationBytes = await this.promotions.readArtifact(draftId, promotionId, "planning-authorization.json");
    const planBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-application-plan.json");
    const patchBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-source.patch");
    const sourceChangeBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-source-change.json");
    const decision = validatePackSourceChangeReviewDecision(decisionValue);
    if (!decision.ok) throw new AdminError(decision.reason as never, decision.detail);
    const decisionBytes = serializePackSourceChangeReviewDecision(decision.value);
    const requestValue = JSON.parse(requestBytes.toString("utf8")) as unknown;
    const requestValidation = validatePackDraftPromotionRequest(requestValue, this.promotionContext().channels);
    if (!requestValidation.ok) throw new AdminError(requestValidation.reason as never, requestValidation.detail);
    const draft = await this.draftArtifact(requestValidation.value.draftId);
    const context = this.promotionContext();
    const reviewed = reviewPackSourceChange({
      promotionRequestValue: requestValue, promotionRequestBytes: requestBytes, promotionRequestSha256: promotionSha256(requestBytes),
      draftBytes: draft.bytes, draftSha256: promotionSha256(draft.bytes),
      proposalValue: JSON.parse(proposalBytes.toString("utf8")) as unknown, proposalBytes, proposalSha256: promotionSha256(proposalBytes),
      planningAuthorizationValue: JSON.parse(planningAuthorizationBytes.toString("utf8")) as unknown, planningAuthorizationBytes, planningAuthorizationSha256: promotionSha256(planningAuthorizationBytes),
      applicationPlanValue: JSON.parse(planBytes.toString("utf8")) as unknown, applicationPlanBytes: planBytes, applicationPlanSha256: promotionSha256(planBytes),
      sourcePatchBytes: patchBytes, sourcePatchSha256: promotionSha256(patchBytes),
      sourceChangeReceiptValue: JSON.parse(sourceChangeBytes.toString("utf8")) as unknown, sourceChangeReceiptBytes: sourceChangeBytes, sourceChangeReceiptSha256: promotionSha256(sourceChangeBytes),
      reviewDecisionValue: decision.value, reviewDecisionBytes: decisionBytes, reviewDecisionSha256: promotionSha256(decisionBytes),
      context, patchApplyCheckVerified: await verifyPackPatch(patchBytes, context.packsBytes),
    });
    if (!reviewed.ok) throw new AdminError(reviewed.reason as never, reviewed.detail);
    const artifacts = await this.promotions.writeArtifacts(draftId, promotionId, {
      "pack-review-decision.json": decisionBytes,
      "pack-source-review.json": serializePackSourceChangeReviewReceipt(reviewed.receipt),
    });
    return Object.freeze({ promotionId, artifacts });
  }

  async storePackApplicationAuthorization(draftId: string, promotionId: string, authorizationValue: unknown): Promise<{ readonly promotionId: string; readonly artifacts: readonly unknown[] }> {
    const authorization = validatePackSourceApplicationAuthorization(authorizationValue);
    if (!authorization.ok) throw new AdminError(authorization.reason as never, authorization.detail);
    const reviewBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-source-review.json");
    const sourceChangeBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-source-change.json");
    const planBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-application-plan.json");
    const patchBytes = await this.promotions.readArtifact(draftId, promotionId, "pack-source.patch");
    const auth = authorization.value;
    if (auth.packSourceChangeReviewSha256 !== promotionSha256(reviewBytes) || auth.packSourceChangeReceiptSha256 !== promotionSha256(sourceChangeBytes) || auth.packApplicationPlanSha256 !== promotionSha256(planBytes) || auth.sourcePatchSha256 !== promotionSha256(patchBytes)) {
      throw new AdminError("application_authorization_hash_mismatch", "Application authorization does not bind the exact prepared artifacts.");
    }
    const bytes = serializePackSourceApplicationAuthorization(auth);
    const artifacts = await this.promotions.writeArtifacts(draftId, promotionId, { "pack-application-authorization.json": bytes });
    return Object.freeze({ promotionId, artifacts });
  }

  async applyPackPromotion(draftId: string, promotionId: string, confirmation: unknown): Promise<{ readonly promotionId: string; readonly receiptSha256: string; readonly receiptBytes: number; readonly receipt: unknown }> {
    if (confirmation === undefined || confirmation === null || confirmation === "") throw new AdminError("application_confirmation_required", "Exact application confirmation is required.");
    if (confirmation !== "APPLY PACK SOURCE CHANGE") throw new AdminError("application_confirmation_invalid", "Confirmation must equal APPLY PACK SOURCE CHANGE exactly.");
    return this.#withCanonicalSourceMutationLock(async () => {
      await this.refresh();
    const names = {
      promotionRequestPath: "promotion-request.json", proposalPath: "pack-proposal.json", planningAuthorizationPath: "planning-authorization.json",
      planPath: "pack-application-plan.json", patchPath: "pack-source.patch", sourceChangePath: "pack-source-change.json",
      reviewDecisionPath: "pack-review-decision.json", reviewPath: "pack-source-review.json", applicationAuthorizationPath: "pack-application-authorization.json",
      receiptOutputPath: "pack-source-application.json",
    } as const;
    const paths = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await this.promotions.artifactPath(draftId, promotionId, name)]))) as unknown as Record<keyof typeof names, string>;
    const { applyPackSourceChangeFile } = await import("../packs/pack-source-application-file.ts");
    const result = await applyPackSourceChangeFile({ repositoryRoot: this.repositoryRoot, workspaceRoot: this.workspace.root, ...paths });
    if (!result.ok) throw new AdminError(result.reason as never, result.detail, result.reason === "output_already_exists" ? 409 : 400);
    await this.refresh();
    return Object.freeze({ promotionId, receiptSha256: result.receiptSha256, receiptBytes: result.receiptBytes, receipt: result.receipt });
    });
  }

  async packPromotionApplicationStatus(draftId: string, promotionId: string): Promise<Readonly<Record<string, unknown>>> {
    const artifacts = await this.promotions.listArtifacts(draftId, promotionId);
    const application = artifacts.find((entry) => entry.name === "pack-source-application.json");
    if (application === undefined) return Object.freeze({ schemaVersion: 1, promotionId, applicationStatus: "not_applied", applied: false, artifacts });
    const bytes = await this.promotions.readArtifact(draftId, promotionId, "pack-source-application.json");
    return Object.freeze({ schemaVersion: 1, promotionId, applicationStatus: "applied", applied: true, applicationReceiptSha256: promotionSha256(bytes), applicationReceiptBytes: bytes.length, artifacts });
  }

  async listPackPromotionArtifacts(draftId: string, promotionId: string): Promise<readonly unknown[]> {
    return this.promotions.listArtifacts(draftId, promotionId);
  }

  async readPackPromotionArtifact(draftId: string, promotionId: string, name: PackPromotionArtifactName): Promise<Buffer> {
    return this.promotions.readArtifact(draftId, promotionId, name);
  }

  #assetRegistrationCanonicalPaths(): { readonly registryPath: string; readonly packsPath: string; readonly channelsPath: string } {
    return Object.freeze({
      registryPath: join(this.repositoryRoot, REGISTRY_RELATIVE_PATH),
      packsPath: join(this.repositoryRoot, PACKS_RELATIVE_PATH),
      channelsPath: join(this.repositoryRoot, CHANNELS_RELATIVE_PATH),
    });
  }

  #assetFailure(reason: string, detail: string, context: "proposal" | "planning" | "source-change" | "review" | "authorization" | "apply"): never {
    const aliases: Readonly<Record<string, string>> = Object.freeze({
      invalid_registration_input: "invalid_asset_registration_input",
      invalid_proposal: "invalid_asset_registration_proposal",
      invalid_authorization: context === "planning" ? "invalid_asset_registration_planning_authorization" : "invalid_asset_registration_application_authorization",
      invalid_application_plan: "invalid_asset_registration_application_plan",
      invalid_source_patch: "invalid_asset_registration_source_change",
      invalid_source_change_receipt: "invalid_asset_registration_source_change",
      invalid_review_decision: "invalid_asset_registration_review_decision",
      invalid_source_change_review: "invalid_asset_registration_source_change_review",
      invalid_application_authorization: "invalid_asset_registration_application_authorization",
      asset_already_exists: "asset_id_already_exists",
      stale_channel_configuration: "stale_channel_state",
      source_replace_failed: "source_write_failed",
      post_apply_validation_failed: "source_write_verification_failed",
      source_change_already_applied: "application_already_completed",
      source_change_not_approved: "source_change_review_rejected",
      input_changed_during_generation: "input_changed_during_operation",
      finalize_failed: context === "apply" ? "application_receipt_finalize_failed" : "finalize_failed",
    });
    const code = aliases[reason] ?? reason;
    const status = code === "output_already_exists" || code === "application_already_completed" ? 409
      : code === "internal_error" ? 500
      : 400;
    throw new AdminError(code as never, detail, status);
  }

  async #validateAssetRegistrationInputProposalChain(registrationId: string): Promise<void> {
    const [inputBytes, proposalBytes, currentState] = await Promise.all([
      this.assetRegistrations.readArtifact(registrationId, "registration-input.json"),
      this.assetRegistrations.readArtifact(registrationId, "asset-proposal.json"),
      AdminService.#loadState(this.repositoryRoot),
    ]);

    let proposalValue: unknown;
    try { proposalValue = JSON.parse(proposalBytes.toString("utf8")) as unknown; }
    catch { throw new AdminError("invalid_asset_registration_proposal", "Stored Asset registration proposal is not valid JSON."); }
    const proposal = validateAssetRegistrationProposalReceipt(proposalValue, this.#state.rawChannels);
    if (!proposal.ok) this.#assetFailure(proposal.reason, proposal.detail, "proposal");

    if (currentState.channelsFile.sha256 !== this.#state.channelsFile.sha256) {
      throw new AdminError("stale_channel_state", "Canonical channel configuration no longer matches the state used to create the stored proposal.");
    }
    if (currentState.registryFile.sha256 !== this.#state.registryFile.sha256) {
      const proposalAgainstCurrentRegistry = proposeAssetRegistration({
        schemaVersion: proposal.proposal.schemaVersion,
        operation: proposal.proposal.operation,
        asset: proposal.proposal.asset,
        targetPackIds: proposal.proposal.targetPacks.map((target) => target.packId),
        decision: proposal.proposal.decision,
        ...(proposal.proposal.expectedCurrent === undefined ? {} : { expectedCurrent: proposal.proposal.expectedCurrent }),
      }, currentState.assets, currentState.packs, currentState.rawChannels);
      if (!proposalAgainstCurrentRegistry.ok) {
        this.#assetFailure(proposalAgainstCurrentRegistry.reason, proposalAgainstCurrentRegistry.detail, "proposal");
      }
      throw new AdminError("stale_registry_state", "Canonical Registry source no longer matches the state used to create the stored proposal.");
    }
    if (currentState.packsFile.sha256 !== this.#state.packsFile.sha256) {
      throw new AdminError("stale_pack_state", "Canonical Packs source no longer matches the state used to create the stored proposal.");
    }
    if (
      proposal.proposal.registryState.assetCount !== currentState.assets.length ||
      proposal.proposal.registryState.registryFingerprint !== currentState.registryFingerprint
    ) {
      throw new AdminError("stale_registry_state", "Canonical Registry state no longer matches the Registry identity bound by the stored proposal.");
    }

    let inputValue: unknown;
    try { inputValue = JSON.parse(inputBytes.toString("utf8")) as unknown; }
    catch { throw new AdminError("invalid_asset_registration_input", "Stored Asset registration input is not valid JSON."); }
    const input = validateAssetRegistrationInput(inputValue, currentState.rawChannels);
    if (!input.ok) this.#assetFailure(input.reason, input.detail, "proposal");
    const reconstructed = proposeAssetRegistration(input.input, currentState.assets, currentState.packs, currentState.rawChannels);
    if (!reconstructed.ok) this.#assetFailure(reconstructed.reason, reconstructed.detail, "proposal");
    if (!serializeAssetRegistrationProposal(reconstructed.proposal).equals(proposalBytes)) {
      throw new AdminError("proposal_reconstruction_mismatch", "Stored registration input no longer reconstructs the exact stored proposal.");
    }
  }

  async createAssetRegistrationProposal(registrationId: string, inputValue: unknown): Promise<Readonly<Record<string, unknown>>> {
    this.assetRegistrations.validateRegistrationId(registrationId);
    const validated = validateAssetRegistrationInput(inputValue, this.#state.rawChannels);
    if (!validated.ok) this.#assetFailure(validated.reason, validated.detail, "proposal");
    if (validated.input.schemaVersion !== 2) {
      throw new AdminError("invalid_asset_registration_input", "Administration Asset registrations require schemaVersion 2.");
    }
    if (validated.input.asset.id !== registrationId) {
      throw new AdminError("invalid_asset_registration_input", "Route registration id must match input.asset.id.");
    }
    const inputBytes = Buffer.from(`${JSON.stringify(validated.input, null, 2)}\n`, "utf8");
    await this.assetRegistrations.writeArtifact(registrationId, "registration-input.json", inputBytes);
    const inputPath = await this.assetRegistrations.artifactPath(registrationId, "registration-input.json", false);
    const outputPath = await this.assetRegistrations.artifactPath(registrationId, "asset-proposal.json");
    const result = await proposeAssetRegistrationFile({ inputPath, outputPath, ...this.#assetRegistrationCanonicalPaths() });
    if (!result.ok) {
      await this.assetRegistrations.removeArtifact(registrationId, "registration-input.json").catch(() => undefined);
      this.#assetFailure(result.reason, result.detail, "proposal");
    }
    return this.assetRegistrationStatus(registrationId);
  }

  async storeAssetRegistrationPlanningAuthorization(registrationId: string, authorizationValue: unknown): Promise<Readonly<Record<string, unknown>>> {
    await this.#validateAssetRegistrationInputProposalChain(registrationId);
    const proposalBytes = await this.assetRegistrations.readArtifact(registrationId, "asset-proposal.json");
    const validated = validateAssetRegistrationApplicationAuthorization(authorizationValue);
    if (!validated.ok) this.#assetFailure(validated.reason, validated.detail, "planning");
    if (validated.authorization.proposalSha256 !== sha256(proposalBytes)) {
      throw new AdminError("planning_authorization_hash_mismatch", "Planning authorization does not bind the exact stored proposal.");
    }
    const bytes = serializeAssetRegistrationApplicationAuthorization(validated.authorization);
    await this.assetRegistrations.writeArtifact(registrationId, "planning-authorization.json", bytes);
    return this.assetRegistrationStatus(registrationId);
  }

  async generateAssetRegistrationPlan(registrationId: string): Promise<Readonly<Record<string, unknown>>> {
    await this.#validateAssetRegistrationInputProposalChain(registrationId);
    const authorizationBytes = await this.assetRegistrations.readArtifact(registrationId, "planning-authorization.json");
    let authorizationValue: unknown;
    try { authorizationValue = JSON.parse(authorizationBytes.toString("utf8")) as unknown; }
    catch { throw new AdminError("invalid_asset_registration_planning_authorization", "Stored planning authorization is not valid JSON."); }
    const authorization = validateAssetRegistrationApplicationAuthorization(authorizationValue);
    if (!authorization.ok) this.#assetFailure(authorization.reason, authorization.detail, "planning");
    if (authorization.authorization.decision !== "approved") {
      throw new AdminError("planning_authorization_rejected", "Rejected planning authorization blocks application planning.");
    }
    const proposalPath = await this.assetRegistrations.artifactPath(registrationId, "asset-proposal.json", false);
    const authorizationPath = await this.assetRegistrations.artifactPath(registrationId, "planning-authorization.json", false);
    const outputPath = await this.assetRegistrations.artifactPath(registrationId, "asset-application-plan.json");
    const result = await planAssetRegistrationApplicationFile({ proposalPath, authorizationPath, outputPath, ...this.#assetRegistrationCanonicalPaths() });
    if (!result.ok) this.#assetFailure(result.reason, result.detail, "planning");
    return this.assetRegistrationStatus(registrationId);
  }

  async generateAssetRegistrationSourceChange(registrationId: string): Promise<Readonly<Record<string, unknown>>> {
    await this.#validateAssetRegistrationInputProposalChain(registrationId);
    const paths = this.#assetRegistrationCanonicalPaths();
    const result = await generateAssetRegistrationSourceChangeFile({
      proposalPath: await this.assetRegistrations.artifactPath(registrationId, "asset-proposal.json", false),
      authorizationPath: await this.assetRegistrations.artifactPath(registrationId, "planning-authorization.json", false),
      planPath: await this.assetRegistrations.artifactPath(registrationId, "asset-application-plan.json", false),
      patchOutputPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source.patch"),
      receiptOutputPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source-change.json"),
      ...paths,
      repositoryRoot: this.repositoryRoot,
      expectedRegistrySha256: this.#state.registryFile.sha256,
      expectedPacksSha256: this.#state.packsFile.sha256,
      expectedChannelsSha256: this.#state.channelsFile.sha256,
    });
    if (!result.ok) this.#assetFailure(result.reason, result.detail, "source-change");
    return this.assetRegistrationStatus(registrationId);
  }

  async reviewAssetRegistration(registrationId: string, decisionValue: unknown): Promise<Readonly<Record<string, unknown>>> {
    await this.#validateAssetRegistrationInputProposalChain(registrationId);
    const decision = validateAssetRegistrationSourceChangeReviewDecision(decisionValue);
    if (!decision.ok) this.#assetFailure(decision.reason, decision.detail, "review");
    const decisionBytes = serializeAssetRegistrationSourceChangeReviewDecision(decision.decision);
    await this.assetRegistrations.writeArtifact(registrationId, "asset-review-decision.json", decisionBytes);
    const result = await reviewAssetRegistrationSourceChangeFile({
      proposalPath: await this.assetRegistrations.artifactPath(registrationId, "asset-proposal.json", false),
      planningAuthorizationPath: await this.assetRegistrations.artifactPath(registrationId, "planning-authorization.json", false),
      planPath: await this.assetRegistrations.artifactPath(registrationId, "asset-application-plan.json", false),
      patchPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source.patch", false),
      sourceChangeReceiptPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source-change.json", false),
      decisionPath: await this.assetRegistrations.artifactPath(registrationId, "asset-review-decision.json", false),
      outputPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source-review.json"),
      repositoryRoot: this.repositoryRoot,
    });
    if (!result.ok) {
      await this.assetRegistrations.removeArtifact(registrationId, "asset-review-decision.json").catch(() => undefined);
      this.#assetFailure(result.reason, result.detail, "review");
    }
    return this.assetRegistrationStatus(registrationId);
  }

  async storeAssetRegistrationApplicationAuthorization(registrationId: string, authorizationValue: unknown): Promise<Readonly<Record<string, unknown>>> {
    await this.#validateAssetRegistrationInputProposalChain(registrationId);
    const validated = validateAssetRegistrationSourceApplicationAuthorization(authorizationValue);
    if (!validated.ok) this.#assetFailure(validated.reason, validated.detail, "authorization");
    const [reviewBytes, patchBytes, receiptBytes] = await Promise.all([
      this.assetRegistrations.readArtifact(registrationId, "asset-source-review.json"),
      this.assetRegistrations.readArtifact(registrationId, "asset-source.patch"),
      this.assetRegistrations.readArtifact(registrationId, "asset-source-change.json"),
    ]);
    const reviewValue = JSON.parse(reviewBytes.toString("utf8")) as unknown;
    const review = validateAssetRegistrationSourceChangeReviewReceipt(reviewValue);
    if (!review.ok) this.#assetFailure(review.reason, review.detail, "authorization");
    if (validated.authorization.decision === "approved" && review.receipt.reviewStatus !== "approved") {
      throw new AdminError("source_change_review_rejected", "Approved application authorization requires an approved source-change review.");
    }
    if (
      validated.authorization.sourceChangeReviewSha256 !== sha256(reviewBytes) ||
      validated.authorization.sourcePatchSha256 !== sha256(patchBytes) ||
      validated.authorization.sourceChangeReceiptSha256 !== sha256(receiptBytes)
    ) {
      throw new AdminError("application_authorization_hash_mismatch", "Application authorization does not bind the exact reviewed source change.");
    }
    await this.assetRegistrations.writeArtifact(
      registrationId,
      "asset-application-authorization.json",
      serializeAssetRegistrationSourceApplicationAuthorization(validated.authorization),
    );
    return this.assetRegistrationStatus(registrationId);
  }

  async applyAssetRegistration(registrationId: string, confirmation: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (confirmation === undefined || confirmation === null || confirmation === "") {
      throw new AdminError("application_confirmation_required", "Exact application confirmation is required.");
    }
    if (confirmation !== "APPLY ASSET SOURCE CHANGE") {
      throw new AdminError("application_confirmation_invalid", "Confirmation must equal APPLY ASSET SOURCE CHANGE exactly.");
    }
    return this.#withCanonicalSourceMutationLock(async () => {
      await this.refresh();
    if ((await this.assetRegistrations.listArtifacts(registrationId)).some((artifact) => artifact.name === "asset-source-application.json")) {
      throw new AdminError("application_already_completed", "This exact Asset source application already has a successful receipt.", 409);
    }
    await this.#validateAssetRegistrationInputProposalChain(registrationId);
    const result = await applyAssetRegistrationSourceChangeFile({
      proposalPath: await this.assetRegistrations.artifactPath(registrationId, "asset-proposal.json", false),
      planningAuthorizationPath: await this.assetRegistrations.artifactPath(registrationId, "planning-authorization.json", false),
      planPath: await this.assetRegistrations.artifactPath(registrationId, "asset-application-plan.json", false),
      patchPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source.patch", false),
      sourceChangeReceiptPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source-change.json", false),
      reviewPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source-review.json", false),
      applicationAuthorizationPath: await this.assetRegistrations.artifactPath(registrationId, "asset-application-authorization.json", false),
      repositoryRoot: this.repositoryRoot,
      applicationReceiptOutputPath: await this.assetRegistrations.artifactPath(registrationId, "asset-source-application.json"),
    });
    if (!result.ok) this.#assetFailure(result.reason, result.detail, "apply");
    await this.refresh();
    const receiptBytes = await this.assetRegistrations.readArtifact(registrationId, "asset-source-application.json");
    return Object.freeze({
      registrationId,
      receiptSha256: sha256(receiptBytes),
      receiptBytes: receiptBytes.length,
      receipt: result.receipt,
      status: await this.assetRegistrationStatus(registrationId),
    });
    });
  }

  async assetRegistrationStatus(registrationId: string): Promise<Readonly<Record<string, unknown>>> {
    this.assetRegistrations.validateRegistrationId(registrationId);
    const currentState = await AdminService.#loadState(this.repositoryRoot);
    const artifacts = await this.assetRegistrations.listArtifacts(registrationId);
    const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact] as const));
    const readJson = async (name: AssetRegistrationArtifactName): Promise<unknown | null> => {
      if (!byName.has(name)) return null;
      try { return JSON.parse((await this.assetRegistrations.readArtifact(registrationId, name)).toString("utf8")) as unknown; }
      catch { return null; }
    };
    const [input, proposal, planningAuthorization, plan, sourceChange, review, applicationAuthorization, applicationReceipt] = await Promise.all([
      readJson("registration-input.json"), readJson("asset-proposal.json"), readJson("planning-authorization.json"),
      readJson("asset-application-plan.json"), readJson("asset-source-change.json"), readJson("asset-source-review.json"),
      readJson("asset-application-authorization.json"), readJson("asset-source-application.json"),
    ]);
    const record = (value: unknown): Readonly<Record<string, unknown>> | null => isRecord(value) ? value : null;
    const proposalRecord = record(proposal);
    const planningAuthorizationRecord = record(planningAuthorization);
    const planRecord = record(plan);
    const reviewRecord = record(review);
    const authorizationRecord = record(applicationAuthorization);
    const applicationReceiptRecord = record(applicationReceipt);
    const sourceRecord = record(sourceChange);
    const sourceState = record(sourceRecord?.sourceState);
    const registryState = record(sourceState?.registry);
    const packsState = record(sourceState?.packs);
    const channelsState = record(sourceState?.channels);
    const inputValidation = input === null ? null : validateAssetRegistrationInput(input, currentState.rawChannels);
    const proposalValidation = proposal === null ? null : validateAssetRegistrationProposalReceipt(proposal, currentState.rawChannels);
    const planningAuthorizationValidation = planningAuthorization === null ? null : validateAssetRegistrationApplicationAuthorization(planningAuthorization);
    const planValidation = plan === null ? null : validateAssetRegistrationApplicationPlanReceipt(plan, currentState.rawChannels);
    const reviewValidation = review === null ? null : validateAssetRegistrationSourceChangeReviewReceipt(review);
    const authorizationValidation = applicationAuthorization === null ? null : validateAssetRegistrationSourceApplicationAuthorization(applicationAuthorization);
    const inputMatchesProposal = inputValidation?.ok === true && proposalValidation?.ok === true &&
      JSON.stringify({
        operation: inputValidation.input.operation,
        asset: inputValidation.input.asset,
        targetPackIds: inputValidation.input.targetPackIds,
        decision: inputValidation.input.decision,
        expectedCurrent: inputValidation.input.expectedCurrent,
      }) === JSON.stringify({
        operation: proposalValidation.proposal.operation,
        asset: proposalValidation.proposal.asset,
        targetPackIds: proposalValidation.proposal.targetPacks.map((target) => target.packId),
        decision: proposalValidation.proposal.decision,
        expectedCurrent: proposalValidation.proposal.expectedCurrent,
      });
    const reviewApproved = reviewValidation?.ok === true && reviewRecord?.reviewStatus === "approved" && reviewRecord.applicationEligible === true;
    const authorizationApproved = authorizationValidation?.ok === true && authorizationRecord?.decision === "approved";
    const planTechnical = record(planRecord?.technicalValidation);
    const sourceInputs = record(sourceRecord?.inputs);
    const sourcePatch = record(sourceRecord?.patch);
    const reviewInputs = record(reviewRecord?.inputs);
    const reviewDecision = record(reviewRecord?.reviewDecision);
    const changedPaths = Array.isArray(sourcePatch?.changedPaths) ? sourcePatch.changedPaths : [];
    const bindingsValid = inputMatchesProposal && proposalValidation?.ok === true && planningAuthorizationValidation?.ok === true && planValidation?.ok === true &&
      reviewValidation?.ok === true && authorizationValidation?.ok === true && sourceRecord !== null &&
      planningAuthorizationRecord?.proposalSha256 === byName.get("asset-proposal.json")?.sha256 &&
      planTechnical?.proposalSha256 === byName.get("asset-proposal.json")?.sha256 &&
      planTechnical?.authorizationSha256 === byName.get("planning-authorization.json")?.sha256 &&
      sourceInputs?.proposalSha256 === byName.get("asset-proposal.json")?.sha256 &&
      sourceInputs?.authorizationSha256 === byName.get("planning-authorization.json")?.sha256 &&
      sourceInputs?.applicationPlanSha256 === byName.get("asset-application-plan.json")?.sha256 &&
      reviewInputs?.proposalSha256 === byName.get("asset-proposal.json")?.sha256 &&
      reviewInputs?.planningAuthorizationSha256 === byName.get("planning-authorization.json")?.sha256 &&
      reviewInputs?.applicationPlanSha256 === byName.get("asset-application-plan.json")?.sha256 &&
      reviewInputs?.sourcePatchSha256 === byName.get("asset-source.patch")?.sha256 &&
      reviewInputs?.sourceChangeReceiptSha256 === byName.get("asset-source-change.json")?.sha256 &&
      reviewInputs?.reviewDecisionSha256 === byName.get("asset-review-decision.json")?.sha256 &&
      authorizationRecord?.sourceChangeReviewSha256 === byName.get("asset-source-review.json")?.sha256 &&
      authorizationRecord?.sourcePatchSha256 === byName.get("asset-source.patch")?.sha256 &&
      authorizationRecord?.sourceChangeReceiptSha256 === byName.get("asset-source-change.json")?.sha256 &&
      reviewDecision?.decision === reviewRecord?.reviewStatus &&
      changedPaths.length === 1 && changedPaths[0] === REGISTRY_RELATIVE_PATH &&
      packsState?.changed === false && channelsState?.changed === false;
    const currentBeforeStateMatches = sourceRecord === null || (
      registryState?.beforeSha256 === currentState.registryFile.sha256 &&
      packsState?.beforeSha256 === currentState.packsFile.sha256 &&
      channelsState?.sha256 === currentState.channelsFile.sha256
    );
    const applicationReceiptInputs = record(applicationReceiptRecord?.inputs);
    const applicationReceiptSourceState = record(applicationReceiptRecord?.sourceState);
    const applicationReceiptRegistryState = record(applicationReceiptSourceState?.registry);
    const applicationReceiptPacksState = record(applicationReceiptSourceState?.packs);
    const applicationReceiptChannelsState = record(applicationReceiptSourceState?.channels);
    const applied = applicationReceiptRecord?.schemaVersion === 1 &&
      applicationReceiptRecord.applicationType === "visionx.asset-registration.source-application" &&
      applicationReceiptRecord.applicationStatus === "applied" && applicationReceiptRecord.sourceChangesApplied === true &&
      applicationReceiptInputs?.proposalSha256 === byName.get("asset-proposal.json")?.sha256 &&
      applicationReceiptInputs?.planningAuthorizationSha256 === byName.get("planning-authorization.json")?.sha256 &&
      applicationReceiptInputs?.applicationPlanSha256 === byName.get("asset-application-plan.json")?.sha256 &&
      applicationReceiptInputs?.sourcePatchSha256 === byName.get("asset-source.patch")?.sha256 &&
      applicationReceiptInputs?.sourceChangeReceiptSha256 === byName.get("asset-source-change.json")?.sha256 &&
      applicationReceiptInputs?.sourceChangeReviewSha256 === byName.get("asset-source-review.json")?.sha256 &&
      applicationReceiptInputs?.applicationAuthorizationSha256 === byName.get("asset-application-authorization.json")?.sha256 &&
      applicationReceiptRegistryState?.afterSha256 === currentState.registryFile.sha256 &&
      applicationReceiptPacksState?.afterSha256 === currentState.packsFile.sha256 &&
      applicationReceiptChannelsState?.sha256 === currentState.channelsFile.sha256;
    return Object.freeze({
      schemaVersion: 1,
      registrationId,
      workspaceState: "noncanonical",
      canonicalChangedOnlyByExplicitApply: true,
      input,
      proposal,
      planningAuthorization,
      applicationPlan: plan,
      sourceChange,
      sourceChangeReview: review,
      applicationAuthorization,
      applicationReceipt,
      artifacts,
      gates: Object.freeze({
        inputMatchesProposal,
        proposalCreated: proposalValidation?.ok === true && inputMatchesProposal,
        planningAuthorizationStored: planningAuthorizationValidation?.ok === true,
        planningAuthorized: planningAuthorizationValidation?.ok === true && planningAuthorizationRecord?.decision === "approved",
        planCreated: planValidation?.ok === true,
        sourceChangeCreated: sourceChange !== null && sourceRecord !== null,
        reviewCreated: reviewValidation?.ok === true,
        reviewApproved,
        applicationAuthorizationStored: authorizationValidation?.ok === true,
        applicationAuthorizationApproved: authorizationApproved,
        exactBindingsValid: bindingsValid,
        currentCanonicalBeforeStateMatches: currentBeforeStateMatches,
        applied,
        applyEnabled: reviewApproved && authorizationApproved && bindingsValid && currentBeforeStateMatches && !applied,
      }),
      currentCanonicalState: Object.freeze({
        registrySha256: currentState.registryFile.sha256,
        packsSha256: currentState.packsFile.sha256,
        channelsSha256: currentState.channelsFile.sha256,
        registryFingerprint: currentState.registryFingerprint,
        registryAssetCount: currentState.assets.length,
      }),
    });
  }

  async listAssetRegistrationArtifacts(registrationId: string): Promise<readonly unknown[]> {
    return this.assetRegistrations.listArtifacts(registrationId);
  }

  async readAssetRegistrationArtifact(registrationId: string, name: AssetRegistrationArtifactName): Promise<Buffer> {
    return this.assetRegistrations.readArtifact(registrationId, name);
  }
}

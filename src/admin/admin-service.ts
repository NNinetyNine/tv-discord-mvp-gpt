import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type { Asset } from "../types.ts";
import {
  prepareCreatePackWithMissingAssets,
  serializeCreatePackPreview,
  serializeCreatePackWithMissingAssetsInput,
  type CreatePackPreview,
} from "../application/create-pack-with-missing-assets.ts";
import { applyCreatePackWithMissingAssetsFile } from "../application/create-pack-with-missing-assets-file.ts";
import type { Pack } from "../packs/packs.ts";
import { buildPacks } from "../packs/packs.ts";
import { buildRegistry } from "../registry/registry.ts";
import { auditAssetMarketIdentity, type AssetMarketIdentityAudit } from "../registry/asset-market-identity-audit.ts";
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
const MAX_ASSET_SEARCH_LIMIT = 100 as const;
const DEFAULT_ASSET_SEARCH_LIMIT = 50 as const;

interface CanonicalFile {
  readonly relativePath: typeof REGISTRY_RELATIVE_PATH | typeof PACKS_RELATIVE_PATH | typeof CHANNELS_RELATIVE_PATH;
  readonly canonicalPath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
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
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly assets: readonly AdminAssetSummary[];
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

export interface AdminServiceOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
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
  #state: LiveState;

  private constructor(
    repositoryRoot: string,
    workspace: AdminWorkspace,
    promotions: AdminPromotionWorkspace,
    assetRegistrations: AdminAssetRegistrationWorkspace,
    packBuilder: AdminPackBuilderWorkspace,
    state: LiveState,
  ) {
    this.repositoryRoot = repositoryRoot;
    this.workspace = workspace;
    this.promotions = promotions;
    this.assetRegistrations = assetRegistrations;
    this.packBuilder = packBuilder;
    this.#state = state;
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
    const state = await AdminService.#loadState(repositoryRoot);
    return new AdminService(repositoryRoot, workspace, promotions, assetRegistrations, packBuilder, state);
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

  async previewPackCreation(value: unknown): Promise<CreatePackPreview> {
    await this.refresh();
    const prepared = prepareCreatePackWithMissingAssets({
      value,
      registryBytes: Buffer.from(this.#state.registryFile.bytes),
      packsBytes: Buffer.from(this.#state.packsFile.bytes),
      channelsBytes: Buffer.from(this.#state.channelsFile.bytes),
    });
    if (!prepared.ok) {
      const code = prepared.reason === "existing_asset_currency_missing"
        ? "existing_asset_currency_missing"
        : prepared.reason === "tradingview_conflict"
          ? "tradingview_conflict"
          : prepared.reason === "display_conflict"
            ? "display_conflict"
            : prepared.reason === "pack_already_exists"
              ? "pack_already_exists"
              : prepared.reason === "unknown_channel"
                ? "pack_channel_not_configured"
                : prepared.reason === "unresolved_channel"
                  ? "pack_channel_not_configured"
                  : "invalid_pack_builder_input";
      throw new AdminError(code, prepared.detail, code === "pack_already_exists" ? 409 : 400, {
        ...(prepared.memberIndex === undefined ? {} : { memberIndex: prepared.memberIndex }),
        ...(prepared.field === undefined ? {} : { field: prepared.field }),
      });
    }
    await this.packBuilder.savePreview(
      prepared.value.input.pack.id,
      serializeCreatePackWithMissingAssetsInput(prepared.value.input),
      serializeCreatePackPreview(prepared.value.preview),
    );
    return prepared.value.preview;
  }

  async createPackFromPreview(packId: string, previewId: unknown): Promise<Readonly<Record<string, unknown>>> {
    if (typeof previewId !== "string" || !/^[a-f0-9]{64}$/u.test(previewId)) {
      throw new AdminError("invalid_request", "previewId must be a lowercase SHA-256 identity.");
    }
    const state = await this.packBuilder.readState(packId);
    if (state.input === undefined || state.preview === undefined) {
      throw new AdminError("pack_builder_preview_not_found", "Create a current Pack preview before applying.", 404);
    }
    if (!isRecord(state.preview) || state.preview.previewId !== previewId) {
      throw new AdminError("pack_builder_preview_mismatch", "The submitted preview is not the current stored preview.", 409);
    }
    const paths = await this.packBuilder.paths(packId);
    const applied = await applyCreatePackWithMissingAssetsFile({
      repositoryRoot: this.repositoryRoot,
      inputPath: paths.input,
      previewPath: paths.preview,
      receiptOutputPath: paths.receipt,
    });
    if (!applied.ok) {
      const code = applied.reason === "stale_registry_state"
        ? "stale_registry_state"
        : applied.reason === "stale_pack_state"
          ? "stale_pack_state"
          : applied.reason === "stale_channel_state"
            ? "stale_channel_state"
            : applied.reason === "preview_mismatch"
              ? "pack_builder_preview_mismatch"
              : applied.reason === "application_already_completed"
                ? "application_already_completed"
                : applied.reason === "rollback_failed"
                  ? "rollback_failed"
                  : applied.reason === "rollback_verification_failed"
                    ? "rollback_verification_failed"
                    : applied.reason === "application_receipt_finalize_failed"
                      ? "application_receipt_finalize_failed"
                      : "pack_builder_transaction_failed";
      throw new AdminError(code, applied.detail, new Set(["stale_registry_state", "stale_pack_state", "stale_channel_state", "pack_builder_preview_mismatch", "application_already_completed"]).has(code) ? 409 : 500, { safelyRestored: applied.safelyRestored });
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

  searchAssets(options: { readonly query?: string; readonly offset?: number; readonly limit?: number } = {}): AdminAssetSearchResult {
    const query = options.query?.trim() ?? "";
    const offset = options.offset ?? 0;
    const limit = options.limit ?? DEFAULT_ASSET_SEARCH_LIMIT;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ASSET_SEARCH_LIMIT) {
      throw new AdminError("invalid_request", `offset must be nonnegative and limit must be between 1 and ${MAX_ASSET_SEARCH_LIMIT}.`);
    }
    const needle = query.toLocaleLowerCase("en-US");
    const matching = [...this.#state.assets]
      .filter((asset) => needle.length === 0 || [asset.id, asset.display, asset.tradingView, asset.channel]
        .some((value) => value.toLocaleLowerCase("en-US").includes(needle)))
      .sort((a, b) => a.id.localeCompare(b.id, "en"));
    const assets = matching.slice(offset, offset + limit).map((asset) => assetSummary(asset, this.#state.assetPackIds.get(asset.id) ?? []));
    return Object.freeze({
      schemaVersion: 1,
      query,
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

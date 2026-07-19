import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { Asset } from "../types.ts";
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
import { AdminPromotionWorkspace, type PackPromotionArtifactName } from "./admin-promotion-workspace.ts";
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
  readonly canonicalState: "read_only";
  readonly canonicalStateReadOnly: true;
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

function assetSummary(asset: Asset, packIds: readonly string[]): AdminAssetSummary {
  return Object.freeze({
    id: asset.id,
    displayName: asset.display,
    tradingViewSymbol: asset.tradingView,
    logicalChannel: asset.channel,
    packMembershipCount: packIds.length,
    packIds: Object.freeze([...packIds]),
  });
}

export class AdminService {
  readonly repositoryRoot: string;
  readonly workspace: AdminWorkspace;
  readonly promotions: AdminPromotionWorkspace;
  #state: LiveState;

  private constructor(repositoryRoot: string, workspace: AdminWorkspace, promotions: AdminPromotionWorkspace, state: LiveState) {
    this.repositoryRoot = repositoryRoot;
    this.workspace = workspace;
    this.promotions = promotions;
    this.#state = state;
  }

  static async create(options: AdminServiceOptions): Promise<AdminService> {
    const repositoryRoot = await resolveRepositoryRoot(options.repositoryRoot);
    const workspace = await AdminWorkspace.open({ workspaceRoot: options.workspaceRoot });
    if (pathInside(repositoryRoot, workspace.root) || pathInside(workspace.root, repositoryRoot)) {
      throw new AdminError("path_collision", "Repository root and administration workspace must be separate directories.");
    }
    const promotions = await AdminPromotionWorkspace.open(workspace.root);
    const state = await AdminService.#loadState(repositoryRoot);
    return new AdminService(repositoryRoot, workspace, promotions, state);
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

    const auditableAssets = assets.map((asset) => {
      const raw = (registryValue as Record<string, Record<string, unknown>>)[asset.id] ?? {};
      return Object.freeze({
        ...asset,
        ...(raw.market === undefined ? {} : { market: raw.market }),
        ...(raw.tradingViewSymbol === undefined ? {} : { tradingViewSymbol: raw.tradingViewSymbol }),
        ...(raw.currency === undefined ? {} : { currency: raw.currency }),
      });
    });
    const audit = auditAssetMarketIdentity(
      auditableAssets,
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
      canonicalState: "read_only",
      canonicalStateReadOnly: true,
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

  async listPackPromotionArtifacts(draftId: string, promotionId: string): Promise<readonly unknown[]> {
    return this.promotions.listArtifacts(draftId, promotionId);
  }

  async readPackPromotionArtifact(draftId: string, promotionId: string, name: PackPromotionArtifactName): Promise<Buffer> {
    return this.promotions.readArtifact(draftId, promotionId, name);
  }
}

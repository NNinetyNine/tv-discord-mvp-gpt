import { createHash } from "node:crypto";

import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import { previewChartPublicationMetadataForProposedAsset } from "../application/chart-publication-metadata-preview.ts";
import {
  computeAssetRegistrationRegistryFingerprint,
  serializeAssetRegistrationProposal,
  validateAssetRegistrationProposalReceipt,
  type AssetRegistrationExpectedCurrentV1,
  type AssetRegistrationExpectedCurrentV2,
  type AssetRegistrationOperation,
  type AssetRegistrationProposal,
  type AssetRegistrationProposalV1,
  type AssetRegistrationProposalV2,
} from "./asset-registration-proposal.ts";
import {
  serializeAssetRegistrationApplicationAuthorization,
  validateAssetRegistrationApplicationAuthorization,
  type AssetApplicationPackPlacement,
  type AssetPackPlacement,
  type AssetRegistrationApplicationAuthorization,
  type AssetApplicationAuthorizationFailureReason,
} from "./asset-registration-application-authorization.ts";
import type { ProposedAssetMarketIdentity } from "./asset-market-identity.ts";
import {
  validateAssetRegistrationChannel,
  type AssetRegistrationChannelFailureReason,
  type ChannelAwareProposedAssetMarketIdentity,
} from "./asset-registration-channel.ts";

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;

export type AssetRegistrationApplicationPlanFailureReason =
  | "invalid_proposal"
  | "invalid_plan"
  | "invalid_authorization"
  | "unsupported_schema_version"
  | "legacy_proposal_not_applicable"
  | "proposal_hash_mismatch"
  | "unsupported_decision"
  | "stale_registry_state"
  | "asset_already_exists"
  | "unknown_asset"
  | "stale_asset_state"
  | "channel_change_not_authorized"
  | AssetRegistrationChannelFailureReason
  | "unknown_target_pack"
  | "missing_pack_placement"
  | "unexpected_pack_placement"
  | "duplicate_pack_placement"
  | "invalid_pack_placement"
  | "unknown_pack_anchor"
  | "pack_membership_already_exists";

export interface AssetRegistrationApplicationPlanFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationApplicationPlanFailureReason;
  readonly detail: string;
}

export interface AddAssetOperationV1 {
  readonly type: "add_asset";
  readonly asset: ProposedAssetMarketIdentity;
}

export interface AddAssetOperationV2 {
  readonly type: "add_asset";
  readonly asset: ChannelAwareProposedAssetMarketIdentity;
}

export interface UpdateAssetIdentityOperationV1 {
  readonly type: "update_asset_identity";
  readonly asset: ProposedAssetMarketIdentity;
  readonly expectedCurrent: AssetRegistrationExpectedCurrentV1;
}

export interface UpdateAssetIdentityOperationV2 {
  readonly type: "update_asset_identity";
  readonly asset: ChannelAwareProposedAssetMarketIdentity;
  readonly expectedCurrent: AssetRegistrationExpectedCurrentV2;
}

export interface InsertPackAssetOperation {
  readonly type: "insert_pack_asset";
  readonly packId: string;
  readonly assetId: string;
  readonly placement: AssetPackPlacement;
  readonly resultingIndex: number;
}

export type AssetRegistrationApplicationOperationV1 =
  | AddAssetOperationV1
  | UpdateAssetIdentityOperationV1
  | InsertPackAssetOperation;

export type AssetRegistrationApplicationOperationV2 =
  | AddAssetOperationV2
  | UpdateAssetIdentityOperationV2
  | InsertPackAssetOperation;

export type AssetRegistrationApplicationOperation =
  | AssetRegistrationApplicationOperationV1
  | AssetRegistrationApplicationOperationV2;

export interface SimulatedPackResult {
  readonly packId: string;
  readonly assetCountBefore: number;
  readonly assetCountAfter: number;
  readonly fingerprintBefore: string;
  readonly fingerprintAfter: string;
  readonly insertedAssetId: string;
  readonly resultingIndex: number;
  readonly existingRelativeOrderPreserved: true;
}

interface AssetRegistrationApplicationPlanCommon {
  readonly planType: "visionx.asset-registration.application-plan";
  readonly applicationAuthorized: boolean;
  readonly applicationStatus: "planned_not_applied" | "rejected_not_applied";
  readonly authorization: AssetRegistrationApplicationAuthorization;
  readonly simulatedResult: {
    readonly registryAssetCountBefore: number;
    readonly registryAssetCountAfter: number;
    readonly packMembershipCountBefore: number;
    readonly packMembershipCountAfter: number;
    readonly registryFingerprintBefore: string;
    readonly registryFingerprintAfter: string;
    readonly packs: readonly SimulatedPackResult[];
  };
  readonly publicationMetadataPreview: AssetRegistrationProposal["publicationMetadataPreview"];
  readonly sourceChangesApplied: false;
}

export interface AssetRegistrationApplicationPlanV1 extends AssetRegistrationApplicationPlanCommon {
  readonly schemaVersion: 1;
  readonly technicalValidation: {
    readonly ok: true;
    readonly proposalSha256: string;
    readonly authorizationSha256: string;
    readonly registryFingerprintVerified: true;
    readonly staleStateDetected: false;
  };
  readonly proposal: {
    readonly operation: AssetRegistrationOperation;
    readonly assetId: string;
    readonly registryFingerprint: string;
  };
  readonly operations: readonly AssetRegistrationApplicationOperationV1[];
}

export interface AssetRegistrationApplicationPlanV2 extends AssetRegistrationApplicationPlanCommon {
  readonly schemaVersion: 2;
  readonly technicalValidation: {
    readonly ok: true;
    readonly proposalSha256: string;
    readonly authorizationSha256: string;
    readonly registryFingerprintVerified: true;
    readonly channelConfigurationVerified: true;
    readonly staleStateDetected: false;
  };
  readonly proposal: {
    readonly operation: AssetRegistrationOperation;
    readonly assetId: string;
    readonly channel: string;
    readonly registryFingerprint: string;
  };
  readonly operations: readonly AssetRegistrationApplicationOperationV2[];
}

export type AssetRegistrationApplicationPlan =
  | AssetRegistrationApplicationPlanV1
  | AssetRegistrationApplicationPlanV2;

export interface AssetRegistrationApplicationPlanSuccess {
  readonly ok: true;
  readonly plan: AssetRegistrationApplicationPlanV2;
}

export type AssetRegistrationApplicationPlanResult =
  | AssetRegistrationApplicationPlanSuccess
  | AssetRegistrationApplicationPlanFailure;

export interface PlanAssetRegistrationApplicationInput {
  readonly proposal: unknown;
  readonly proposalSha256: string;
  readonly authorization: unknown;
  readonly authorizationSha256: string;
  readonly assets: readonly Asset[];
  readonly packs: readonly Pack[];
  readonly channels: Readonly<Record<string, unknown>>;
}

export type AssetRegistrationApplicationPlanReceiptValidationResult =
  | { readonly ok: true; readonly plan: AssetRegistrationApplicationPlan }
  | AssetRegistrationApplicationPlanFailure;

function failure(
  reason: AssetRegistrationApplicationPlanFailureReason,
  detail: string,
): AssetRegistrationApplicationPlanFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
  reason: "invalid_proposal" | "invalid_plan" = "invalid_proposal",
): AssetRegistrationApplicationPlanFailure | null {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unknown.length > 0) {
    return failure(reason, `${where} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    return failure(reason, `${where} is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  return null;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function computeAssetRegistrationPackFingerprint(pack: Pack): string {
  return hashCanonical({
    id: pack.id,
    display: pack.display,
    channel: pack.channel,
    assets: [...pack.assets],
  });
}

function mapProposalFailure(reason: string): AssetRegistrationApplicationPlanFailureReason {
  if (reason === "unsupported_schema_version") return "unsupported_schema_version";
  if (reason === "proposal_channel_required") return "proposal_channel_required";
  if (reason === "invalid_channel") return "invalid_channel";
  if (reason === "unknown_channel") return "unknown_channel";
  if (reason === "unresolved_channel") return "unresolved_channel";
  return "invalid_proposal";
}

function mapAuthorizationFailure(reason: AssetApplicationAuthorizationFailureReason): AssetRegistrationApplicationPlanFailureReason {
  if (reason === "unsupported_decision") return "unsupported_decision";
  if (reason === "duplicate_pack_placement") return "duplicate_pack_placement";
  if (reason === "invalid_pack_placement") return "invalid_pack_placement";
  return "invalid_authorization";
}

function countMemberships(packs: readonly Pack[]): number {
  return packs.reduce((total, pack) => total + pack.assets.length, 0);
}

function freezePlacement(placement: AssetPackPlacement): AssetPackPlacement {
  return placement.mode === "append"
    ? Object.freeze({ mode: "append" })
    : Object.freeze({ mode: placement.mode, anchorAssetId: placement.anchorAssetId });
}

function canonicalAuthorizationSha256(authorization: AssetRegistrationApplicationAuthorization): string {
  return createHash("sha256").update(serializeAssetRegistrationApplicationAuthorization(authorization)).digest("hex");
}

function freezeOperationV2(operation: AssetRegistrationApplicationOperationV2): AssetRegistrationApplicationOperationV2 {
  if (operation.type === "add_asset") {
    return Object.freeze({ type: operation.type, asset: Object.freeze({ ...operation.asset }) });
  }
  if (operation.type === "update_asset_identity") {
    return Object.freeze({
      type: operation.type,
      asset: Object.freeze({ ...operation.asset }),
      expectedCurrent: Object.freeze({ ...operation.expectedCurrent }),
    });
  }
  return Object.freeze({
    type: operation.type,
    packId: operation.packId,
    assetId: operation.assetId,
    placement: freezePlacement(operation.placement),
    resultingIndex: operation.resultingIndex,
  });
}

function freezePlanV2(plan: AssetRegistrationApplicationPlanV2): AssetRegistrationApplicationPlanV2 {
  return Object.freeze({
    ...plan,
    technicalValidation: Object.freeze({ ...plan.technicalValidation }),
    proposal: Object.freeze({ ...plan.proposal }),
    authorization: Object.freeze({
      ...plan.authorization,
      packPlacements: Object.freeze(plan.authorization.packPlacements.map((entry) => Object.freeze({
        packId: entry.packId,
        placement: freezePlacement(entry.placement),
      }))),
    }),
    operations: Object.freeze(plan.operations.map(freezeOperationV2)),
    simulatedResult: Object.freeze({
      ...plan.simulatedResult,
      packs: Object.freeze(plan.simulatedResult.packs.map((pack) => Object.freeze({ ...pack }))),
    }),
    publicationMetadataPreview: Object.freeze({ ...plan.publicationMetadataPreview }),
  });
}

function placementIndex(pack: Pack, placement: AssetPackPlacement): number | AssetRegistrationApplicationPlanFailure {
  if (placement.mode === "append") return pack.assets.length;
  const anchorIndex = pack.assets.indexOf(placement.anchorAssetId);
  if (anchorIndex < 0) {
    return failure("unknown_pack_anchor", `Asset ${placement.anchorAssetId} is not a member of Pack ${pack.id}`);
  }
  return placement.mode === "before" ? anchorIndex : anchorIndex + 1;
}

function proposedAssetAsRegistryAsset(
  proposed: ChannelAwareProposedAssetMarketIdentity,
  existing?: Asset,
): Asset {
  return Object.freeze({
    id: proposed.id,
    tradingView: proposed.tradingViewSymbol,
    display: proposed.displayName,
    channel: proposed.channel,
    ...(existing?.tradingViewAliases === undefined
      ? {}
      : { tradingViewAliases: Object.freeze([...existing.tradingViewAliases]) }),
  });
}

function simulatePacks(
  packs: readonly Pack[],
  placements: readonly { readonly pack: Pack; readonly index: number }[],
  assetId: string,
  approved: boolean,
): readonly Pack[] {
  if (!approved) return packs;
  const byId = new Map(placements.map((placement) => [placement.pack.id, placement.index] as const));
  return Object.freeze(packs.map((pack) => {
    const index = byId.get(pack.id);
    if (index === undefined) return pack;
    const assets = [...pack.assets];
    assets.splice(index, 0, assetId);
    return Object.freeze({ ...pack, assets: Object.freeze(assets) });
  }));
}

export function planAssetRegistrationApplication(
  input: PlanAssetRegistrationApplicationInput,
): AssetRegistrationApplicationPlanResult {
  if (!LOWER_SHA256.test(input.proposalSha256) || !LOWER_SHA256.test(input.authorizationSha256)) {
    return failure("invalid_proposal", "input artifact hashes must be lowercase SHA-256 digests");
  }
  const proposalResult = validateAssetRegistrationProposalReceipt(input.proposal, input.channels);
  if (!proposalResult.ok) return failure(mapProposalFailure(proposalResult.reason), proposalResult.detail);
  const canonicalProposalSha256 = createHash("sha256")
    .update(serializeAssetRegistrationProposal(proposalResult.proposal))
    .digest("hex");
  if (canonicalProposalSha256 !== input.proposalSha256) {
    return failure("proposal_hash_mismatch", "supplied proposal bytes do not match the validated deterministic proposal receipt");
  }
  if (proposalResult.proposal.schemaVersion === 1) {
    return failure("legacy_proposal_not_applicable", "schemaVersion 1 proposals are historical and cannot produce a source-applicable plan");
  }
  const proposal = proposalResult.proposal;
  const channel = validateAssetRegistrationChannel(proposal.asset.channel, input.channels);
  if (!channel.ok) return channel;

  const authorizationResult = validateAssetRegistrationApplicationAuthorization(input.authorization);
  if (!authorizationResult.ok) {
    return failure(mapAuthorizationFailure(authorizationResult.reason), authorizationResult.detail);
  }
  const authorization = authorizationResult.authorization;
  if (canonicalAuthorizationSha256(authorization) !== input.authorizationSha256) {
    return failure("invalid_authorization", "supplied authorization bytes do not match the validated deterministic authorization receipt");
  }
  if (authorization.proposalSha256 !== input.proposalSha256) {
    return failure("proposal_hash_mismatch", "authorization.proposalSha256 does not match the supplied proposal bytes");
  }

  const currentRegistryFingerprint = computeAssetRegistrationRegistryFingerprint(input.assets, input.packs);
  if (proposal.registryState.registryFingerprint !== currentRegistryFingerprint || proposal.registryState.assetCount !== input.assets.length) {
    return failure("stale_registry_state", "proposal Registry state no longer matches the canonical Registry and Packs");
  }

  const currentAsset = input.assets.find((asset) => asset.id === proposal.asset.id);
  if (proposal.operation === "add") {
    if (currentAsset !== undefined) return failure("asset_already_exists", `Asset ${proposal.asset.id} already exists`);
  } else {
    if (currentAsset === undefined) return failure("unknown_asset", `Asset ${proposal.asset.id} is no longer registered`);
    const expected = proposal.expectedCurrent;
    if (
      expected === undefined ||
      currentAsset.display !== expected.display ||
      currentAsset.tradingView !== expected.tradingView ||
      currentAsset.channel !== expected.channel
    ) {
      return failure("stale_asset_state", `Asset ${proposal.asset.id} no longer matches proposal.expectedCurrent`);
    }
    if (proposal.asset.channel !== currentAsset.channel) {
      return failure("channel_change_not_authorized", "update_identity cannot change an Asset logical channel");
    }
  }

  const packById = new Map(input.packs.map((pack, index) => [pack.id, { pack, index }] as const));
  const proposalTargets = proposal.targetPacks.map((target) => target.packId);
  const proposalTargetSet = new Set(proposalTargets);
  const expectedTargetOrder = proposalTargets
    .map((packId) => packById.get(packId))
    .filter((entry): entry is { readonly pack: Pack; readonly index: number } => entry !== undefined)
    .sort((a, b) => a.index - b.index || a.pack.id.localeCompare(b.pack.id, "en"))
    .map((entry) => entry.pack.id);
  for (const packId of proposalTargets) {
    if (!packById.has(packId)) return failure("unknown_target_pack", `Pack ${packId} no longer exists`);
  }
  if (JSON.stringify(proposalTargets) !== JSON.stringify(expectedTargetOrder)) {
    return failure("stale_registry_state", "proposal target Pack order no longer matches canonical Pack order");
  }
  if (proposal.operation === "update_identity" && (proposalTargets.length > 0 || authorization.packPlacements.length > 0)) {
    return failure("unexpected_pack_placement", "update_identity cannot add or reorder Pack membership");
  }

  const authorizationByPack = new Map<string, AssetApplicationPackPlacement>();
  for (const placement of authorization.packPlacements) {
    if (!proposalTargetSet.has(placement.packId)) {
      return failure("unexpected_pack_placement", `authorization includes Pack ${placement.packId}, which is not targeted by the proposal`);
    }
    authorizationByPack.set(placement.packId, placement);
  }
  if (proposal.operation === "add") {
    for (const packId of proposalTargets) {
      if (!authorizationByPack.has(packId)) {
        return failure("missing_pack_placement", `authorization must explicitly place Asset ${proposal.asset.id} in Pack ${packId}`);
      }
    }
    if (authorization.packPlacements.length !== proposalTargets.length) {
      return failure("unexpected_pack_placement", "authorization Pack placements must exactly match proposal target Packs");
    }
  }

  const canonicalPlacements: Array<{ readonly pack: Pack; readonly index: number; readonly placement: AssetPackPlacement }> = [];
  for (const packId of proposalTargets) {
    const found = packById.get(packId);
    if (found === undefined) return failure("unknown_target_pack", `Pack ${packId} no longer exists`);
    if (found.pack.assets.includes(proposal.asset.id)) {
      return failure("pack_membership_already_exists", `Pack ${packId} already contains Asset ${proposal.asset.id}`);
    }
    const authorized = authorizationByPack.get(packId);
    if (authorized === undefined) return failure("missing_pack_placement", `authorization is missing Pack ${packId}`);
    if (authorized.placement.mode !== "append" && authorized.placement.anchorAssetId === proposal.asset.id) {
      return failure("invalid_pack_placement", "Pack placement anchor cannot equal the proposed Asset id");
    }
    const index = placementIndex(found.pack, authorized.placement);
    if (typeof index !== "number") return index;
    canonicalPlacements.push({ pack: found.pack, index, placement: authorized.placement });
  }

  const canonicalAuthorizationPlacements: AssetApplicationPackPlacement[] = [];
  for (const packId of proposalTargets) {
    const placement = authorizationByPack.get(packId);
    if (placement === undefined) return failure("missing_pack_placement", `authorization is missing validated Pack ${packId}`);
    canonicalAuthorizationPlacements.push(Object.freeze({
      packId,
      placement: freezePlacement(placement.placement),
    }));
  }
  const canonicalAuthorization = Object.freeze({
    ...authorization,
    packPlacements: Object.freeze(canonicalAuthorizationPlacements),
  });

  const approved = canonicalAuthorization.decision === "approved";
  const operations: AssetRegistrationApplicationOperationV2[] = [];
  const simulatedPacks: SimulatedPackResult[] = [];
  if (approved) {
    if (proposal.operation === "add") {
      operations.push(Object.freeze({ type: "add_asset", asset: proposal.asset }));
    } else {
      const expected = proposal.expectedCurrent;
      if (expected === undefined) return failure("invalid_proposal", "update_identity proposal lacks expectedCurrent");
      operations.push(Object.freeze({ type: "update_asset_identity", asset: proposal.asset, expectedCurrent: expected }));
    }
    for (const placement of canonicalPlacements) {
      const afterAssets = [...placement.pack.assets];
      afterAssets.splice(placement.index, 0, proposal.asset.id);
      const afterPack: Pack = Object.freeze({ ...placement.pack, assets: Object.freeze(afterAssets) });
      operations.push(Object.freeze({
        type: "insert_pack_asset",
        packId: placement.pack.id,
        assetId: proposal.asset.id,
        placement: freezePlacement(placement.placement),
        resultingIndex: placement.index,
      }));
      simulatedPacks.push(Object.freeze({
        packId: placement.pack.id,
        assetCountBefore: placement.pack.assets.length,
        assetCountAfter: afterAssets.length,
        fingerprintBefore: computeAssetRegistrationPackFingerprint(placement.pack),
        fingerprintAfter: computeAssetRegistrationPackFingerprint(afterPack),
        insertedAssetId: proposal.asset.id,
        resultingIndex: placement.index,
        existingRelativeOrderPreserved: true,
      }));
    }
  }

  const registryCountBefore = input.assets.length;
  const membershipCountBefore = countMemberships(input.packs);
  const registryCountAfter = approved && proposal.operation === "add" ? registryCountBefore + 1 : registryCountBefore;
  const membershipCountAfter = approved ? membershipCountBefore + canonicalPlacements.length : membershipCountBefore;
  const futurePacks = simulatePacks(input.packs, canonicalPlacements, proposal.asset.id, approved);
  let futureAssets: readonly Asset[] = input.assets;
  if (approved && proposal.operation === "add") {
    futureAssets = Object.freeze([...input.assets, proposedAssetAsRegistryAsset(proposal.asset)]);
  } else if (approved && proposal.operation === "update_identity") {
    futureAssets = Object.freeze(input.assets.map((asset) =>
      asset.id === proposal.asset.id
        ? proposedAssetAsRegistryAsset(proposal.asset, asset)
        : asset));
  }
  const registryFingerprintAfter = approved
    ? computeAssetRegistrationRegistryFingerprint(futureAssets, futurePacks)
    : currentRegistryFingerprint;

  const plan = freezePlanV2({
    schemaVersion: 2,
    planType: "visionx.asset-registration.application-plan",
    applicationAuthorized: approved,
    applicationStatus: approved ? "planned_not_applied" : "rejected_not_applied",
    technicalValidation: Object.freeze({
      ok: true,
      proposalSha256: input.proposalSha256,
      authorizationSha256: canonicalAuthorizationSha256(canonicalAuthorization),
      registryFingerprintVerified: true,
      channelConfigurationVerified: true,
      staleStateDetected: false,
    }),
    proposal: Object.freeze({
      operation: proposal.operation,
      assetId: proposal.asset.id,
      channel: proposal.asset.channel,
      registryFingerprint: proposal.registryState.registryFingerprint,
    }),
    authorization: canonicalAuthorization,
    operations: Object.freeze(operations),
    simulatedResult: Object.freeze({
      registryAssetCountBefore: registryCountBefore,
      registryAssetCountAfter: registryCountAfter,
      packMembershipCountBefore: membershipCountBefore,
      packMembershipCountAfter: membershipCountAfter,
      registryFingerprintBefore: currentRegistryFingerprint,
      registryFingerprintAfter,
      packs: Object.freeze(simulatedPacks),
    }),
    publicationMetadataPreview: proposal.publicationMetadataPreview,
    sourceChangesApplied: false,
  });
  return Object.freeze({ ok: true, plan });
}

function validateBasicPlanCommon(
  value: Readonly<Record<string, unknown>>,
  version: 1 | 2,
): AssetRegistrationApplicationPlanFailure | null {
  const top = exactFields(
    value,
    ["schemaVersion", "planType", "applicationAuthorized", "applicationStatus", "technicalValidation", "proposal", "authorization", "operations", "simulatedResult", "publicationMetadataPreview", "sourceChangesApplied"],
    "plan",
    "invalid_plan",
  );
  if (top !== null) return top;
  if (value.schemaVersion !== version || value.planType !== "visionx.asset-registration.application-plan") {
    return failure("invalid_plan", "plan identity or schemaVersion is unsupported");
  }
  if (typeof value.applicationAuthorized !== "boolean") return failure("invalid_plan", "plan.applicationAuthorized must be boolean");
  const expectedStatus = value.applicationAuthorized ? "planned_not_applied" : "rejected_not_applied";
  if (value.applicationStatus !== expectedStatus || value.sourceChangesApplied !== false) {
    return failure("invalid_plan", "plan status or sourceChangesApplied is inconsistent");
  }
  return null;
}

function validatePlanPreview(value: unknown): AssetRegistrationApplicationPlanFailure | null {
  if (!isRecord(value)) return failure("invalid_plan", "plan.publicationMetadataPreview must be a JSON object");
  return exactFields(value, ["title", "symbol", "market", "currency"], "plan.publicationMetadataPreview", "invalid_plan");
}

export function validateAssetRegistrationApplicationPlanReceipt(
  value: unknown,
  channels: Readonly<Record<string, unknown>>,
): AssetRegistrationApplicationPlanReceiptValidationResult {
  if (!isRecord(value)) return failure("invalid_plan", "plan must be a JSON object");
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    return failure("unsupported_schema_version", "plan.schemaVersion must equal 1 or 2");
  }
  const version = value.schemaVersion;
  const common = validateBasicPlanCommon(value, version);
  if (common !== null) return common;
  const preview = validatePlanPreview(value.publicationMetadataPreview);
  if (preview !== null) return preview;
  if (!isRecord(value.proposal)) return failure("invalid_plan", "plan.proposal must be a JSON object");
  const proposalFields = exactFields(
    value.proposal,
    version === 1
      ? ["operation", "assetId", "registryFingerprint"]
      : ["operation", "assetId", "channel", "registryFingerprint"],
    "plan.proposal",
    "invalid_plan",
  );
  if (proposalFields !== null) return proposalFields;
  if (value.proposal.operation !== "add" && value.proposal.operation !== "update_identity") {
    return failure("invalid_plan", "plan.proposal.operation is invalid");
  }
  if (typeof value.proposal.assetId !== "string" || typeof value.proposal.registryFingerprint !== "string" || !LOWER_SHA256.test(value.proposal.registryFingerprint)) {
    return failure("invalid_plan", "plan.proposal identity is invalid");
  }
  if (!Array.isArray(value.operations)) return failure("invalid_plan", "plan.operations must be an array");
  const authorization = validateAssetRegistrationApplicationAuthorization(value.authorization);
  if (!authorization.ok) return failure("invalid_plan", `plan.authorization is invalid: ${authorization.detail}`);
  if (version === 2) {
    const channel = validateAssetRegistrationChannel(value.proposal.channel, channels);
    if (!channel.ok) return channel;
    for (let index = 0; index < value.operations.length; index += 1) {
      const operation = value.operations[index];
      if (!isRecord(operation)) return failure("invalid_plan", `plan.operations[${index}] must be a JSON object`);
      if (operation.type === "add_asset" || operation.type === "update_asset_identity") {
        if (!isRecord(operation.asset) || operation.asset.channel !== channel.channel) {
          return failure("invalid_plan", `plan.operations[${index}].asset.channel must match plan.proposal.channel`);
        }
      }
    }
  }
  if (!value.applicationAuthorized && value.operations.length !== 0) {
    return failure("invalid_plan", "rejected plans must contain no operations");
  }
  if (!isRecord(value.technicalValidation) || !isRecord(value.simulatedResult)) {
    return failure("invalid_plan", "plan technicalValidation and simulatedResult must be objects");
  }
  const technicalFields = exactFields(
    value.technicalValidation,
    version === 1
      ? ["ok", "proposalSha256", "authorizationSha256", "registryFingerprintVerified", "staleStateDetected"]
      : ["ok", "proposalSha256", "authorizationSha256", "registryFingerprintVerified", "channelConfigurationVerified", "staleStateDetected"],
    "plan.technicalValidation",
    "invalid_plan",
  );
  if (technicalFields !== null) return technicalFields;
  if (
    value.technicalValidation.ok !== true ||
    value.technicalValidation.registryFingerprintVerified !== true ||
    value.technicalValidation.staleStateDetected !== false ||
    (version === 2 && value.technicalValidation.channelConfigurationVerified !== true)
  ) {
    return failure("invalid_plan", "plan.technicalValidation is inconsistent");
  }
  const simulatedFields = exactFields(
    value.simulatedResult,
    ["registryAssetCountBefore", "registryAssetCountAfter", "packMembershipCountBefore", "packMembershipCountAfter", "registryFingerprintBefore", "registryFingerprintAfter", "packs"],
    "plan.simulatedResult",
    "invalid_plan",
  );
  if (simulatedFields !== null) return simulatedFields;
  return Object.freeze({ ok: true, plan: value as unknown as AssetRegistrationApplicationPlan });
}

export function serializeAssetRegistrationApplicationPlan(
  plan: AssetRegistrationApplicationPlan,
): Buffer {
  return Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

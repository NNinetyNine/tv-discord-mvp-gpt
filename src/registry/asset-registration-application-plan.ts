import { createHash } from "node:crypto";

import type { Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import { previewChartPublicationMetadataForProposedAsset } from "../application/chart-publication-metadata-preview.ts";
import {
  computeAssetRegistrationRegistryFingerprint,
  validateAssetRegistrationInput,
  type AssetRegistrationExpectedCurrent,
  type AssetRegistrationOperation,
  type AssetRegistrationProposal,
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

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;

export type AssetRegistrationApplicationPlanFailureReason =
  | "invalid_proposal"
  | "invalid_authorization"
  | "proposal_hash_mismatch"
  | "unsupported_decision"
  | "stale_registry_state"
  | "asset_already_exists"
  | "unknown_asset"
  | "stale_asset_state"
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

export interface AddAssetOperation {
  readonly type: "add_asset";
  readonly asset: ProposedAssetMarketIdentity;
}

export interface UpdateAssetIdentityOperation {
  readonly type: "update_asset_identity";
  readonly asset: ProposedAssetMarketIdentity;
  readonly expectedCurrent: AssetRegistrationExpectedCurrent;
}

export interface InsertPackAssetOperation {
  readonly type: "insert_pack_asset";
  readonly packId: string;
  readonly assetId: string;
  readonly placement: AssetPackPlacement;
  readonly resultingIndex: number;
}

export type AssetRegistrationApplicationOperation =
  | AddAssetOperation
  | UpdateAssetIdentityOperation
  | InsertPackAssetOperation;

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

export interface AssetRegistrationApplicationPlan {
  readonly schemaVersion: 1;
  readonly planType: "visionx.asset-registration.application-plan";
  readonly applicationAuthorized: boolean;
  readonly applicationStatus: "planned_not_applied" | "rejected_not_applied";
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
  readonly authorization: AssetRegistrationApplicationAuthorization;
  readonly operations: readonly AssetRegistrationApplicationOperation[];
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

export interface AssetRegistrationApplicationPlanSuccess {
  readonly ok: true;
  readonly plan: AssetRegistrationApplicationPlan;
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
}

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
): AssetRegistrationApplicationPlanFailure | null {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unknown.length > 0) {
    return failure("invalid_proposal", `${where} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    return failure("invalid_proposal", `${where} is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
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

function computePlannedRegistryFingerprint(
  currentRegistryFingerprint: string,
  operations: readonly AssetRegistrationApplicationOperation[],
): string {
  return hashCanonical({
    schemaVersion: 1,
    currentRegistryFingerprint,
    operations,
  });
}

function validateProposalReceipt(value: unknown):
  | { readonly ok: true; readonly proposal: AssetRegistrationProposal }
  | AssetRegistrationApplicationPlanFailure {
  if (!isRecord(value)) return failure("invalid_proposal", "proposal must be a JSON object");
  const operation = value.operation;
  if (operation !== "add" && operation !== "update_identity") {
    return failure("invalid_proposal", "proposal.operation must be add or update_identity");
  }
  const topFields = operation === "update_identity"
    ? ["schemaVersion", "proposalType", "operation", "valid", "registryState", "asset", "targetPacks", "publicationMetadataPreview", "decision", "expectedCurrent", "applicationStatus"]
    : ["schemaVersion", "proposalType", "operation", "valid", "registryState", "asset", "targetPacks", "publicationMetadataPreview", "decision", "applicationStatus"];
  const top = exactFields(value, topFields, "proposal");
  if (top !== null) return top;
  if (value.schemaVersion !== 1 || value.proposalType !== "visionx.asset-registration" || value.valid !== true || value.applicationStatus !== "not_applied") {
    return failure("invalid_proposal", "proposal identity, validity, or applicationStatus is unsupported");
  }
  if (!isRecord(value.registryState)) return failure("invalid_proposal", "proposal.registryState must be a JSON object");
  const registryFields = exactFields(value.registryState, ["assetCount", "registryFingerprint"], "proposal.registryState");
  if (registryFields !== null) return registryFields;
  if (!Number.isSafeInteger(value.registryState.assetCount) || Number(value.registryState.assetCount) < 0) {
    return failure("invalid_proposal", "proposal.registryState.assetCount must be a non-negative safe integer");
  }
  if (typeof value.registryState.registryFingerprint !== "string" || !LOWER_SHA256.test(value.registryState.registryFingerprint)) {
    return failure("invalid_proposal", "proposal.registryState.registryFingerprint must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(value.targetPacks)) return failure("invalid_proposal", "proposal.targetPacks must be an array");
  const targetPackIds: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.targetPacks.length; index += 1) {
    const target = value.targetPacks[index];
    if (!isRecord(target)) return failure("invalid_proposal", `proposal.targetPacks[${index}] must be a JSON object`);
    const fields = exactFields(target, ["packId", "membershipAlreadyExists"], `proposal.targetPacks[${index}]`);
    if (fields !== null) return fields;
    if (typeof target.packId !== "string" || target.packId.length === 0 || target.packId.trim() !== target.packId) {
      return failure("invalid_proposal", `proposal.targetPacks[${index}].packId must be an exact non-empty string`);
    }
    if (target.membershipAlreadyExists !== false) {
      return failure("invalid_proposal", `proposal.targetPacks[${index}].membershipAlreadyExists must equal false`);
    }
    if (seen.has(target.packId)) return failure("invalid_proposal", `proposal target Pack ${target.packId} is duplicated`);
    seen.add(target.packId);
    targetPackIds.push(target.packId);
  }

  const reconstructed = validateAssetRegistrationInput({
    schemaVersion: 1,
    operation,
    asset: value.asset,
    targetPackIds,
    decision: value.decision,
    ...(operation === "update_identity" ? { expectedCurrent: value.expectedCurrent } : {}),
  });
  if (!reconstructed.ok) {
    return failure("invalid_proposal", `proposal content is invalid: ${reconstructed.reason}: ${reconstructed.detail}`);
  }
  if (!isRecord(value.publicationMetadataPreview)) {
    return failure("invalid_proposal", "proposal.publicationMetadataPreview must be a JSON object");
  }
  const previewFields = exactFields(value.publicationMetadataPreview, ["title", "symbol", "market", "currency"], "proposal.publicationMetadataPreview");
  if (previewFields !== null) return previewFields;
  const expectedPreview = previewChartPublicationMetadataForProposedAsset(reconstructed.input.asset);
  if (JSON.stringify(value.publicationMetadataPreview) !== JSON.stringify(expectedPreview)) {
    return failure("invalid_proposal", "proposal.publicationMetadataPreview does not match the proposed Asset identity");
  }

  const proposal: AssetRegistrationProposal = Object.freeze({
    schemaVersion: 1,
    proposalType: "visionx.asset-registration",
    operation,
    valid: true,
    registryState: Object.freeze({
      assetCount: Number(value.registryState.assetCount),
      registryFingerprint: value.registryState.registryFingerprint,
    }),
    asset: reconstructed.input.asset,
    targetPacks: Object.freeze(targetPackIds.map((packId) => Object.freeze({ packId, membershipAlreadyExists: false as const }))),
    publicationMetadataPreview: expectedPreview,
    decision: reconstructed.input.decision,
    ...(reconstructed.input.expectedCurrent === undefined ? {} : { expectedCurrent: reconstructed.input.expectedCurrent }),
    applicationStatus: "not_applied",
  });
  return Object.freeze({ ok: true, proposal });
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

function freezeOperation(operation: AssetRegistrationApplicationOperation): AssetRegistrationApplicationOperation {
  if (operation.type === "add_asset") return Object.freeze({ type: operation.type, asset: Object.freeze({ ...operation.asset }) });
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

function freezePlan(plan: AssetRegistrationApplicationPlan): AssetRegistrationApplicationPlan {
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
    operations: Object.freeze(plan.operations.map(freezeOperation)),
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

export function planAssetRegistrationApplication(
  input: PlanAssetRegistrationApplicationInput,
): AssetRegistrationApplicationPlanResult {
  if (!LOWER_SHA256.test(input.proposalSha256) || !LOWER_SHA256.test(input.authorizationSha256)) {
    return failure("invalid_proposal", "input artifact hashes must be lowercase SHA-256 digests");
  }
  const proposalResult = validateProposalReceipt(input.proposal);
  if (!proposalResult.ok) return proposalResult;
  const proposal = proposalResult.proposal;
  const authorizationResult = validateAssetRegistrationApplicationAuthorization(input.authorization);
  if (!authorizationResult.ok) {
    return failure(mapAuthorizationFailure(authorizationResult.reason), authorizationResult.detail);
  }
  const authorization = authorizationResult.authorization;
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
    if (expected === undefined || currentAsset.display !== expected.display || currentAsset.tradingView !== expected.tradingView) {
      return failure("stale_asset_state", `Asset ${proposal.asset.id} no longer matches proposal.expectedCurrent`);
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

  if (proposal.operation === "update_identity") {
    if (proposalTargets.length > 0 || authorization.packPlacements.length > 0) {
      return failure("unexpected_pack_placement", "update_identity cannot add or reorder Pack membership");
    }
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
    if (placement === undefined) {
      return failure("missing_pack_placement", `authorization is missing validated Pack ${packId}`);
    }
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
  const operations: AssetRegistrationApplicationOperation[] = [];
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
  const registryFingerprintAfter = approved
    ? computePlannedRegistryFingerprint(currentRegistryFingerprint, operations)
    : currentRegistryFingerprint;

  const plan = freezePlan({
    schemaVersion: 1,
    planType: "visionx.asset-registration.application-plan",
    applicationAuthorized: approved,
    applicationStatus: approved ? "planned_not_applied" : "rejected_not_applied",
    technicalValidation: Object.freeze({
      ok: true,
      proposalSha256: input.proposalSha256,
      authorizationSha256: canonicalAuthorizationSha256(canonicalAuthorization),
      registryFingerprintVerified: true,
      staleStateDetected: false,
    }),
    proposal: Object.freeze({
      operation: proposal.operation,
      assetId: proposal.asset.id,
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

export function serializeAssetRegistrationApplicationPlan(
  plan: AssetRegistrationApplicationPlan,
): Buffer {
  return Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

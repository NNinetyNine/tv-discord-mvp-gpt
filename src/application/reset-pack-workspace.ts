import type { Workspace, PackState } from "../packs/workspace.ts";
import type { StagingStore } from "../wiring/staging.ts";

export interface ResetPackWorkspaceDependencies {
  readonly workspace: Workspace;
  readonly staging: StagingStore;
}

export type ResetPackWorkspaceResult =
  | {
      readonly ok: true;
      readonly outcome: "asset_reset" | "pack_reset";
      readonly packId: string;
      readonly resetAssetIds: readonly string[];
      readonly packState: PackState;
      readonly capturedCount: number;
      readonly totalCount: number;
      readonly remainingRequiredAssetIds: readonly string[];
      readonly stagedArtifactCount: number;
      readonly stagingCleared: boolean;
    }
  | {
      readonly ok: false;
      readonly outcome: "invalid_scope" | "analysis_not_found" | "state_conflict";
      readonly packId: string;
      readonly assetId?: string;
      readonly detail: string;
    };

function progress(
  packId: string,
  resetAssetIds: readonly string[],
  outcome: "asset_reset" | "pack_reset",
  stagedArtifactCount: number,
  stagingCleared: boolean,
  workspace: Workspace,
): ResetPackWorkspaceResult {
  const pack = workspace.pack(packId);
  if (pack === null) throw new Error(`Pack ${packId} disappeared during reset`);
  const remainingRequiredAssetIds = Object.freeze([...workspace.pendingAssets(packId)]);
  return Object.freeze({
    ok: true,
    outcome,
    packId,
    resetAssetIds: Object.freeze([...resetAssetIds]),
    packState: workspace.packState(packId),
    capturedCount: pack.assets.length - remainingRequiredAssetIds.length,
    totalCount: pack.assets.length,
    remainingRequiredAssetIds,
    stagedArtifactCount,
    stagingCleared,
  });
}

export function resetPackWorkspaceAsset(
  options: {
    readonly packId: string;
    readonly assetId: string;
    readonly expectedRevisions: number;
  },
  dependencies: ResetPackWorkspaceDependencies,
): ResetPackWorkspaceResult {
  const pack = dependencies.workspace.pack(options.packId);
  if (pack === null || !pack.assets.includes(options.assetId)) {
    return Object.freeze({
      ok: false,
      outcome: "invalid_scope",
      packId: options.packId,
      assetId: options.assetId,
      detail: `Asset ${options.assetId} is not a member of Pack ${options.packId}.`,
    });
  }
  const capture = dependencies.workspace.captureOf(options.assetId);
  if (capture === null) {
    return Object.freeze({
      ok: false,
      outcome: "analysis_not_found",
      packId: options.packId,
      assetId: options.assetId,
      detail: `Asset ${options.assetId} has no current Analysis to reset.`,
    });
  }
  if (capture.revisions !== options.expectedRevisions) {
    return Object.freeze({
      ok: false,
      outcome: "state_conflict",
      packId: options.packId,
      assetId: options.assetId,
      detail: `Asset ${options.assetId} changed after reset confirmation.`,
    });
  }

  const stagedArtifactCount = dependencies.staging.has(options.assetId) ? 1 : 0;
  if (!dependencies.workspace.resetAsset(options.assetId)) {
    throw new Error(`Asset ${options.assetId} disappeared during reset`);
  }
  let stagingCleared = true;
  try {
    if (stagedArtifactCount === 1) stagingCleared = dependencies.staging.unstage(options.assetId);
  } catch {
    stagingCleared = false;
  }
  return progress(
    options.packId,
    [options.assetId],
    "asset_reset",
    stagedArtifactCount,
    stagingCleared,
    dependencies.workspace,
  );
}

export function resetPackWorkspacePack(
  options: {
    readonly packId: string;
    readonly expectedCapturedAssetIds: readonly string[];
  },
  dependencies: ResetPackWorkspaceDependencies,
): ResetPackWorkspaceResult {
  const pack = dependencies.workspace.pack(options.packId);
  if (pack === null) {
    return Object.freeze({
      ok: false,
      outcome: "invalid_scope",
      packId: options.packId,
      detail: `Pack ${options.packId} was not found.`,
    });
  }
  const capturedAssetIds = dependencies.workspace.capturedFor(options.packId).map((capture) => capture.assetId);
  if (capturedAssetIds.length === 0) {
    return Object.freeze({
      ok: false,
      outcome: "analysis_not_found",
      packId: options.packId,
      detail: `Pack ${options.packId} has no current Analyses to reset.`,
    });
  }
  if (
    capturedAssetIds.length !== options.expectedCapturedAssetIds.length ||
    capturedAssetIds.some((assetId, index) => assetId !== options.expectedCapturedAssetIds[index])
  ) {
    return Object.freeze({
      ok: false,
      outcome: "state_conflict",
      packId: options.packId,
      detail: `Pack ${options.packId} changed after reset confirmation.`,
    });
  }

  const stagedArtifactCount = pack.assets.reduce(
    (count, assetId) => count + (dependencies.staging.has(assetId) ? 1 : 0),
    0,
  );
  dependencies.workspace.resetPack(options.packId);
  let stagingCleared = true;
  try {
    dependencies.staging.clear(pack.assets);
    stagingCleared = pack.assets.every((assetId) => !dependencies.staging.has(assetId));
  } catch { stagingCleared = false; }
  return progress(
    options.packId,
    capturedAssetIds,
    "pack_reset",
    stagedArtifactCount,
    stagingCleared,
    dependencies.workspace,
  );
}

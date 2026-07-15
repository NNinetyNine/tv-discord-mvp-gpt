import { basename } from "node:path";

import type { Registry } from "../registry/registry.ts";
import type { Resolver } from "../resolver/index.ts";
import type { Workspace, PackState } from "../packs/workspace.ts";
import type { StagingStore } from "../wiring/staging.ts";
import type { ValidationResult } from "../types.ts";
import { createFileSnapshotSource } from "../snapshot/sources/file-source.ts";
import { captureOnce, type CaptureAttemptResult } from "../wiring/capture-once.ts";

/** A delivery-neutral reference to one registry-owned Asset. */
export interface ImportReceiptAsset {
  readonly id: string;
  readonly display: string;
}

/** The accepted Asset currently belongs to no Pack. */
export interface HeldImportPlacement {
  readonly kind: "held";
}

/** Facts derived from the accepted Asset's one containing Pack. */
export interface PackImportPlacement {
  readonly kind: "pack";
  readonly packId: string;
  readonly packDisplay: string;
  readonly packState: PackState;
  readonly capturedCount: number;
  readonly totalCount: number;
  /** Pending members in canonical Pack order. */
  readonly remainingRequiredAssets: readonly ImportReceiptAsset[];
}

export type ImportPlacement = HeldImportPlacement | PackImportPlacement;

/**
 * Application-owned receipt for importing one operator-supplied file.
 *
 * This is an immutable, unpersisted factual result — not a domain entity, UI
 * view model, readiness model, or source of truth. Every field is derived from
 * the existing Resolver, Registry, Workspace, and Pack definitions after the
 * canonical captureOnce orchestration has completed.
 */
export type CaptureFromFileReceipt =
  | {
      readonly ok: true;
      readonly outcome: "staged";
      readonly originalBasename: string;
      readonly assetId: string;
      readonly assetDisplay: string;
      /** Revision count after this import; replacement is revisions > 1. */
      readonly revisions: number;
      readonly placement: ImportPlacement;
    }
  | {
      readonly ok: false;
      readonly outcome: "capture_failed";
      readonly originalBasename: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "unparseable_filename";
      readonly originalBasename: string;
      readonly filename: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "unknown_symbol";
      readonly originalBasename: string;
      readonly symbol: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "validation_failed";
      readonly originalBasename: string;
      readonly assetId: string;
      readonly assetDisplay: string;
      readonly reason: string;
      readonly checks: Readonly<Record<string, boolean>>;
    }
  | {
      readonly ok: false;
      readonly outcome: "staging_failed";
      readonly originalBasename: string;
      readonly assetId: string;
      readonly assetDisplay: string;
      readonly detail: string;
    };

/**
 * captureFromFile — an APPLICATION use case: "capture from an operator-exported
 * TradingView file."
 *
 * It represents an operator intention (ingest a manually exported chart) and
 * binds a concrete acquisition mechanism — the file-ingest SnapshotSource — to
 * the use-case-agnostic captureOnce orchestrator.
 *
 * captureOnce remains the canonical lower-level ingestion sequence. This use
 * case owns only the delivery-neutral receipt: after captureOnce succeeds, it
 * derives Pack membership and state from the existing authoritative facts.
 * Delivery surfaces render the returned receipt and do not repeat that
 * interpretation.
 */

export interface CaptureFromFileDeps {
  /** Path to the operator-exported TradingView PNG to ingest. */
  readonly filePath: string;
  readonly resolver: Resolver;
  readonly registry: Registry;
  /** Pass the persisted Workspace surface so the capture fact auto-saves. */
  readonly workspace: Workspace;
  readonly staging: StagingStore;
  /** Validates a staged-candidate image by path. (Application-owned contract.) */
  readonly validate: (imagePath: string) => ValidationResult | Promise<ValidationResult>;
}

function assetReceipt(registry: Registry, assetId: string): ImportReceiptAsset {
  const asset = registry.all().find((candidate) => candidate.id === assetId);
  if (asset === undefined) {
    throw new Error(
      `Capture-from-file contradiction: Pack references Asset "${assetId}" but the Registry does not contain it`,
    );
  }
  return Object.freeze({ id: asset.id, display: asset.display });
}

function placementFor(
  registry: Registry,
  workspace: Workspace,
  assetId: string,
): ImportPlacement {
  const containing = workspace.packs().filter((pack) => pack.assets.includes(assetId));
  if (containing.length > 1) {
    throw new Error(
      `Capture-from-file contradiction: Asset "${assetId}" belongs to multiple Packs in a disjoint Workspace`,
    );
  }

  const pack = containing[0];
  if (pack === undefined) {
    return Object.freeze({ kind: "held" });
  }

  const remainingRequiredAssets = Object.freeze(
    workspace.pendingAssets(pack.id).map((pendingId) => assetReceipt(registry, pendingId)),
  );

  return Object.freeze({
    kind: "pack",
    packId: pack.id,
    packDisplay: pack.display,
    packState: workspace.packState(pack.id),
    capturedCount: pack.assets.length - remainingRequiredAssets.length,
    totalCount: pack.assets.length,
    remainingRequiredAssets,
  });
}

function receiptFromAttempt(
  originalBasename: string,
  attempt: CaptureAttemptResult,
  registry: Registry,
  workspace: Workspace,
): CaptureFromFileReceipt {
  if (attempt.ok) {
    return Object.freeze({
      ok: true,
      outcome: "staged",
      originalBasename,
      assetId: attempt.asset.id,
      assetDisplay: attempt.asset.display,
      revisions: attempt.revisions,
      placement: placementFor(registry, workspace, attempt.asset.id),
    });
  }

  switch (attempt.outcome) {
    case "capture_failed":
      return Object.freeze({
        ok: false,
        outcome: attempt.outcome,
        originalBasename,
        detail: attempt.detail,
      });

    case "unparseable_filename":
      return Object.freeze({
        ok: false,
        outcome: attempt.outcome,
        originalBasename,
        filename: attempt.filename,
      });

    case "unknown_symbol":
      return Object.freeze({
        ok: false,
        outcome: attempt.outcome,
        originalBasename,
        symbol: attempt.symbol,
      });

    case "validation_failed":
      return Object.freeze({
        ok: false,
        outcome: attempt.outcome,
        originalBasename,
        assetId: attempt.asset.id,
        assetDisplay: attempt.asset.display,
        reason: attempt.reason,
        checks: Object.freeze({ ...attempt.checks }),
      });

    case "staging_failed":
      return Object.freeze({
        ok: false,
        outcome: attempt.outcome,
        originalBasename,
        assetId: attempt.asset.id,
        assetDisplay: attempt.asset.display,
        detail: attempt.detail,
      });

    default: {
      const exhaustive: never = attempt;
      throw new Error(`Unhandled capture attempt: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function captureFromFile(
  deps: CaptureFromFileDeps,
): Promise<CaptureFromFileReceipt> {
  const source = createFileSnapshotSource(deps.filePath);
  const attempt = await captureOnce({
    capturer: source,
    resolver: deps.resolver,
    workspace: deps.workspace,
    staging: deps.staging,
    validate: deps.validate,
  });

  return receiptFromAttempt(
    basename(deps.filePath),
    attempt,
    deps.registry,
    deps.workspace,
  );
}

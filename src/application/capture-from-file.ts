import type { Resolver } from "../resolver/index.ts";
import type { Workspace } from "../packs/workspace.ts";
import type { StagingStore } from "../wiring/staging.ts";
import type { ValidationResult } from "../types.ts";
import { createFileSnapshotSource } from "../snapshot/sources/file-source.ts";
import { captureOnce, type CaptureAttemptResult } from "../wiring/capture-once.ts";

/**
 * captureFromFile — an APPLICATION use case: "capture from an operator-exported
 * TradingView file."
 *
 * It represents an operator intention (ingest a manually exported chart) and
 * binds a concrete acquisition mechanism — the file-ingest SnapshotSource — to
 * the use-case-agnostic captureOnce orchestrator.
 *
 * Layering: application (this) -> wiring/orchestrators (captureOnce) +
 * snapshot/sources (the SnapshotSource) -> verified modules. The arrow points
 * one way: use cases depend on orchestrators; orchestrators never depend on use
 * cases. Future acquisition use cases (browser, CDP, UI-triggered) become
 * siblings here, each binding a different SnapshotSource to the same captureOnce.
 *
 * CaptureFromFileDeps owns its dependency contract in terms of the stable,
 * exported interfaces (Workspace, StagingStore, ValidationResult) rather than
 * indexing into captureOnce's internal dependency bundle. This keeps the
 * application layer's public contract independent of how the orchestrator
 * happens to bundle its deps.
 *
 * captureOnce is consumed unmodified: the file source satisfies its capturer
 * dependency structurally ({ capture(): Promise<...> }), so this is pure
 * composition.
 */

export interface CaptureFromFileDeps {
  /** Path to the operator-exported TradingView PNG to ingest. */
  readonly filePath: string;
  readonly resolver: Resolver;
  /** Pass the persisted Workspace surface so the capture fact auto-saves. */
  readonly workspace: Workspace;
  readonly staging: StagingStore;
  /** Validates a staged-candidate image by path. (Application-owned contract.) */
  readonly validate: (imagePath: string) => ValidationResult | Promise<ValidationResult>;
}

export function captureFromFile(deps: CaptureFromFileDeps): Promise<CaptureAttemptResult> {
  const source = createFileSnapshotSource(deps.filePath);
  return captureOnce({
    capturer: source, // SnapshotSource satisfies captureOnce's capturer shape
    resolver: deps.resolver,
    workspace: deps.workspace,
    staging: deps.staging,
    validate: deps.validate,
  });
}
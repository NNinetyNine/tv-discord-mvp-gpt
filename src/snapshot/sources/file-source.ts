import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { Snapshot, SnapshotSource } from "../snapshot.ts";
import { applyBranding } from "../../capture/branding.ts";

/**
 * Manual file-ingest snapshot source — the first concrete SnapshotSource.
 *
 * Workflow: the operator manually frames a chart in TradingView and triggers
 * TradingView's native image export. This source ingests that exported PNG:
 *   1. preserve the original filename byte-for-byte as suggestedFilename
 *      (the resolver's only signal — never normalized/sanitized here)
 *   2. copy the file into VisionX's custody (the original export is left intact)
 *   3. brand the copy (entering custody includes making it VisionX's artifact)
 *   4. return a Snapshot
 *
 * Branding happens here because, for this source, "entering VisionX custody"
 * includes producing the branded artifact. The copy uses a path-safe neutral
 * name; suggestedFilename independently carries the original native name.
 *
 * This source owns no browser, no page, no watcher — it ingests one named file.
 *
 * NOTE: branding currently lives in capture/branding.ts. It is conceptually a
 * shared imaging concern and will be promoted to a shared imaging module during
 * the runtime migration cleanup; until then this source depends on the existing
 * location to keep this phase purely additive (no legacy modules modified).
 */

export class FileIngestError extends Error {
  constructor(message: string) {
    super(`File ingest error: ${message}`);
    this.name = "FileIngestError";
  }
}

function outputDir(): string {
  const dir = resolve(process.cwd(), process.env.IMAGE_OUTPUT_DIR ?? "./output");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Ingest one exported PNG into VisionX custody and return the Snapshot. Pure
 * core (no source object): copy -> brand -> Snapshot. Throws FileIngestError if
 * the named file does not exist (an operator/programming error, not a normal
 * operational outcome).
 */
export async function ingestFile(sourcePath: string): Promise<Snapshot> {
  if (!existsSync(sourcePath)) {
    throw new FileIngestError(`file does not exist: ${sourcePath}`);
  }

  // The original export's name IS TradingView's suggested filename. Preserve it
  // byte-for-byte — the resolver's extract/normalize internals do all
  // interpretation downstream.
  const suggestedFilename = basename(sourcePath);

  const capturedAt = new Date().toISOString();
  // Neutral, path-safe name for the custody copy (the native name may contain
  // characters like "!"; suggestedFilename carries the original independently).
  const destPath = resolve(outputDir(), `snapshot_${capturedAt.replace(/[:.]/g, "-")}.png`);

  copyFileSync(sourcePath, destPath); // copy, not move: leave the export intact
  await applyBranding(destPath); // brand the copy as part of entering custody

  return { imagePath: destPath, capturedAt, suggestedFilename };
}

/**
 * Create a SnapshotSource that ingests a specific exported file when capture()
 * is called. This satisfies the SnapshotSource contract for future consumers.
 */
export function createFileSnapshotSource(sourcePath: string): SnapshotSource {
  return {
    capture(): Promise<Snapshot> {
      return ingestFile(sourcePath);
    },
  };
}
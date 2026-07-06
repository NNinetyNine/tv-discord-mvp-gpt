/**
 * Snapshot — the canonical domain object: a captured TradingView chart that has
 * entered VisionX's custody. It is acquisition-independent: a Snapshot is the
 * same fact whether it arrived via a browser download, a manually exported file,
 * a CDP-attached page, or a watched folder.
 *
 * Essential properties:
 *   - suggestedFilename: TradingView's own name for the chart, preserved
 *     byte-for-byte. This is the snapshot's IDENTITY for resolution — the one
 *     load-bearing field. No acquisition method may normalize or sanitize it.
 *   - imagePath: where the pixel artifact lives in VisionX's custody (a copy
 *     VisionX owns — never the original export/download).
 *   - capturedAt: when the snapshot entered custody (ISO-8601).
 *
 * Nothing here references how a snapshot was acquired (no page, no file, no
 * Playwright). Acquisition is confined to SnapshotSource implementations.
 *
 * NOTE: Snapshot is intentionally identical to the legacy CaptureResult at this
 * stage. This duplication is a deliberate, temporary seam between the new
 * Snapshot-centric architecture and the legacy capture path. The two are kept
 * decoupled (neither aliases the other) until the runtime migration unifies
 * them — at which point captureOnce adopts Snapshot and CaptureResult retires.
 */
export interface Snapshot {
  readonly imagePath: string;
  readonly capturedAt: string;
  readonly suggestedFilename: string;
}

/**
 * SnapshotSource — the acquisition seam. Every acquisition method (manual file
 * ingest now; browser download, CDP, persistent Playwright, folder-watch later)
 * is a SnapshotSource. The verb is capture(): the application is fundamentally
 * about capturing TradingView charts, regardless of the underlying mechanism.
 *
 * Implementations confine all mechanism-specific concerns (files, pages,
 * Playwright, watchers) to themselves; consumers depend only on this interface.
 */
export interface SnapshotSource {
  capture(): Promise<Snapshot>;
}
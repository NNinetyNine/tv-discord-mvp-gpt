import {
  mkdirSync,
  copyFileSync,
  renameSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";

/**
 * Staging store — filesystem-only storage for captured chart images, keyed by
 * packId + assetId. ONE current staged image per asset; re-staging overwrites
 * (newest wins).
 *
 * Layout:
 *   <baseDir>/active/<packId>/<assetId>.png
 *
 * The `active/` segment reserves a sibling namespace for a future archive step
 * (not implemented here).
 *
 * This layer knows NOTHING about pack completeness, missing assets, the Session,
 * publishing decisions, or UI state. It only manages files. Higher layers derive
 * "captured / pending / replaced" by combining the Session (source of truth)
 * with this store's list()/get().
 *
 * Correctness:
 *  - atomic writes: copy to a temp file in the same dir, then rename into place,
 *    so a staged file is always complete or absent.
 *  - path-safe IDs: packId/assetId are validated (no separators, no "..", safe
 *    charset) and the resolved path is confirmed to stay within the pack dir.
 *  - copy, not move: the source image is left intact for the caller.
 *
 * The store is stateless: `stagedAt` is derived from the staged file's mtime, so
 * it survives process restarts and never drifts from what is actually on disk.
 * If a logical timestamp independent of filesystem metadata is ever needed, it
 * should be persisted explicitly (e.g. a metadata file), not held in memory.
 */

export class StagingError extends Error {
  constructor(message: string) {
    super(`Staging error: ${message}`);
    this.name = "StagingError";
  }
}

/** A currently staged image for one asset within a pack. */
export interface StagedImage {
  readonly packId: string;
  readonly assetId: string;
  readonly path: string;
  readonly stagedAt: string; // ISO-8601, derived from the staged file's mtime
}

export interface StagingStore {
  stage(packId: string, assetId: string, sourceImagePath: string): StagedImage;
  get(packId: string, assetId: string): StagedImage | null;
  list(packId: string): readonly StagedImage[];
  has(packId: string, assetId: string): boolean;
  unstage(packId: string, assetId: string): boolean;
  clear(packId: string): void;
}

// Conservative safe-id charset: letters, digits, dot, underscore, hyphen.
// Asset IDs like "brk.b", "1810", "novob" and pack IDs like "crypto" all pass;
// anything with a path separator, "..", whitespace, or other punctuation fails.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeId(kind: "packId" | "assetId", value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new StagingError(`${kind} must be a non-empty string`);
  }
  if (value === "." || value === "..") {
    throw new StagingError(`${kind} "${value}" is not a valid path segment`);
  }
  if (!SAFE_ID.test(value)) {
    throw new StagingError(`${kind} "${value}" contains unsafe characters (allowed: A-Z a-z 0-9 . _ -)`);
  }
}

/**
 * Create a staging store rooted at `baseDir`. The base directory is injected so
 * tests can use a temp directory and never touch the real staging tree.
 */
export function createStagingStore(baseDir: string): StagingStore {
  const activeRoot = resolve(baseDir, "active");

  function packDir(packId: string): string {
    assertSafeId("packId", packId);
    const dir = resolve(activeRoot, packId);
    // Defense in depth: confirm the resolved dir is within activeRoot.
    if (dir !== join(activeRoot, packId)) {
      throw new StagingError(`packId "${packId}" resolves outside the staging root`);
    }
    return dir;
  }

  function assetPath(packId: string, assetId: string): string {
    const dir = packDir(packId);
    assertSafeId("assetId", assetId);
    const file = resolve(dir, `${assetId}.png`);
    if (file !== join(dir, `${assetId}.png`)) {
      throw new StagingError(`assetId "${assetId}" resolves outside the pack directory`);
    }
    return file;
  }

  function toStaged(packId: string, assetId: string, path: string): StagedImage {
    const stagedAt = statSync(path).mtime.toISOString();
    return { packId, assetId, path, stagedAt };
  }

  return {
    stage(packId: string, assetId: string, sourceImagePath: string): StagedImage {
      const dest = assetPath(packId, assetId);

      if (!existsSync(sourceImagePath)) {
        throw new StagingError(`source image does not exist: ${sourceImagePath}`);
      }

      const dir = packDir(packId);
      mkdirSync(dir, { recursive: true });

      // Atomic write: copy to a temp file in the same dir, then rename over dest.
      const tmp = resolve(dir, `.${assetId}.${process.pid}.${Date.now()}.tmp`);
      try {
        copyFileSync(sourceImagePath, tmp);
        renameSync(tmp, dest); // atomic within the same filesystem
      } catch (e) {
        try {
          if (existsSync(tmp)) rmSync(tmp);
        } catch {
          /* ignore cleanup error */
        }
        throw new StagingError(
          `failed to stage ${packId}/${assetId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      return toStaged(packId, assetId, dest);
    },

    get(packId: string, assetId: string): StagedImage | null {
      const path = assetPath(packId, assetId);
      return existsSync(path) ? toStaged(packId, assetId, path) : null;
    },

    list(packId: string): readonly StagedImage[] {
      const dir = packDir(packId);
      if (!existsSync(dir)) return [];
      const out: StagedImage[] = [];
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".png")) continue; // ignore stray temp files etc.
        const assetId = entry.slice(0, -".png".length);
        out.push(toStaged(packId, assetId, join(dir, entry)));
      }
      // Stable, deterministic ordering by assetId (caller re-orders if needed).
      out.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
      return out;
    },

    has(packId: string, assetId: string): boolean {
      return existsSync(assetPath(packId, assetId));
    },

    unstage(packId: string, assetId: string): boolean {
      const path = assetPath(packId, assetId);
      if (!existsSync(path)) return false;
      rmSync(path);
      return true;
    },

    clear(packId: string): void {
      const dir = packDir(packId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}
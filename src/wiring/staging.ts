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
 * assetId ONLY. ONE current staged image per asset; re-staging overwrites
 * (newest wins).
 *
 * Layout:
 *   <baseDir>/active/<assetId>.png
 *
 * Custody follows the ASSET, not the pack (Session Evolution ruling 3): an
 * Analysis attaches to its Asset (Constitution §2.1), asset ids are globally
 * unique under §9.1 disjointness, and every consumer derives pack identity
 * from the definitions/plan/record it already holds — so a pack segment in
 * the key encoded nothing and made held work (§4.6) unrepresentable. The
 * `active/` segment reserves a sibling namespace as before.
 *
 * This layer knows NOTHING about packs, completeness, the Workspace,
 * publishing decisions, or UI state. It only manages files. Higher layers
 * derive "captured / pending / replaced" by combining the working state
 * (source of truth) with this store's list()/get().
 *
 * Correctness:
 *  - atomic writes: copy to a temp file in the same dir, then rename into
 *    place, so a staged file is always complete or absent.
 *  - path-safe IDs: assetId is validated (no separators, no "..", safe
 *    charset) and the resolved path is confirmed to stay within the root.
 *  - copy, not move: the source image is left intact for the caller.
 *
 * The store is stateless: `stagedAt` is derived from the staged file's mtime,
 * so it survives process restarts and never drifts from what is actually on
 * disk.
 *
 * TRANSITIONAL — DEMOLITION-SCHEDULED: migrateLegacyPackLayout() migrates the
 * old pack-keyed layout (active/<packId>/<assetId>.png) to the flat layout
 * once, at construction. Collisions (the same assetId under two pack dirs, or
 * an already-flat file) are impossible for any tree the old system wrote
 * (disjoint packs; single-active staging) and therefore fail LOUD as
 * corruption. Deletable once the production staging/ tree is confirmed flat;
 * at the latest, at the runtime flip. Its removal is the deletion of that one
 * function, its call, and its test block.
 */

export class StagingError extends Error {
  constructor(message: string) {
    super(`Staging error: ${message}`);
    this.name = "StagingError";
  }
}

/** A currently staged image for one asset. */
export interface StagedImage {
  readonly assetId: string;
  readonly path: string;
  readonly stagedAt: string; // ISO-8601, derived from the staged file's mtime
}

export interface StagingStore {
  stage(assetId: string, sourceImagePath: string): StagedImage;
  get(assetId: string): StagedImage | null;
  /** ALL currently staged assets, deterministically ordered by assetId. */
  list(): readonly StagedImage[];
  has(assetId: string): boolean;
  unstage(assetId: string): boolean;
  /** Remove exactly the supplied assets' staged images (absent ids are no-ops). */
  clear(assetIds: readonly string[]): void;
}

// Conservative safe-id charset: letters, digits, dot, underscore, hyphen.
// Asset IDs like "brk.b", "1810", "novob" all pass; anything with a path
// separator, "..", whitespace, or other punctuation fails.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeId(kind: "assetId", value: string): void {
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
 * TRANSITIONAL — DEMOLITION-SCHEDULED (see module header). One-time layout
 * migration: move active/<packId>/<assetId>.png up to active/<assetId>.png,
 * then remove the emptied pack directories. Fail LOUD on any collision.
 */
function migrateLegacyPackLayout(activeRoot: string): void {
  if (!existsSync(activeRoot)) return;
  for (const entry of readdirSync(activeRoot)) {
    const legacyDir = join(activeRoot, entry);
    if (!statSync(legacyDir).isDirectory()) continue; // already-flat files
    for (const file of readdirSync(legacyDir)) {
      if (!file.endsWith(".png")) continue; // stray temp files go with the dir
      const dest = join(activeRoot, file);
      if (existsSync(dest)) {
        throw new StagingError(
          `legacy staging migration collision: "${file}" exists both under pack dir "${entry}" and at the staging root — ` +
            `this tree could not have been written by the system; resolve it manually before continuing`,
        );
      }
      renameSync(join(legacyDir, file), dest);
    }
    rmSync(legacyDir, { recursive: true, force: true });
  }
}

/**
 * Create a staging store rooted at `baseDir`. The base directory is injected
 * so tests can use a temp directory and never touch the real staging tree.
 * Migrates any legacy pack-keyed layout once, at construction.
 */
export function createStagingStore(baseDir: string): StagingStore {
  const activeRoot = resolve(baseDir, "active");

  migrateLegacyPackLayout(activeRoot);

  function assetPath(assetId: string): string {
    assertSafeId("assetId", assetId);
    const file = resolve(activeRoot, `${assetId}.png`);
    if (file !== join(activeRoot, `${assetId}.png`)) {
      throw new StagingError(`assetId "${assetId}" resolves outside the staging root`);
    }
    return file;
  }

  function toStaged(assetId: string, path: string): StagedImage {
    const stagedAt = statSync(path).mtime.toISOString();
    return { assetId, path, stagedAt };
  }

  return {
    stage(assetId: string, sourceImagePath: string): StagedImage {
      const dest = assetPath(assetId);

      if (!existsSync(sourceImagePath)) {
        throw new StagingError(`source image does not exist: ${sourceImagePath}`);
      }

      mkdirSync(activeRoot, { recursive: true });

      // Atomic write: copy to a temp file in the same dir, then rename over dest.
      const tmp = resolve(activeRoot, `.${assetId}.${process.pid}.${Date.now()}.tmp`);
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
          `failed to stage ${assetId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      return toStaged(assetId, dest);
    },

    get(assetId: string): StagedImage | null {
      const path = assetPath(assetId);
      return existsSync(path) ? toStaged(assetId, path) : null;
    },

    list(): readonly StagedImage[] {
      if (!existsSync(activeRoot)) return [];
      const out: StagedImage[] = [];
      for (const entry of readdirSync(activeRoot)) {
        if (!entry.endsWith(".png")) continue; // ignore stray temp files etc.
        const path = join(activeRoot, entry);
        if (statSync(path).isDirectory()) continue;
        const assetId = entry.slice(0, -".png".length);
        out.push(toStaged(assetId, path));
      }
      // Stable, deterministic ordering by assetId (caller re-orders if needed).
      out.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
      return out;
    },

    has(assetId: string): boolean {
      return existsSync(assetPath(assetId));
    },

    unstage(assetId: string): boolean {
      const path = assetPath(assetId);
      if (!existsSync(path)) return false;
      rmSync(path);
      return true;
    },

    clear(assetIds: readonly string[]): void {
      for (const assetId of assetIds) {
        const path = assetPath(assetId);
        if (existsSync(path)) rmSync(path);
      }
    },
  };
}
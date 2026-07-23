import { readFileSync } from "node:fs";

/**
 * Installation-owned bindings from a Pack/Asset pair to the persistent
 * Discord forum thread that represents that Asset inside that Pack.
 *
 * Domain definitions continue to own Pack membership and Asset identity.
 * This adapter owns only environment-specific Discord snowflakes.
 */

export class AssetThreadsError extends Error {
  constructor(message: string) {
    super(`Asset threads error: ${message}`);
    this.name = "AssetThreadsError";
  }
}

const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/u;
const SAFE_DOMAIN_ID = /^[A-Za-z0-9._-]+$/u;

export interface AssetThreadBindings {
  readonly schemaVersion: 1;
  readonly packs: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

/** Resolve one Pack/Asset pair to its persistent Discord thread ID. */
export type AssetThreadResolver = (
  packId: string,
  assetId: string,
) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDomainId(kind: "pack" | "asset", value: string): void {
  if (value.length === 0) {
    throw new AssetThreadsError(`${kind} id must not be empty`);
  }
  if (!SAFE_DOMAIN_ID.test(value)) {
    throw new AssetThreadsError(
      `${kind} id "${value}" contains unsafe characters`,
    );
  }
}

/**
 * Validate a parsed schema-version-1 binding document.
 *
 * The shape is deliberately minimal:
 *
 * {
 *   "schemaVersion": 1,
 *   "packs": {
 *     "crypto": {
 *       "btc": "123456789012345678"
 *     }
 *   }
 * }
 */
export function parseAssetThreadBindings(
  value: unknown,
): AssetThreadBindings {
  if (!isRecord(value)) {
    throw new AssetThreadsError("binding document must be a JSON object");
  }

  const fields = Object.keys(value).sort();
  if (
    fields.length !== 2 ||
    fields[0] !== "packs" ||
    fields[1] !== "schemaVersion"
  ) {
    throw new AssetThreadsError(
      "binding document must contain exactly schemaVersion and packs",
    );
  }

  if (value["schemaVersion"] !== 1) {
    throw new AssetThreadsError(
      `unsupported schemaVersion: ${String(value["schemaVersion"])}`,
    );
  }

  const rawPacks = value["packs"];
  if (!isRecord(rawPacks)) {
    throw new AssetThreadsError("packs must be a JSON object");
  }

  const packs: Record<string, Readonly<Record<string, string>>> = {};
  const ownerByThreadId = new Map<string, string>();

  for (const [packId, rawAssets] of Object.entries(rawPacks)) {
    validateDomainId("pack", packId);

    if (!isRecord(rawAssets)) {
      throw new AssetThreadsError(
        `packs.${packId} must be a JSON object`,
      );
    }

    const assets: Record<string, string> = {};

    for (const [assetId, rawThreadId] of Object.entries(rawAssets)) {
      validateDomainId("asset", assetId);

      if (
        typeof rawThreadId !== "string" ||
        !DISCORD_SNOWFLAKE.test(rawThreadId)
      ) {
        throw new AssetThreadsError(
          `packs.${packId}.${assetId} must be a Discord snowflake`,
        );
      }

      const owner = ownerByThreadId.get(rawThreadId);
      if (owner !== undefined) {
        throw new AssetThreadsError(
          `Discord thread ${rawThreadId} is assigned to both ${owner} and ${packId}/${assetId}`,
        );
      }
      ownerByThreadId.set(rawThreadId, `${packId}/${assetId}`);

      assets[assetId] = rawThreadId;
    }

    packs[packId] = Object.freeze(assets);
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    packs: Object.freeze(packs),
  });
}

/**
 * Return a new validated binding document containing one Pack/Asset binding.
 *
 * Repeating the exact same binding is idempotent. A different thread already
 * bound to the same composite identity is rejected: adoption or provisioning
 * must never silently redirect future publications.
 */
export function bindAssetThread(
  bindings: AssetThreadBindings,
  packId: string,
  assetId: string,
  threadId: string,
): AssetThreadBindings {
  validateDomainId("pack", packId);
  validateDomainId("asset", assetId);

  if (!DISCORD_SNOWFLAKE.test(threadId)) {
    throw new AssetThreadsError(
      `packs.${packId}.${assetId} must be a Discord snowflake`,
    );
  }

  const current = bindings.packs[packId]?.[assetId];
  if (current !== undefined && current !== threadId) {
    throw new AssetThreadsError(
      `packs.${packId}.${assetId} is already bound to ${current}`,
    );
  }

  if (current === threadId) return bindings;

  for (const [currentPackId, assets] of Object.entries(bindings.packs)) {
    for (const [currentAssetId, currentThreadId] of Object.entries(assets)) {
      if (currentThreadId === threadId) {
        throw new AssetThreadsError(
          `Discord thread ${threadId} is already bound to ${currentPackId}/${currentAssetId}`,
        );
      }
    }
  }

  const nextPacks: Record<
    string,
    Readonly<Record<string, string>>
  > = {};

  for (const [currentPackId, assets] of Object.entries(
    bindings.packs,
  )) {
    nextPacks[currentPackId] = assets;
  }

  nextPacks[packId] = Object.freeze({
    ...(bindings.packs[packId] ?? {}),
    [assetId]: threadId,
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    packs: Object.freeze(nextPacks),
  });
}

/**
 * Return a new validated binding document that deliberately redirects one
 * already-bound Pack/Asset pair.
 *
 * The caller must repeat the exact current thread identity. This prevents a
 * stale administration view from replacing a binding that changed after it
 * was loaded. The replacement thread must remain globally unique.
 */
export function replaceAssetThreadBinding(
  bindings: AssetThreadBindings,
  packId: string,
  assetId: string,
  expectedThreadId: string,
  nextThreadId: string,
): AssetThreadBindings {
  validateDomainId("pack", packId);
  validateDomainId("asset", assetId);
  if (!DISCORD_SNOWFLAKE.test(expectedThreadId)) {
    throw new AssetThreadsError(
      `expected packs.${packId}.${assetId} binding must be a Discord snowflake`,
    );
  }
  if (!DISCORD_SNOWFLAKE.test(nextThreadId)) {
    throw new AssetThreadsError(
      `packs.${packId}.${assetId} must be a Discord snowflake`,
    );
  }

  const current = bindings.packs[packId]?.[assetId];
  if (current === undefined) {
    throw new AssetThreadsError(
      `packs.${packId}.${assetId} is not currently bound`,
    );
  }
  if (current !== expectedThreadId) {
    throw new AssetThreadsError(
      `packs.${packId}.${assetId} changed from expected thread ${expectedThreadId}`,
    );
  }
  if (current === nextThreadId) return bindings;

  for (const [currentPackId, assets] of Object.entries(bindings.packs)) {
    for (const [currentAssetId, currentThreadId] of Object.entries(assets)) {
      if (
        currentThreadId === nextThreadId &&
        (currentPackId !== packId || currentAssetId !== assetId)
      ) {
        throw new AssetThreadsError(
          `Discord thread ${nextThreadId} is already bound to ${currentPackId}/${currentAssetId}`,
        );
      }
    }
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    packs: Object.freeze({
      ...bindings.packs,
      [packId]: Object.freeze({
        ...(bindings.packs[packId] ?? {}),
        [assetId]: nextThreadId,
      }),
    }),
  });
}

/**
 * Return a new validated binding document without one Pack/Asset binding.
 *
 * Removing a binding never deletes or edits the Discord post. The exact
 * expected thread identity is required so stale UI state fails closed.
 */
export function unbindAssetThread(
  bindings: AssetThreadBindings,
  packId: string,
  assetId: string,
  expectedThreadId: string,
): AssetThreadBindings {
  validateDomainId("pack", packId);
  validateDomainId("asset", assetId);
  if (!DISCORD_SNOWFLAKE.test(expectedThreadId)) {
    throw new AssetThreadsError(
      `expected packs.${packId}.${assetId} binding must be a Discord snowflake`,
    );
  }

  const currentAssets = bindings.packs[packId];
  const current = currentAssets?.[assetId];
  if (current === undefined) {
    throw new AssetThreadsError(
      `packs.${packId}.${assetId} is not currently bound`,
    );
  }
  if (current !== expectedThreadId) {
    throw new AssetThreadsError(
      `packs.${packId}.${assetId} changed from expected thread ${expectedThreadId}`,
    );
  }

  const nextAssets = { ...(currentAssets ?? {}) };
  delete nextAssets[assetId];
  const nextPacks = { ...bindings.packs };
  if (Object.keys(nextAssets).length === 0) delete nextPacks[packId];
  else nextPacks[packId] = Object.freeze(nextAssets);

  return Object.freeze({
    schemaVersion: 1 as const,
    packs: Object.freeze(nextPacks),
  });
}

/**
 * Serialize installation bindings canonically.
 *
 * Pack and Asset keys are lexical so equivalent documents produce identical
 * bytes regardless of insertion order. The trailing newline matches the
 * repository's configuration-file convention.
 */
export function serializeAssetThreadBindings(
  bindings: AssetThreadBindings,
): Buffer {
  const packs: Record<string, Record<string, string>> = {};

  for (const packId of Object.keys(bindings.packs).sort(
    (left, right) => left.localeCompare(right, "en"),
  )) {
    const sourceAssets = bindings.packs[packId] ?? {};
    const assets: Record<string, string> = {};

    for (const assetId of Object.keys(sourceAssets).sort(
      (left, right) => left.localeCompare(right, "en"),
    )) {
      const threadId = sourceAssets[assetId];
      if (threadId === undefined) {
        throw new AssetThreadsError(
          `packs.${packId}.${assetId} has no thread binding`,
        );
      }
      assets[assetId] = threadId;
    }

    packs[packId] = assets;
  }

  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packs,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** Build a pure resolver from already-validated bindings. */
export function buildAssetThreadResolver(
  bindings: AssetThreadBindings,
): AssetThreadResolver {
  return (packId: string, assetId: string): string | null => {
    return bindings.packs[packId]?.[assetId] ?? null;
  };
}

/** Load and validate an Asset-thread binding document from disk. */
export function loadAssetThreadBindings(
  bindingsPath: string,
): AssetThreadBindings {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(bindingsPath, "utf8")) as unknown;
  } catch (error) {
    throw new AssetThreadsError(
      `could not read/parse ${bindingsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return parseAssetThreadBindings(parsed);
}

/** Load a binding document and construct its pure resolver. */
export function loadAssetThreadResolver(
  bindingsPath: string,
): AssetThreadResolver {
  return buildAssetThreadResolver(
    loadAssetThreadBindings(bindingsPath),
  );
}

import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adoptDiscordAssetThread,
  type AdoptDiscordAssetThreadResult,
} from "../application/adopt-discord-asset-thread.ts";
import {
  loadPacks,
  type Pack,
} from "../packs/packs.ts";
import {
  openDiscordForumSession,
  type DiscordForumSession,
} from "../publish/discord-forum-session.ts";
import {
  loadRegistry,
  type Registry,
} from "../registry/registry.ts";
import {
  bindAssetThreadFile,
  type BindAssetThreadFileResult,
} from "../wiring/asset-thread-bindings-file.ts";
import {
  buildChannelResolver,
  loadChannels,
  type ChannelResolver,
} from "../wiring/channels.ts";

const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/u;

export const ADOPT_DISCORD_ASSET_THREAD_USAGE = [
  "Adopt an existing Discord forum post as one Asset's persistent thread.",
  "",
  "Usage:",
  "  npm run adopt-thread -- <packId> <assetId> <threadId>",
  "",
  "The thread must already belong to the Pack's configured Discord forum.",
  "Adoption preserves the existing title, tags, archive/lock state, starter",
  "message, and message history. Only config/asset-threads.json is updated.",
].join("\n");

export interface AdoptDiscordAssetThreadArguments {
  readonly packId: string;
  readonly assetId: string;
  readonly threadId: string;
}

export class AdoptDiscordAssetThreadCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptDiscordAssetThreadCliError";
  }
}

export interface AdoptDiscordAssetThreadCliDependencies {
  readonly loadChannels:
    (channelsPath: string) =>
      Record<string, unknown>;
  readonly loadRegistry:
    (
      registryPath: string,
      channelsPath: string,
    ) => Registry;
  readonly loadPacks:
    (
      packsPath: string,
      validIds: ReadonlySet<string>,
      channelNames: ReadonlySet<string>,
    ) => readonly Pack[];
  readonly buildChannelResolver:
    (
      channels: Record<string, unknown>,
    ) => ChannelResolver;
  readonly openSession:
    () => Promise<DiscordForumSession>;
  readonly bindThreadFile:
    (
      bindingsPath: string,
      packId: string,
      assetId: string,
      threadId: string,
    ) => Promise<BindAssetThreadFileResult>;
}

const REAL_DEPENDENCIES:
AdoptDiscordAssetThreadCliDependencies =
  Object.freeze({
    loadChannels,
    loadRegistry,
    loadPacks,
    buildChannelResolver,
    openSession: openDiscordForumSession,
    bindThreadFile: bindAssetThreadFile,
  });

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

export function parseAdoptDiscordAssetThreadArguments(
  argv: readonly string[],
): AdoptDiscordAssetThreadArguments {
  const supplied = argv.slice(2);

  if (supplied.length !== 3) {
    throw new AdoptDiscordAssetThreadCliError(
      "Exactly packId, assetId, and threadId are required.",
    );
  }

  const [packId, assetId, threadId] = supplied;

  if (
    packId === undefined ||
    packId.length === 0 ||
    packId.startsWith("-")
  ) {
    throw new AdoptDiscordAssetThreadCliError(
      "packId must be a non-empty positional value.",
    );
  }

  if (
    assetId === undefined ||
    assetId.length === 0 ||
    assetId.startsWith("-")
  ) {
    throw new AdoptDiscordAssetThreadCliError(
      "assetId must be a non-empty positional value.",
    );
  }

  if (
    threadId === undefined ||
    !DISCORD_SNOWFLAKE.test(threadId)
  ) {
    throw new AdoptDiscordAssetThreadCliError(
      "threadId must be a 17-to-20-digit Discord snowflake.",
    );
  }

  return Object.freeze({
    packId,
    assetId,
    threadId,
  });
}

export function reportAdoptDiscordAssetThreadResult(
  result: AdoptDiscordAssetThreadResult,
  stdout: (text: string) => void =
    console.log,
  stderr: (text: string) => void =
    console.error,
): number {
  if (result.ok) {
    const verb =
      result.outcome === "adopted"
        ? "Adopted"
        : "Already adopted";

    stdout(
      `✓ ${verb} ${result.packId}/${result.assetId} → Discord thread ${result.thread.threadId}.`,
    );
    stdout(
      `  Forum: ${result.forumChannelId}`,
    );
    stdout(
      `  Existing title preserved: ${result.thread.name}`,
    );
    stdout(
      `  Existing state preserved: archived=${String(result.thread.archived)}, locked=${String(result.thread.locked)}, tags=${result.thread.appliedTagIds.length}`,
    );
    return 0;
  }

  switch (result.outcome) {
    case "invalid_thread_id":
      stderr(
        `✗ Invalid Discord thread ID: ${result.threadId}`,
      );
      return 2;

    case "unknown_pack":
      stderr(
        `✗ Unknown Pack: ${result.packId}`,
      );
      return 2;

    case "asset_not_in_pack":
      stderr(
        `✗ Asset "${result.assetId}" is not a member of Pack "${result.packId}".`,
      );
      return 2;

    case "forum_channel_unresolved":
      stderr(
        `✗ Pack "${result.packId}" has no provisioned Discord forum for logical channel "${result.channelName}".`,
      );
      return 1;

    case "thread_not_found":
      stderr(
        `✗ Discord thread ${result.threadId} was not found or is not visible to the bot.`,
      );
      return 1;

    case "thread_parent_mismatch":
      stderr(
        `✗ Discord thread ${result.threadId} belongs to parent ${String(result.actualParentId)}, not Pack "${result.packId}" forum ${result.expectedForumChannelId}.`,
      );
      return 1;

    case "discord_inspection_failed":
      stderr(
        `✗ Could not inspect Discord thread ${result.threadId}: ${result.detail}`,
      );
      return 1;

    default: {
      const exhaustive: never = result;
      stderr(
        `✗ Unrecognized adoption result: ${JSON.stringify(exhaustive)}`,
      );
      return 1;
    }
  }
}

export async function main(
  argv: readonly string[] = process.argv,
  workingDirectory: string = process.cwd(),
  stdout: (text: string) => void =
    console.log,
  stderr: (text: string) => void =
    console.error,
  dependencies:
    AdoptDiscordAssetThreadCliDependencies =
      REAL_DEPENDENCIES,
): Promise<number> {
  let input: AdoptDiscordAssetThreadArguments;

  try {
    input =
      parseAdoptDiscordAssetThreadArguments(
        argv,
      );
  } catch (error) {
    stderr(
      `✗ ${errorDetail(error)}`,
    );
    stderr(ADOPT_DISCORD_ASSET_THREAD_USAGE);
    return 2;
  }

  const registryPath = resolve(
    workingDirectory,
    "definitions",
    "registry.json",
  );
  const packsPath = resolve(
    workingDirectory,
    "definitions",
    "packs.json",
  );
  const channelsPath = resolve(
    workingDirectory,
    "config",
    "channels.json",
  );
  const bindingsPath = resolve(
    workingDirectory,
    "config",
    "asset-threads.json",
  );

  try {
    const channels =
      dependencies.loadChannels(channelsPath);
    const registry =
      dependencies.loadRegistry(
        registryPath,
        channelsPath,
      );
    const packs =
      dependencies.loadPacks(
        packsPath,
        new Set(
          registry.all().map(
            (asset) => asset.id,
          ),
        ),
        new Set(Object.keys(channels)),
      );
    const resolveChannel =
      dependencies.buildChannelResolver(
        channels,
      );

    const session =
      await dependencies.openSession();

    try {
      const result =
        await adoptDiscordAssetThread(
          {
            packs,
            resolveChannel,
            inspectThread:
              session.inspectThread,
            bindThread:
              async (
                packId,
                assetId,
                threadId,
              ) => {
                const written =
                  await dependencies
                    .bindThreadFile(
                      bindingsPath,
                      packId,
                      assetId,
                      threadId,
                    );

                return {
                  changed: written.changed,
                };
              },
          },
          input.packId,
          input.assetId,
          input.threadId,
        );

      return reportAdoptDiscordAssetThreadResult(
        result,
        stdout,
        stderr,
      );
    } finally {
      await session.close();
    }
  } catch (error) {
    stderr(
      `✗ Asset-thread adoption failed: ${errorDetail(error)}`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1];

if (
  invokedPath !== undefined &&
  resolve(invokedPath) ===
    fileURLToPath(import.meta.url)
) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

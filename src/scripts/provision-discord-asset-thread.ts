import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readCanonicalAssetLogo,
  type CanonicalAssetLogo,
} from "../assets/asset-logo-file.ts";
import {
  provisionDiscordAssetThread,
  type ProvisionDiscordAssetThreadResult,
} from "../application/provision-discord-asset-thread.ts";
import {
  loadPacks,
  type Pack,
} from "../packs/packs.ts";
import {
  openDiscordForumSession,
  type DiscordForumProvisioningSession,
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
  buildAssetThreadResolver,
  loadAssetThreadBindings,
  type AssetThreadBindings,
  type AssetThreadResolver,
} from "../wiring/asset-threads.ts";
import {
  buildChannelResolver,
  loadChannels,
  type ChannelResolver,
} from "../wiring/channels.ts";

const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/u;

export const PROVISION_DISCORD_ASSET_THREAD_USAGE = [
  "Create one persistent Discord forum post for a canonical Pack Asset.",
  "",
  "Usage:",
  "  npm run provision-thread -- <packId> <assetId> --title <title> [--tag <tagId> ...]",
  "",
  "The title is explicit operator input and should be quoted when it contains spaces.",
  "Each optional --tag value must be an existing tag ID in the Pack's forum.",
  "The starter message uploads assets/asset-logos/<assetId>.png.",
].join("\n");

export interface ProvisionDiscordAssetThreadArguments {
  readonly packId: string;
  readonly assetId: string;
  readonly title: string;
  readonly appliedTagIds: readonly string[];
}

export class ProvisionDiscordAssetThreadCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name =
      "ProvisionDiscordAssetThreadCliError";
  }
}

export interface ProvisionDiscordAssetThreadCliDependencies {
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
  readonly loadBindings:
    (
      bindingsPath: string,
    ) => AssetThreadBindings;
  readonly buildChannelResolver:
    (
      channels: Record<string, unknown>,
    ) => ChannelResolver;
  readonly buildThreadResolver:
    (
      bindings: AssetThreadBindings,
    ) => AssetThreadResolver;
  readonly readLogo:
    (
      repositoryRoot: string,
      assetId: string,
    ) => Promise<CanonicalAssetLogo>;
  readonly openSession:
    () => Promise<DiscordForumProvisioningSession>;
  readonly bindThreadFile:
    (
      bindingsPath: string,
      packId: string,
      assetId: string,
      threadId: string,
    ) => Promise<BindAssetThreadFileResult>;
}

const REAL_DEPENDENCIES:
ProvisionDiscordAssetThreadCliDependencies =
  Object.freeze({
    loadChannels,
    loadRegistry,
    loadPacks,
    loadBindings:
      loadAssetThreadBindings,
    buildChannelResolver,
    buildThreadResolver:
      buildAssetThreadResolver,
    readLogo:
      readCanonicalAssetLogo,
    openSession:
      openDiscordForumSession,
    bindThreadFile:
      bindAssetThreadFile,
  });

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function requirePositional(
  value: string | undefined,
  name: "packId" | "assetId",
): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.startsWith("-")
  ) {
    throw new ProvisionDiscordAssetThreadCliError(
      `${name} must be a non-empty positional value.`,
    );
  }

  return value;
}

export function parseProvisionDiscordAssetThreadArguments(
  argv: readonly string[],
): ProvisionDiscordAssetThreadArguments {
  const supplied = argv.slice(2);
  const packId = requirePositional(
    supplied[0],
    "packId",
  );
  const assetId = requirePositional(
    supplied[1],
    "assetId",
  );

  let title: string | undefined;
  const appliedTagIds: string[] = [];
  const seenTags = new Set<string>();

  for (
    let index = 2;
    index < supplied.length;
    index += 1
  ) {
    const flag = supplied[index];

    if (flag === "--title") {
      if (title !== undefined) {
        throw new ProvisionDiscordAssetThreadCliError(
          "--title must be supplied exactly once.",
        );
      }

      const value = supplied[index + 1];

      if (
        value === undefined ||
        value.length === 0 ||
        value.startsWith("--")
      ) {
        throw new ProvisionDiscordAssetThreadCliError(
          "--title requires one non-empty value.",
        );
      }

      title = value;
      index += 1;
      continue;
    }

    if (flag === "--tag") {
      const value = supplied[index + 1];

      if (
        value === undefined ||
        !DISCORD_SNOWFLAKE.test(value)
      ) {
        throw new ProvisionDiscordAssetThreadCliError(
          "--tag requires a 17-to-20-digit Discord snowflake.",
        );
      }

      if (seenTags.has(value)) {
        throw new ProvisionDiscordAssetThreadCliError(
          `Duplicate --tag value: ${value}`,
        );
      }

      seenTags.add(value);
      appliedTagIds.push(value);
      index += 1;
      continue;
    }

    throw new ProvisionDiscordAssetThreadCliError(
      `Unknown or misplaced argument: ${String(flag)}`,
    );
  }

  if (title === undefined) {
    throw new ProvisionDiscordAssetThreadCliError(
      "--title is required.",
    );
  }

  return Object.freeze({
    packId,
    assetId,
    title,
    appliedTagIds:
      Object.freeze(appliedTagIds),
  });
}

export function reportProvisionDiscordAssetThreadResult(
  result: ProvisionDiscordAssetThreadResult,
  stdout: (text: string) => void =
    console.log,
  stderr: (text: string) => void =
    console.error,
): number {
  if (result.ok) {
    stdout(
      `✓ Provisioned ${result.packId}/${result.assetId} → Discord thread ${result.thread.threadId}.`,
    );
    stdout(
      `  Forum: ${result.forumChannelId}`,
    );
    stdout(
      `  Title: ${result.thread.name}`,
    );
    stdout(
      `  Tags applied: ${result.thread.appliedTagIds.length}`,
    );
    stdout(
      "  Starter message: canonical Asset logo",
    );
    return 0;
  }

  switch (result.outcome) {
    case "invalid_title":
      stderr(
        `✗ Invalid Discord thread title: ${result.detail}`,
      );
      return 2;

    case "invalid_tag_id":
      stderr(
        `✗ Invalid Discord forum tag ID: ${result.tagId}`,
      );
      return 2;

    case "duplicate_tag_id":
      stderr(
        `✗ Duplicate Discord forum tag ID: ${result.tagId}`,
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

    case "unknown_asset":
      stderr(
        `✗ Unknown canonical Asset: ${result.assetId}`,
      );
      return 2;

    case "forum_channel_unresolved":
      stderr(
        `✗ Pack "${result.packId}" has no provisioned Discord forum for logical channel "${result.channelName}".`,
      );
      return 1;

    case "already_bound":
      stderr(
        `✗ ${result.packId}/${result.assetId} is already bound to Discord thread ${result.threadId}.`,
      );
      return 1;

    case "discord_provision_failed":
      stderr(
        `✗ Discord thread provisioning failed for ${result.packId}/${result.assetId}: ${result.detail}`,
      );
      return 1;

    case "invalid_created_thread_deleted":
      stderr(
        `✗ Discord returned invalid facts for newly created thread ${result.thread.threadId}: ${result.detail}`,
      );
      stderr(
        "  The invalid provisional Discord thread was deleted successfully.",
      );
      return 1;

    case "invalid_created_thread_retained":
      stderr(
        `✗ Discord returned invalid facts for newly created thread ${result.thread.threadId}: ${result.detail}`,
      );
      stderr(
        `  URGENT: provisional thread ${result.thread.threadId} was retained because cleanup failed: ${result.cleanupDetail}`,
      );
      return 1;

    case "binding_failed_thread_deleted":
      stderr(
        `✗ Binding failed after Discord created thread ${result.thread.threadId}: ${result.detail}`,
      );
      stderr(
        "  The provisional Discord thread was deleted successfully.",
      );
      return 1;

    case "binding_failed_thread_retained":
      stderr(
        `✗ Binding failed after Discord created thread ${result.thread.threadId}: ${result.detail}`,
      );
      stderr(
        `  URGENT: provisional thread ${result.thread.threadId} was retained because cleanup failed: ${result.cleanupDetail}`,
      );
      return 1;

    default: {
      const exhaustive: never = result;

      stderr(
        `✗ Unrecognized provisioning result: ${JSON.stringify(exhaustive)}`,
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
    ProvisionDiscordAssetThreadCliDependencies =
      REAL_DEPENDENCIES,
): Promise<number> {
  let input:
    ProvisionDiscordAssetThreadArguments;

  try {
    input =
      parseProvisionDiscordAssetThreadArguments(
        argv,
      );
  } catch (error) {
    stderr(`✗ ${errorDetail(error)}`);
    stderr(
      PROVISION_DISCORD_ASSET_THREAD_USAGE,
    );
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
      dependencies.loadChannels(
        channelsPath,
      );
    const registry =
      dependencies.loadRegistry(
        registryPath,
        channelsPath,
      );
    const assets = registry.all();
    const packs =
      dependencies.loadPacks(
        packsPath,
        new Set(
          assets.map((asset) => asset.id),
        ),
        new Set(Object.keys(channels)),
      );
    const bindings =
      dependencies.loadBindings(
        bindingsPath,
      );
    const resolveChannel =
      dependencies.buildChannelResolver(
        channels,
      );
    const resolveThread =
      dependencies.buildThreadResolver(
        bindings,
      );

    /*
     * Canonical logo custody is validated before Discord login or creation.
     */
    const logo =
      await dependencies.readLogo(
        workingDirectory,
        input.assetId,
      );

    let session:
      DiscordForumProvisioningSession | null =
        null;

    const provisioningSession =
      async (): Promise<
        DiscordForumProvisioningSession
      > => {
        if (session === null) {
          session =
            await dependencies.openSession();
        }

        return session;
      };

    try {
      const result =
        await provisionDiscordAssetThread(
          {
            packs,
            assets,
            resolveChannel,
            resolveThread,
            createThread:
              async (createInput) =>
                (
                  await provisioningSession()
                ).createThread(createInput),
            deleteThread:
              async (threadId) =>
                (
                  await provisioningSession()
                ).deleteThread(threadId),
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
          {
            packId: input.packId,
            assetId: input.assetId,
            title: input.title,
            appliedTagIds:
              input.appliedTagIds,
            logo,
          },
        );

      return reportProvisionDiscordAssetThreadResult(
        result,
        stdout,
        stderr,
      );
    } finally {
      const openedSession =
        session as
          | DiscordForumProvisioningSession
          | null;

      if (openedSession !== null) {
        await openedSession.close();
      }
    }
  } catch (error) {
    stderr(
      `✗ Asset-thread provisioning failed: ${errorDetail(error)}`,
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

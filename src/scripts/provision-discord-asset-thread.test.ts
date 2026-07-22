import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  CanonicalAssetLogo,
} from "../assets/asset-logo-file.ts";
import type {
  DiscordAssetThreadCreateInput,
} from "../application/provision-discord-asset-thread.ts";
import type {
  DiscordForumProvisioningSession,
} from "../publish/discord-forum-session.ts";
import {
  buildAssetThreadResolver,
  parseAssetThreadBindings,
  serializeAssetThreadBindings,
} from "../wiring/asset-threads.ts";
import {
  PROVISION_DISCORD_ASSET_THREAD_USAGE,
  ProvisionDiscordAssetThreadCliError,
  main,
  parseProvisionDiscordAssetThreadArguments,
  type ProvisionDiscordAssetThreadCliDependencies,
} from "./provision-discord-asset-thread.ts";

const FORUM_ID = "123456789012345678";
const THREAD_ID = "223456789012345678";
const TAG_ID = "323456789012345678";

const LOGO: CanonicalAssetLogo =
  Object.freeze({
    path:
      "/repo/assets/asset-logos/btc.png",
    bytes: Buffer.from("logo"),
    evidence: Object.freeze({
      ok: true,
      sha256: "a".repeat(64),
      byteSize: 4,
      format: "png",
      width: 96,
      height: 96,
      pageOrFrameCount: 1,
      channelCount: 4,
      hasAlpha: true,
    }),
  });

interface FixtureState {
  opened: number;
  closed: number;
  logoReads: number;
  readonly created:
    DiscordAssetThreadCreateInput[];
  readonly deleted: string[];
  readonly bindings: Array<{
    readonly path: string;
    readonly packId: string;
    readonly assetId: string;
    readonly threadId: string;
  }>;
}

function fixture(
  options: {
    readonly existingThreadId?:
      string;
    readonly readLogoError?: Error;
    readonly bindError?: Error;
  } = {},
): {
  readonly dependencies:
    ProvisionDiscordAssetThreadCliDependencies;
  readonly state: FixtureState;
} {
  const state: FixtureState = {
    opened: 0,
    closed: 0,
    logoReads: 0,
    created: [],
    deleted: [],
    bindings: [],
  };

  const bindings =
    parseAssetThreadBindings({
      schemaVersion: 1,
      packs:
        options.existingThreadId ===
        undefined
          ? {}
          : {
              crypto: {
                btc:
                  options.existingThreadId,
              },
            },
    });

  const session:
    DiscordForumProvisioningSession = {
      inspectThread: async () => null,

      createThread:
        async (input) => {
          state.created.push(input);

          return {
            threadId: THREAD_ID,
            parentId: FORUM_ID,
            name: input.title,
            archived: false,
            locked: false,
            appliedTagIds:
              Object.freeze([
                ...input.appliedTagIds,
              ]),
          };
        },

      deleteThread: async (threadId) => {
        state.deleted.push(threadId);
      },

      close: async () => {
        state.closed += 1;
      },
    };

  const dependencies:
    ProvisionDiscordAssetThreadCliDependencies =
      {
        loadChannels: () => ({
          crypto: FORUM_ID,
        }),

        loadRegistry: () => ({
          lookupByTradingView:
            () => null,
          all: () =>
            Object.freeze([
              Object.freeze({
                id: "btc",
                tradingView: "BTC",
                display: "Bitcoin",
                currency: "USD",
                channel: "crypto",
              }),
            ]),
        }),

        loadPacks: () =>
          Object.freeze([
            Object.freeze({
              id: "crypto",
              display: "Crypto",
              channel: "crypto",
              assets:
                Object.freeze([
                  "btc",
                ]),
            }),
          ]),

        loadBindings: () =>
          bindings,

        buildChannelResolver:
          (channels) =>
            (channelName) => {
              const value =
                channels[channelName];

              return typeof value ===
                "string"
                ? value
                : null;
            },

        buildThreadResolver:
          buildAssetThreadResolver,

        readLogo: async () => {
          state.logoReads += 1;

          if (
            options.readLogoError !==
            undefined
          ) {
            throw options.readLogoError;
          }

          return LOGO;
        },

        openSession: async () => {
          state.opened += 1;
          return session;
        },

        bindThreadFile:
          async (
            path,
            packId,
            assetId,
            threadId,
          ) => {
            state.bindings.push({
              path,
              packId,
              assetId,
              threadId,
            });

            if (
              options.bindError !==
              undefined
            ) {
              throw options.bindError;
            }

            const next =
              parseAssetThreadBindings({
                schemaVersion: 1,
                packs: {
                  crypto: {
                    btc: threadId,
                  },
                },
              });

            return {
              changed: true,
              bindings: next,
              bytes:
                serializeAssetThreadBindings(
                  next,
                ),
            };
          },
      };

  return {
    dependencies,
    state,
  };
}

describe("provision-discord-asset-thread CLI", () => {
  it("parses an explicit title and repeated tag flags", () => {
    expect(
      parseProvisionDiscordAssetThreadArguments([
        "node",
        "script",
        "crypto",
        "btc",
        "--title",
        "Bitcoin // $BTC",
        "--tag",
        TAG_ID,
        "--tag",
        "423456789012345678",
      ]),
    ).toEqual({
      packId: "crypto",
      assetId: "btc",
      title: "Bitcoin // $BTC",
      appliedTagIds: [
        TAG_ID,
        "423456789012345678",
      ],
    });
  });

  it("rejects missing titles, duplicate tags, and unknown arguments", () => {
    expect(() =>
      parseProvisionDiscordAssetThreadArguments([
        "node",
        "script",
        "crypto",
        "btc",
      ]),
    ).toThrow(
      ProvisionDiscordAssetThreadCliError,
    );

    expect(() =>
      parseProvisionDiscordAssetThreadArguments([
        "node",
        "script",
        "crypto",
        "btc",
        "--title",
        "Bitcoin",
        "--tag",
        TAG_ID,
        "--tag",
        TAG_ID,
      ]),
    ).toThrow(/Duplicate --tag/);

    expect(() =>
      parseProvisionDiscordAssetThreadArguments([
        "node",
        "script",
        "crypto",
        "btc",
        "--title",
        "Bitcoin",
        "--unknown",
      ]),
    ).toThrow(
      /Unknown or misplaced argument/,
    );
  });

  it("reads the canonical logo, provisions the thread, writes the binding, and closes the session", async () => {
    const target = fixture();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      [
        "node",
        "script",
        "crypto",
        "btc",
        "--title",
        "Bitcoin // $BTC",
        "--tag",
        TAG_ID,
      ],
      "/repo",
      (line) => stdout.push(line),
      (line) => stderr.push(line),
      target.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(target.state).toMatchObject({
      opened: 1,
      closed: 1,
      logoReads: 1,
      deleted: [],
    });
    expect(target.state.created).toEqual([
      {
        forumChannelId: FORUM_ID,
        title: "Bitcoin // $BTC",
        appliedTagIds: [TAG_ID],
        starterLogoBytes: LOGO.bytes,
        starterLogoFilename:
          "btc.png",
      },
    ]);
    expect(target.state.bindings).toEqual([
      {
        path:
          "/repo/config/asset-threads.json",
        packId: "crypto",
        assetId: "btc",
        threadId: THREAD_ID,
      },
    ]);
    expect(stdout.join("\n")).toContain(
      "Provisioned crypto/btc",
    );
  });

  it("does not inspect local files or open Discord when arguments are invalid", async () => {
    const target = fixture();
    const stderr: string[] = [];

    const exitCode = await main(
      [
        "node",
        "script",
        "crypto",
        "btc",
      ],
      "/repo",
      () => undefined,
      (line) => stderr.push(line),
      target.dependencies,
    );

    expect(exitCode).toBe(2);
    expect(target.state).toMatchObject({
      opened: 0,
      closed: 0,
      logoReads: 0,
    });
    expect(stderr).toContain(
      PROVISION_DISCORD_ASSET_THREAD_USAGE,
    );
  });

  it("does not open Discord when canonical logo custody fails", async () => {
    const target = fixture({
      readLogoError:
        new Error("logo missing"),
    });
    const stderr: string[] = [];

    const exitCode = await main(
      [
        "node",
        "script",
        "crypto",
        "btc",
        "--title",
        "Bitcoin // $BTC",
      ],
      "/repo",
      () => undefined,
      (line) => stderr.push(line),
      target.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(target.state).toMatchObject({
      opened: 0,
      closed: 0,
      logoReads: 1,
    });
    expect(stderr.join("\n")).toContain(
      "logo missing",
    );
  });

  it("does not open Discord when the Pack/Asset pair is already bound", async () => {
    const target = fixture({
      existingThreadId: THREAD_ID,
    });
    const stderr: string[] = [];

    const exitCode = await main(
      [
        "node",
        "script",
        "crypto",
        "btc",
        "--title",
        "Bitcoin // $BTC",
      ],
      "/repo",
      () => undefined,
      (line) => stderr.push(line),
      target.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(target.state).toMatchObject({
      opened: 0,
      closed: 0,
      logoReads: 1,
      created: [],
      bindings: [],
    });
    expect(stderr.join("\n")).toContain(
      "already bound",
    );
  });

  it("compensates a binding failure and still closes the Discord session", async () => {
    const target = fixture({
      bindError:
        new Error("binding race"),
    });
    const stderr: string[] = [];

    const exitCode = await main(
      [
        "node",
        "script",
        "crypto",
        "btc",
        "--title",
        "Bitcoin // $BTC",
      ],
      "/repo",
      () => undefined,
      (line) => stderr.push(line),
      target.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(target.state).toMatchObject({
      opened: 1,
      closed: 1,
      deleted: [THREAD_ID],
    });
    expect(stderr.join("\n")).toContain(
      "provisional Discord thread was deleted successfully",
    );
  });
});

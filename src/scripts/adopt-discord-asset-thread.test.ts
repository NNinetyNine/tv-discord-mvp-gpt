import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  DiscordForumSession,
} from "../publish/discord-forum-session.ts";
import {
  parseAssetThreadBindings,
  serializeAssetThreadBindings,
} from "../wiring/asset-threads.ts";
import {
  ADOPT_DISCORD_ASSET_THREAD_USAGE,
  AdoptDiscordAssetThreadCliError,
  main,
  parseAdoptDiscordAssetThreadArguments,
  type AdoptDiscordAssetThreadCliDependencies,
} from "./adopt-discord-asset-thread.ts";

const FORUM_ID = "123456789012345678";
const THREAD_ID = "223456789012345678";

function fixture(
  overrides: Partial<
    AdoptDiscordAssetThreadCliDependencies
  > = {},
): {
  readonly dependencies:
    AdoptDiscordAssetThreadCliDependencies;
  readonly bindings: Array<{
    readonly path: string;
    readonly packId: string;
    readonly assetId: string;
    readonly threadId: string;
  }>;
  readonly state: {
    opened: number;
    closed: number;
  };
} {
  const bindings: Array<{
    readonly path: string;
    readonly packId: string;
    readonly assetId: string;
    readonly threadId: string;
  }> = [];
  const state = {
    opened: 0,
    closed: 0,
  };

  const session: DiscordForumSession = {
    inspectThread: async () => ({
      threadId: THREAD_ID,
      parentId: FORUM_ID,
      name: "Bitcoin // $BTC",
      archived: false,
      locked: false,
      appliedTagIds: Object.freeze([]),
    }),
    close: async () => {
      state.closed += 1;
    },
  };

  const parsed = parseAssetThreadBindings({
    schemaVersion: 1,
    packs: {
      crypto: {
        btc: THREAD_ID,
      },
    },
  });

  const dependencies:
  AdoptDiscordAssetThreadCliDependencies = {
    loadChannels: () => ({
      crypto: FORUM_ID,
    }),
    loadRegistry: () => ({
      lookupByTradingView: () => null,
      all: () => Object.freeze([
        Object.freeze({
          id: "btc",
          tradingView: "BTC",
          display: "Bitcoin",
          currency: "USD",
          channel: "crypto",
        }),
      ]),
    }),
    loadPacks: () => Object.freeze([
      Object.freeze({
        id: "crypto",
        display: "Crypto",
        channel: "crypto",
        assets: Object.freeze(["btc"]),
      }),
    ]),
    buildChannelResolver:
      (channels) =>
        (channelName) => {
          const value = channels[channelName];
          return typeof value === "string"
            ? value
            : null;
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
        bindings.push({
          path,
          packId,
          assetId,
          threadId,
        });

        return {
          changed: true,
          bindings: parsed,
          bytes:
            serializeAssetThreadBindings(
              parsed,
            ),
        };
      },
    ...overrides,
  };

  return {
    dependencies,
    bindings,
    state,
  };
}

describe("adopt-discord-asset-thread CLI", () => {
  it("parses the exact positional adoption command", () => {
    expect(
      parseAdoptDiscordAssetThreadArguments([
        "node",
        "script",
        "crypto",
        "btc",
        THREAD_ID,
      ]),
    ).toEqual({
      packId: "crypto",
      assetId: "btc",
      threadId: THREAD_ID,
    });
  });

  it("rejects missing arguments and malformed snowflakes", () => {
    expect(() =>
      parseAdoptDiscordAssetThreadArguments([
        "node",
        "script",
      ]),
    ).toThrow(
      AdoptDiscordAssetThreadCliError,
    );

    expect(() =>
      parseAdoptDiscordAssetThreadArguments([
        "node",
        "script",
        "crypto",
        "btc",
        "bad-thread",
      ]),
    ).toThrow(/Discord snowflake/);
  });

  it("adopts through the read-only session, writes the binding, and always closes", async () => {
    const target = fixture();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      [
        "node",
        "script",
        "crypto",
        "btc",
        THREAD_ID,
      ],
      "/repo",
      (line) => stdout.push(line),
      (line) => stderr.push(line),
      target.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(target.state).toEqual({
      opened: 1,
      closed: 1,
    });
    expect(target.bindings).toEqual([
      {
        path:
          "/repo/config/asset-threads.json",
        packId: "crypto",
        assetId: "btc",
        threadId: THREAD_ID,
      },
    ]);
    expect(stdout[0]).toContain(
      "Adopted crypto/btc",
    );
    expect(stdout.join("\n")).toContain(
      "Existing title preserved: Bitcoin // $BTC",
    );
  });

  it("does not open Discord when local arguments are invalid", async () => {
    const target = fixture();
    const stderr: string[] = [];

    const exitCode = await main(
      [
        "node",
        "script",
        "crypto",
      ],
      "/repo",
      () => undefined,
      (line) => stderr.push(line),
      target.dependencies,
    );

    expect(exitCode).toBe(2);
    expect(target.state).toEqual({
      opened: 0,
      closed: 0,
    });
    expect(stderr).toContain(
      ADOPT_DISCORD_ASSET_THREAD_USAGE,
    );
  });

  it("refuses a thread from another forum without writing a binding", async () => {
    const target = fixture({
      openSession: async () => {
        target.state.opened += 1;

        return {
          inspectThread: async () => ({
            threadId: THREAD_ID,
            parentId:
              "323456789012345678",
            name: "Wrong forum",
            archived: false,
            locked: false,
            appliedTagIds:
              Object.freeze([]),
          }),
          close: async () => {
            target.state.closed += 1;
          },
        };
      },
    });
    const stderr: string[] = [];

    const exitCode = await main(
      [
        "node",
        "script",
        "crypto",
        "btc",
        THREAD_ID,
      ],
      "/repo",
      () => undefined,
      (line) => stderr.push(line),
      target.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(target.bindings).toEqual([]);
    expect(target.state).toEqual({
      opened: 1,
      closed: 1,
    });
    expect(stderr.join("\n")).toContain(
      "not Pack \"crypto\" forum",
    );
  });
});

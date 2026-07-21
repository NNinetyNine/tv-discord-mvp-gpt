import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssetThreadsError,
  buildAssetThreadResolver,
  loadAssetThreadBindings,
  loadAssetThreadResolver,
  parseAssetThreadBindings,
} from "./asset-threads.ts";

const BTC_THREAD = "123456789012345678";
const ETH_THREAD = "223456789012345678";
const OTHER_BTC_THREAD = "323456789012345678";

const temporaryDirectories: string[] = [];

function temporaryFile(value: unknown): string {
  const directory = mkdtempSync(
    join(tmpdir(), "asset-thread-bindings-test-"),
  );
  temporaryDirectories.push(directory);

  const path = join(directory, "asset-threads.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Asset-thread binding resolution", () => {
  it("resolves a persistent thread from the Pack/Asset composite key", () => {
    const bindings = parseAssetThreadBindings({
      schemaVersion: 1,
      packs: {
        crypto: {
          btc: BTC_THREAD,
          eth: ETH_THREAD,
        },
      },
    });

    const resolve = buildAssetThreadResolver(bindings);

    expect(resolve("crypto", "btc")).toBe(BTC_THREAD);
    expect(resolve("crypto", "eth")).toBe(ETH_THREAD);
  });

  it("permits the same Asset identity to use a different thread in another Pack", () => {
    const bindings = parseAssetThreadBindings({
      schemaVersion: 1,
      packs: {
        crypto: {
          btc: BTC_THREAD,
        },
        macro: {
          btc: OTHER_BTC_THREAD,
        },
      },
    });

    const resolve = buildAssetThreadResolver(bindings);

    expect(resolve("crypto", "btc")).toBe(BTC_THREAD);
    expect(resolve("macro", "btc")).toBe(OTHER_BTC_THREAD);
  });

  it("returns null for an unknown Pack or Asset", () => {
    const bindings = parseAssetThreadBindings({
      schemaVersion: 1,
      packs: {
        crypto: {
          btc: BTC_THREAD,
        },
      },
    });

    const resolve = buildAssetThreadResolver(bindings);

    expect(resolve("crypto", "eth")).toBeNull();
    expect(resolve("stocks", "btc")).toBeNull();
  });
});

describe("Asset-thread binding validation", () => {
  it("loads a valid versioned document from disk", () => {
    const path = temporaryFile({
      schemaVersion: 1,
      packs: {
        crypto: {
          btc: BTC_THREAD,
        },
      },
    });

    const loaded = loadAssetThreadBindings(path);
    const resolve = loadAssetThreadResolver(path);

    expect(loaded.schemaVersion).toBe(1);
    expect(resolve("crypto", "btc")).toBe(BTC_THREAD);
  });

  it("rejects unsupported schema versions", () => {
    expect(() =>
      parseAssetThreadBindings({
        schemaVersion: 2,
        packs: {},
      }),
    ).toThrow(/unsupported schemaVersion/);
  });

  it("rejects extra or missing top-level fields", () => {
    expect(() =>
      parseAssetThreadBindings({
        schemaVersion: 1,
      }),
    ).toThrow(/exactly schemaVersion and packs/);

    expect(() =>
      parseAssetThreadBindings({
        schemaVersion: 1,
        packs: {},
        extra: true,
      }),
    ).toThrow(/exactly schemaVersion and packs/);
  });

  it("rejects malformed Pack and Asset maps", () => {
    expect(() =>
      parseAssetThreadBindings({
        schemaVersion: 1,
        packs: {
          crypto: [],
        },
      }),
    ).toThrow(/packs\.crypto must be a JSON object/);

    expect(() =>
      parseAssetThreadBindings({
        schemaVersion: 1,
        packs: {
          "bad/pack": {},
        },
      }),
    ).toThrow(/unsafe characters/);
  });

  it("rejects invalid Discord thread snowflakes", () => {
    expect(() =>
      parseAssetThreadBindings({
        schemaVersion: 1,
        packs: {
          crypto: {
            btc: "not-a-thread-id",
          },
        },
      }),
    ).toThrow(/must be a Discord snowflake/);
  });

  it("fails loud when the file cannot be read or parsed", () => {
    expect(() =>
      loadAssetThreadBindings("/definitely/not/present.json"),
    ).toThrow(AssetThreadsError);

    const directory = mkdtempSync(
      join(tmpdir(), "asset-thread-bindings-invalid-"),
    );
    temporaryDirectories.push(directory);

    const path = join(directory, "asset-threads.json");
    writeFileSync(path, "{ invalid json", "utf8");

    expect(() => loadAssetThreadBindings(path)).toThrow(
      AssetThreadsError,
    );
  });
});

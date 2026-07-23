import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bindAssetThreadFile,
  replaceAssetThreadBindingFile,
  unbindAssetThreadFile,
} from "./asset-thread-bindings-file.ts";
import {
  loadAssetThreadBindings,
  serializeAssetThreadBindings,
} from "./asset-threads.ts";

const BTC_THREAD = "123456789012345678";
const ETH_THREAD = "223456789012345678";
const OTHER_BTC_THREAD = "323456789012345678";

const temporaryDirectories: string[] = [];

async function fixture(
  value: unknown,
): Promise<{
  readonly directory: string;
  readonly path: string;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "asset-thread-file-test-"),
  );
  temporaryDirectories.push(directory);

  const path = join(
    directory,
    "asset-threads.json",
  );
  await writeFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );

  return Object.freeze({ directory, path });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) =>
        rm(directory, {
          recursive: true,
          force: true,
        }),
    ),
  );
});

describe("Asset-thread binding file updates", () => {
  it("atomically adds one canonical binding and preserves file mode", async () => {
    const target = await fixture({
      schemaVersion: 1,
      packs: {},
    });
    await chmod(target.path, 0o640);

    const result = await bindAssetThreadFile(
      target.path,
      "crypto",
      "btc",
      BTC_THREAD,
    );

    expect(result.changed).toBe(true);
    expect(
      loadAssetThreadBindings(target.path)
        .packs.crypto?.btc,
    ).toBe(BTC_THREAD);
    expect(
      await readFile(target.path),
    ).toEqual(
      serializeAssetThreadBindings(
        result.bindings,
      ),
    );
    expect(
      Number(
        (await lstat(
          target.path,
          { bigint: true },
        )).mode & 0o777n,
      ),
    ).toBe(0o640);
    expect(await readdir(target.directory)).toEqual([
      "asset-threads.json",
    ]);
  });

  it("performs no replacement for an identical binding", async () => {
    const target = await fixture({
      schemaVersion: 1,
      packs: {
        crypto: {
          btc: BTC_THREAD,
        },
      },
    });
    const before = await lstat(
      target.path,
      { bigint: true },
    );
    let beforeReplaceCalled = false;

    const result = await bindAssetThreadFile(
      target.path,
      "crypto",
      "btc",
      BTC_THREAD,
      {
        beforeReplace: async () => {
          beforeReplaceCalled = true;
        },
      },
    );

    const after = await lstat(
      target.path,
      { bigint: true },
    );

    expect(result.changed).toBe(false);
    expect(beforeReplaceCalled).toBe(false);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it("refuses conflicting rebinding without changing the file", async () => {
    const target = await fixture({
      schemaVersion: 1,
      packs: {
        crypto: {
          btc: BTC_THREAD,
        },
      },
    });
    const before = await readFile(target.path);

    await expect(
      bindAssetThreadFile(
        target.path,
        "crypto",
        "btc",
        ETH_THREAD,
      ),
    ).rejects.toThrow(/already bound/);

    expect(await readFile(target.path)).toEqual(
      before,
    );
    expect(await readdir(target.directory)).toEqual([
      "asset-threads.json",
    ]);
  });

  it("detects a source change before replacement and preserves the newer file", async () => {
    const target = await fixture({
      schemaVersion: 1,
      packs: {},
    });
    const concurrent = Buffer.from(
      [
        "{",
        '  "schemaVersion": 1,',
        '  "packs": {',
        '    "crypto": {',
        `      "eth": "${ETH_THREAD}"`,
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      bindAssetThreadFile(
        target.path,
        "crypto",
        "btc",
        BTC_THREAD,
        {
          beforeReplace: async () => {
            await writeFile(
              target.path,
              concurrent,
            );
          },
        },
      ),
    ).rejects.toThrow(/changed during binding update/);

    expect(await readFile(target.path)).toEqual(
      concurrent,
    );
    expect(await readdir(target.directory)).toEqual([
      "asset-threads.json",
    ]);
  });

  it("rejects a symbolic-link binding file", async () => {
    const target = await fixture({
      schemaVersion: 1,
      packs: {},
    });
    const linked = join(
      target.directory,
      "linked-asset-threads.json",
    );
    await symlink(target.path, linked);

    await expect(
      bindAssetThreadFile(
        linked,
        "crypto",
        "btc",
        BTC_THREAD,
      ),
    ).rejects.toThrow(/regular non-symlink file/);

    expect(
      loadAssetThreadBindings(target.path)
        .packs,
    ).toEqual({});
  });

  it("atomically replaces and removes one exact binding", async () => {
    const target = await fixture({
      schemaVersion: 1,
      packs: {
        crypto: {
          btc: BTC_THREAD,
          eth: ETH_THREAD,
        },
      },
    });
    const replaced = await replaceAssetThreadBindingFile(
      target.path,
      "crypto",
      "btc",
      BTC_THREAD,
      OTHER_BTC_THREAD,
    );
    expect(replaced.changed).toBe(true);
    expect(loadAssetThreadBindings(target.path).packs.crypto).toEqual({
      btc: OTHER_BTC_THREAD,
      eth: ETH_THREAD,
    });

    const removed = await unbindAssetThreadFile(
      target.path,
      "crypto",
      "btc",
      OTHER_BTC_THREAD,
    );
    expect(removed.changed).toBe(true);
    expect(loadAssetThreadBindings(target.path).packs.crypto).toEqual({
      eth: ETH_THREAD,
    });
  });

  it("rejects stale replacement and removal without changing source bytes", async () => {
    const target = await fixture({
      schemaVersion: 1,
      packs: { crypto: { btc: BTC_THREAD } },
    });
    const before = await readFile(target.path);
    await expect(replaceAssetThreadBindingFile(
      target.path,
      "crypto",
      "btc",
      OTHER_BTC_THREAD,
      ETH_THREAD,
    )).rejects.toThrow(/changed from expected thread/);
    await expect(unbindAssetThreadFile(
      target.path,
      "crypto",
      "btc",
      OTHER_BTC_THREAD,
    )).rejects.toThrow(/changed from expected thread/);
    expect(await readFile(target.path)).toEqual(before);
  });
});

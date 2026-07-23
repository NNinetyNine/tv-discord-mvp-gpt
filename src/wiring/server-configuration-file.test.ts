import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyServerConfigurationFile,
  ServerConfigurationFileError,
} from "./server-configuration-file.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visionx-server-config-file-"));
  cleanup.push(root);
  await cp(resolve("config"), join(root, "config"), { recursive: true });
  return root;
}

describe("server-configuration source transaction", () => {
  it("changes channels through a rollback-protected transaction while preserving thread-binding bytes", async () => {
    const root = await repository();
    const channelsPath = join(root, "config/channels.json");
    const bindingsPath = join(root, "config/asset-threads.json");
    const channelsBefore = await readFile(channelsPath);
    const bindingsBefore = await readFile(bindingsPath);
    const channels = JSON.parse(channelsBefore.toString("utf8")) as Record<string, string>;
    channels.stocks = "177777777777777777";
    const channelsAfter = Buffer.from(`${JSON.stringify(channels, null, 2)}\n`, "utf8");

    const result = await applyServerConfigurationFile({
      repositoryRoot: root,
      expectedChannelsSha256: sha256(channelsBefore),
      expectedThreadBindingsSha256: sha256(bindingsBefore),
      channelsAfterBytes: channelsAfter,
      threadBindingsAfterBytes: bindingsBefore,
    });

    expect(await readFile(channelsPath)).toEqual(channelsAfter);
    expect(await readFile(bindingsPath)).toEqual(bindingsBefore);
    expect(result).toEqual({
      channelsSha256: sha256(channelsAfter),
      threadBindingsSha256: sha256(bindingsBefore),
    });
  });

  it("fails closed when either reviewed source hash is stale", async () => {
    const root = await repository();
    const channels = await readFile(join(root, "config/channels.json"));
    const bindings = await readFile(join(root, "config/asset-threads.json"));
    await expect(applyServerConfigurationFile({
      repositoryRoot: root,
      expectedChannelsSha256: "0".repeat(64),
      expectedThreadBindingsSha256: sha256(bindings),
      channelsAfterBytes: channels,
      threadBindingsAfterBytes: bindings,
    })).rejects.toMatchObject({ code: "stale_source_state" } satisfies Partial<ServerConfigurationFileError>);
  });

  it("rejects malformed or duplicate Discord destinations before any source replacement", async () => {
    const root = await repository();
    const channelsPath = join(root, "config/channels.json");
    const bindingsPath = join(root, "config/asset-threads.json");
    const channelsBefore = await readFile(channelsPath);
    const bindingsBefore = await readFile(bindingsPath);
    const channels = JSON.parse(channelsBefore.toString("utf8")) as Record<string, string>;
    channels.stocks = channels.crypto ?? "";
    const invalid = Buffer.from(`${JSON.stringify(channels, null, 2)}\n`, "utf8");

    await expect(applyServerConfigurationFile({
      repositoryRoot: root,
      expectedChannelsSha256: sha256(channelsBefore),
      expectedThreadBindingsSha256: sha256(bindingsBefore),
      channelsAfterBytes: invalid,
      threadBindingsAfterBytes: bindingsBefore,
    })).rejects.toMatchObject({ code: "invalid_candidate" } satisfies Partial<ServerConfigurationFileError>);
    expect(await readFile(channelsPath)).toEqual(channelsBefore);
    expect(await readFile(bindingsPath)).toEqual(bindingsBefore);
  });
});

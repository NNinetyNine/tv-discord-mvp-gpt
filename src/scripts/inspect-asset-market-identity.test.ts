import { describe, expect, it } from "vitest";

import { main } from "./inspect-asset-market-identity.ts";

describe("inspect-asset-market-identity CLI", () => {
  it("prints exactly one deterministic structured audit and exits nonzero for current gaps", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(["node", "script"], (line) => stdout.push(line), (line) => stderr.push(line));
    expect(exit).toBe(1);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);
    const result = JSON.parse(stdout[0] ?? "{}") as {
      ok?: boolean;
      registryAssetCount?: number;
      assets?: Array<{ assetId: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.assets?.length).toBe(result.registryAssetCount);
    for (const id of ["aem", "lac", "paas", "nem", "race", "vwra"]) {
      expect(result.assets?.find((asset) => asset.assetId === id)).toMatchObject({ assetId: id });
    }
  });

  it("rejects positional and unknown arguments", async () => {
    for (const argument of ["file", "--unknown"]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(await main(["node", "script", argument], (line) => stdout.push(line), (line) => stderr.push(line))).toBe(2);
      expect(stdout).toEqual([]);
      expect(stderr.length).toBeGreaterThan(0);
    }
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { main, parseProposeAssetRegistrationArguments } from "./propose-asset-registration.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("propose-asset-registration CLI", () => {
  it("rejects positional, unknown, duplicate, and missing arguments", () => {
    expect(parseProposeAssetRegistrationArguments(["node", "script", "x"])).toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(parseProposeAssetRegistrationArguments(["node", "script", "--nope", "x"])).toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(parseProposeAssetRegistrationArguments(["node", "script", "--input", "a", "--input", "b", "--output", "c"])).toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(parseProposeAssetRegistrationArguments(["node", "script", "--input", "a"])).toMatchObject({ ok: false, reason: "invalid_arguments" });
  });

  it("prints exactly one structured v2 success result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "visionx-proposal-cli-"));
    dirs.push(dir);
    const input = join(dir, "input.json");
    const output = join(dir, "output.json");
    writeFileSync(input, JSON.stringify({
      schemaVersion: 2,
      operation: "add",
      asset: {
        id: "example_asset",
        displayName: "Example Asset",
        symbol: "EXAMPLE",
        market: "NASDAQ",
        tradingViewSymbol: "NASDAQ:EXAMPLE",
        currency: "USD",
        channel: "stocks",
      },
      targetPackIds: [],
      decision: {
        reviewerId: "visionx-curator",
        decidedAt: "2026-07-17T22:30:00Z",
        referenceId: "visionx.asset-registration.example-channel-v2",
        notes: "Schema demonstration only.",
      },
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(["node", "script", "--input", input, "--output", output], (line) => stdout.push(line), (line) => stderr.push(line));
    expect(exit).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({ ok: true, proposal: { schemaVersion: 2, asset: { channel: "stocks" }, applicationStatus: "not_applied" } });
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ schemaVersion: 2, applicationStatus: "not_applied" });
  });

  it("returns nonzero when explicit channel is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "visionx-proposal-cli-missing-channel-"));
    dirs.push(dir);
    const input = join(dir, "input.json");
    const output = join(dir, "output.json");
    writeFileSync(input, JSON.stringify({
      schemaVersion: 2,
      operation: "add",
      asset: { id: "example_asset", displayName: "Example Asset", symbol: "EXAMPLE", market: "NASDAQ", tradingViewSymbol: "NASDAQ:EXAMPLE", currency: "USD" },
      targetPackIds: [],
      decision: { reviewerId: "visionx-curator", decidedAt: "2026-07-17T22:30:00Z", referenceId: "visionx.asset-registration.example-channel-v2" },
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(["node", "script", "--input", input, "--output", output], (line) => stdout.push(line), (line) => stderr.push(line));
    expect(exit).toBe(1);
    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(1);
  });
});

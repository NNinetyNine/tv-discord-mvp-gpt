import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { proposeAssetRegistrationFile } from "./asset-registration-proposal-file.ts";

const INPUT = {
  schemaVersion: 1,
  operation: "add",
  asset: {
    id: "example_asset",
    displayName: "Example Asset",
    symbol: "EXAMPLE",
    market: "NASDAQ",
    tradingViewSymbol: "NASDAQ:EXAMPLE",
    currency: "USD",
  },
  targetPackIds: [],
  decision: {
    reviewerId: "visionx-curator",
    decidedAt: "2026-07-17T22:30:00Z",
    referenceId: "visionx.asset-registration.example-v1",
    notes: "Schema demonstration only.",
  },
};

describe("Asset registration proposal file custody", () => {
  let dir: string;
  let inputPath: string;
  let outputPath: string;
  let registryPath: string;
  let packsPath: string;
  let channelsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-asset-proposal-"));
    inputPath = join(dir, "input.json");
    outputPath = join(dir, "proposal.json");
    registryPath = join(dir, "registry.json");
    packsPath = join(dir, "packs.json");
    channelsPath = join(dir, "channels.json");
    writeFileSync(inputPath, `${JSON.stringify(INPUT, null, 2)}\n`);
    writeFileSync(registryPath, JSON.stringify({ btc: { tradingView: "BTC", display: "Bitcoin", channel: "crypto" } }));
    writeFileSync(packsPath, JSON.stringify([{ id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] }]));
    writeFileSync(channelsPath, JSON.stringify({ crypto: "" }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const options = () => ({ inputPath, outputPath, registryPath, packsPath, channelsPath });

  it("writes deterministic output and preserves the input bytes", async () => {
    const before = readFileSync(inputPath);
    const result = await proposeAssetRegistrationFile(options());
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(inputPath).equals(before)).toBe(true);
    const bytes = readFileSync(outputPath);
    expect(bytes.at(-1)).toBe(10);
    expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({ applicationStatus: "not_applied" });
  });

  it("rejects input/output collision", async () => {
    expect(await proposeAssetRegistrationFile({ ...options(), outputPath: inputPath })).toMatchObject({ ok: false, reason: "path_collision" });
  });

  it("does not overwrite existing output", async () => {
    writeFileSync(outputPath, "keep");
    expect(await proposeAssetRegistrationFile(options())).toMatchObject({ ok: false, reason: "output_already_exists" });
    expect(readFileSync(outputPath, "utf8")).toBe("keep");
  });

  it("leaves no temporary file after invalid input", async () => {
    writeFileSync(inputPath, "{");
    expect(await proposeAssetRegistrationFile(options())).toMatchObject({ ok: false, reason: "unreadable_registration_input" });
    expect(readFileSync(inputPath, "utf8")).toBe("{");
  });
});

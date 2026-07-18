import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPacks } from "../packs/packs.ts";
import { buildRegistry } from "./registry.ts";
import { proposeAssetRegistration, serializeAssetRegistrationProposal } from "./asset-registration-proposal.ts";
import { planAssetRegistrationApplicationFile } from "./asset-registration-application-plan-file.ts";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const REGISTRY_JSON = {
  btc: { tradingView: "BTC", display: "Bitcoin", channel: "crypto" },
};
const PACKS_JSON = [
  { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] },
];
const CHANNELS_JSON = { crypto: "1527846955668078663", stocks: "1527846988270534827" };

const INPUT = {
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
};

describe("Asset registration application-plan file custody", () => {
  let dir: string;
  let proposalPath: string;
  let authorizationPath: string;
  let outputPath: string;
  let registryPath: string;
  let packsPath: string;
  let channelsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "visionx-asset-plan-"));
    proposalPath = join(dir, "proposal.json");
    authorizationPath = join(dir, "authorization.json");
    outputPath = join(dir, "plan.json");
    registryPath = join(dir, "registry.json");
    packsPath = join(dir, "packs.json");
    channelsPath = join(dir, "channels.json");
    writeFileSync(registryPath, JSON.stringify(REGISTRY_JSON));
    writeFileSync(packsPath, JSON.stringify(PACKS_JSON));
    writeFileSync(channelsPath, JSON.stringify(CHANNELS_JSON));
    const registry = buildRegistry(REGISTRY_JSON, CHANNELS_JSON);
    const packs = buildPacks(PACKS_JSON, new Set(["btc"]), new Set(["crypto"]));
    const proposed = proposeAssetRegistration(INPUT, registry.all(), packs, CHANNELS_JSON);
    if (!proposed.ok) throw new Error(proposed.detail);
    const proposalBytes = serializeAssetRegistrationProposal(proposed.proposal);
    writeFileSync(proposalPath, proposalBytes);
    writeFileSync(authorizationPath, `${JSON.stringify({
      schemaVersion: 1,
      decision: "approved",
      proposalSha256: sha(proposalBytes),
      reviewerId: "visionx-curator",
      decidedAt: "2026-07-18T00:30:00Z",
      referenceId: "visionx.asset-application.example-channel-v2",
      packPlacements: [],
      notes: "Authorize planning only.",
    }, null, 2)}\n`);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const options = () => ({ proposalPath, authorizationPath, outputPath, registryPath, packsPath, channelsPath });

  it("writes deterministic output and preserves both inputs", async () => {
    const proposalBefore = readFileSync(proposalPath);
    const authorizationBefore = readFileSync(authorizationPath);
    const result = await planAssetRegistrationApplicationFile(options());
    expect(result).toMatchObject({ ok: true, plan: { applicationAuthorized: true, sourceChangesApplied: false } });
    expect(readFileSync(proposalPath).equals(proposalBefore)).toBe(true);
    expect(readFileSync(authorizationPath).equals(authorizationBefore)).toBe(true);
    const output = readFileSync(outputPath);
    expect(output.at(-1)).toBe(10);
    expect(JSON.parse(output.toString("utf8"))).toMatchObject({ applicationStatus: "planned_not_applied" });
  });

  it("produces byte-identical plan bytes across caller path locations", async () => {
    const secondProposalPath = join(dir, "renamed-proposal.json");
    const secondAuthorizationPath = join(dir, "renamed-authorization.json");
    const secondOutputPath = join(dir, "renamed-plan.json");
    writeFileSync(secondProposalPath, readFileSync(proposalPath));
    writeFileSync(secondAuthorizationPath, readFileSync(authorizationPath));

    expect(await planAssetRegistrationApplicationFile(options())).toMatchObject({ ok: true });
    expect(await planAssetRegistrationApplicationFile({
      ...options(),
      proposalPath: secondProposalPath,
      authorizationPath: secondAuthorizationPath,
      outputPath: secondOutputPath,
    })).toMatchObject({ ok: true });

    expect(readFileSync(secondOutputPath).equals(readFileSync(outputPath))).toBe(true);
  });

  it("rejects input collisions and existing output without overwrite", async () => {
    expect(await planAssetRegistrationApplicationFile({ ...options(), outputPath: proposalPath })).toMatchObject({ ok: false, reason: "path_collision" });
    expect(await planAssetRegistrationApplicationFile({ ...options(), authorizationPath: proposalPath })).toMatchObject({ ok: false, reason: "path_collision" });
    writeFileSync(outputPath, "keep");
    expect(await planAssetRegistrationApplicationFile(options())).toMatchObject({ ok: false, reason: "output_already_exists" });
    expect(readFileSync(outputPath, "utf8")).toBe("keep");
  });

  it("distinguishes malformed proposal and authorization JSON", async () => {
    writeFileSync(proposalPath, "{");
    expect(await planAssetRegistrationApplicationFile(options())).toMatchObject({ ok: false, reason: "unreadable_proposal" });
    writeFileSync(proposalPath, "{}");
    writeFileSync(authorizationPath, "{");
    expect(await planAssetRegistrationApplicationFile(options())).toMatchObject({ ok: false, reason: "unreadable_authorization" });
  });

  it("cleans temporary files and fails when an input changes before finalization", async () => {
    const result = await planAssetRegistrationApplicationFile(options(), {
      beforeFinalize: async () => {
        writeFileSync(authorizationPath, `${readFileSync(authorizationPath, "utf8")} `);
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "input_changed_during_planning" });
    expect(readdirSync(dir).some((name) => name.includes("visionx-asset-plan"))).toBe(false);
    expect(() => readFileSync(outputPath)).toThrow();
  });
});

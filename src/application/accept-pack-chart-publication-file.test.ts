import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkspace } from "../packs/workspace.ts";
import { createStagingStore } from "../wiring/staging.ts";
import { acceptPackChartPublicationFile } from "./accept-pack-chart-publication-file.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-pack-chart-accept-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidence(label: string): {
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly output: Buffer;
} {
  const outputPath = join(root, `${label}.png`);
  const receiptPath = join(root, `${label}.json`);
  const output = Buffer.alloc(24_000, label.charCodeAt(0));
  writeFileSync(outputPath, output);
  writeFileSync(receiptPath, Buffer.from('{"receipt":true}\n'));
  return { outputPath, receiptPath, output };
}

function options(files: ReturnType<typeof evidence>) {
  return {
    sourceBasename: "BTCUSD_2026-07-22_18-58-01.png",
    outputPath: files.outputPath,
    receiptPath: files.receiptPath,
    outputBasename: basename(files.outputPath),
    receiptBasename: basename(files.receiptPath),
    outputSha256: sha256(files.output),
    assetId: "btc",
    packId: "crypto",
    timeframe: "1D" as const,
    dataAsOf: "2026-07-22",
  };
}

describe("accept Pack chart publication file", () => {
  it("re-verifies stored evidence before staging and recording Pack progress", async () => {
    const files = evidence("publication");
    const workspace = createWorkspace([
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc", "eth"] },
    ]);
    const staging = createStagingStore(join(root, "staging"));
    const validate = vi.fn(() => ({ ok: true, checks: { readable: true } }));

    const result = await acceptPackChartPublicationFile(options(files), {
      workspace,
      staging,
      validate,
      now: () => "2026-07-22T21:00:00.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "staged_render",
      assetId: "btc",
      revisions: 1,
      packState: "building",
      capturedCount: 1,
      totalCount: 2,
      remainingRequiredAssetIds: ["eth"],
    });
    expect(validate).toHaveBeenCalledWith(files.outputPath);
    expect(readFileSync(staging.get("btc")!.path)).toEqual(files.output);
    expect(workspace.captureOf("btc")).toEqual({
      assetId: "btc",
      capturedAt: "2026-07-22T21:00:00.000Z",
      revisions: 1,
    });
  });

  it("rejects changed render evidence without validation, staging, or Workspace mutation", async () => {
    const files = evidence("publication");
    const expected = options(files);
    writeFileSync(files.outputPath, Buffer.from("changed after preview"));
    const workspace = createWorkspace([
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] },
    ]);
    const staging = createStagingStore(join(root, "staging"));
    const validate = vi.fn(() => ({ ok: true, checks: { readable: true } }));

    const result = await acceptPackChartPublicationFile(expected, {
      workspace,
      staging,
      validate,
      now: () => "2026-07-22T21:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: false, outcome: "artifact_verification_failed" });
    expect(validate).not.toHaveBeenCalled();
    expect(staging.list()).toEqual([]);
    expect(workspace.captures()).toEqual([]);
  });

  it("leaves current revision and staged bytes unchanged when replacement validation fails", async () => {
    const first = evidence("first");
    const second = evidence("second");
    const workspace = createWorkspace([
      { id: "crypto", display: "Crypto", channel: "crypto", assets: ["btc"] },
    ], [{ assetId: "btc", capturedAt: "2026-07-21T00:00:00.000Z", revisions: 1 }]);
    const staging = createStagingStore(join(root, "staging"));
    staging.stage("btc", first.outputPath);

    const result = await acceptPackChartPublicationFile(options(second), {
      workspace,
      staging,
      validate: () => ({ ok: false, checks: { notBlank: false }, reason: "blank" }),
      now: () => "2026-07-22T21:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: false, outcome: "validation_failed", reason: "blank" });
    expect(readFileSync(staging.get("btc")!.path)).toEqual(first.output);
    expect(workspace.captureOf("btc")?.revisions).toBe(1);
  });
});

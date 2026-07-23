import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { AdminThreadProvisioningWorkspace } from "./admin-thread-provisioning-workspace.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<AdminThreadProvisioningWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "visionx-thread-provisioning-"));
  cleanup.push(root);
  return AdminThreadProvisioningWorkspace.open(root);
}

async function squarePng(size = 96, red = 24): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: red, g: 48, b: 72, alpha: 1 },
    },
  }).png().toBuffer();
}

async function rectangularPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 96,
      height: 72,
      channels: 4,
      background: { r: 24, g: 48, b: 72, alpha: 0 },
    },
  }).png().toBuffer();
}

describe("Administration thread-provisioning logo workspace", () => {
  it("stages and rereads exact validated logo evidence beneath Pack/Asset identity", async () => {
    const target = await workspace();
    const bytes = await squarePng();
    const staged = await target.saveLogo("crypto", "akt", bytes);
    const read = await target.readLogo("crypto", "akt", staged.evidence.sha256);

    expect(staged).toMatchObject({
      packId: "crypto",
      assetId: "akt",
      evidence: { format: "png", width: 96, height: 96, byteSize: bytes.length },
    });
    expect(read.bytes).toEqual(bytes);
    expect(read.evidence).toEqual(staged.evidence);
    expect(read.path.startsWith(target.root)).toBe(true);
  });

  it("stages a rectangular transparent PNG without changing its bytes", async () => {
    const target = await workspace();
    const bytes = await rectangularPng();
    const staged = await target.saveLogo("crypto", "pepe", bytes);
    const read = await target.readLogo("crypto", "pepe", staged.evidence.sha256);

    expect(staged.evidence).toMatchObject({
      format: "png",
      width: 96,
      height: 72,
      hasAlpha: true,
    });
    expect(read.bytes).toEqual(bytes);
  });

  it("atomically replaces a staged logo while requiring the newly reviewed hash", async () => {
    const target = await workspace();
    const first = await target.saveLogo("crypto", "akt", await squarePng(96, 24));
    const second = await target.saveLogo("crypto", "akt", await squarePng(96, 96));

    expect(second.evidence.sha256).not.toBe(first.evidence.sha256);
    await expect(target.readLogo("crypto", "akt", first.evidence.sha256)).rejects.toMatchObject({
      code: "thread_provisioning_logo_mismatch",
      status: 409,
    });
    await expect(target.readLogo("crypto", "akt", second.evidence.sha256)).resolves.toMatchObject({
      evidence: { sha256: second.evidence.sha256 },
    });
  });

  it("rejects invalid image bytes before creating usable custody", async () => {
    const target = await workspace();
    await expect(target.saveLogo("crypto", "akt", Buffer.from("not-png"))).rejects.toMatchObject({
      code: "invalid_asset_logo",
      status: 400,
    });
    await expect(target.readLogo("crypto", "akt", "a".repeat(64))).rejects.toMatchObject({
      code: "thread_provisioning_logo_not_found",
      status: 404,
    });
  });

  it("rejects unsafe identities before filesystem use", async () => {
    const target = await workspace();
    await expect(target.saveLogo("../crypto", "akt", await squarePng())).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(target.readLogo("crypto", "../akt", "a".repeat(64))).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

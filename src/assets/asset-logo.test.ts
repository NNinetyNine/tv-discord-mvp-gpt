import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  ASSET_LOGO_POLICY,
  validateAssetLogo,
} from "./asset-logo.ts";

async function makeImage(
  format: "png" | "jpeg",
  width: number,
  height: number,
  alpha = true,
): Promise<Buffer> {
  const channels = alpha ? 4 : 3;
  const pixels = Buffer.alloc(width * height * channels);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * channels;
    pixels[offset] = (pixel * 17) % 256;
    pixels[offset + 1] = (pixel * 31) % 256;
    pixels[offset + 2] = (pixel * 47) % 256;
    if (alpha) pixels[offset + 3] = 128 + (pixel % 128);
  }

  const image = sharp(pixels, {
    raw: { width, height, channels },
  });

  return format === "png"
    ? image.png().toBuffer()
    : image.jpeg().toBuffer();
}

describe("validateAssetLogo", () => {
  it("accepts one PNG and returns deterministic path-neutral facts", async () => {
    const bytes = await makeImage("png", 128, 128);

    const first = await validateAssetLogo(bytes);
    const second = await validateAssetLogo(Buffer.from(bytes));

    expect(first).toEqual({
      ok: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      format: "png",
      width: 128,
      height: 128,
      pageOrFrameCount: 1,
      channelCount: 4,
      hasAlpha: true,
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/path|directory|filename/iu);
  });

  it("rejects an empty file before image decoding", async () => {
    await expect(validateAssetLogo(Buffer.alloc(0))).resolves.toMatchObject({
      ok: false,
      reason: "empty_file",
    });
  });

  it("rejects bytes above the explicit upload limit", async () => {
    const bytes = Buffer.alloc(ASSET_LOGO_POLICY.maximumBytes + 1);

    await expect(validateAssetLogo(bytes)).resolves.toMatchObject({
      ok: false,
      reason: "file_too_large",
    });
  });

  it("rejects corrupt image bytes", async () => {
    await expect(
      validateAssetLogo(Buffer.from("not an image", "utf8")),
    ).resolves.toMatchObject({
      ok: false,
      reason: "unreadable_image",
    });
  });

  it("rejects a decodable non-PNG image", async () => {
    const bytes = await makeImage("jpeg", 128, 128, false);

    await expect(validateAssetLogo(bytes)).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_format",
    });
  });

  it("rejects dimensions below the minimum", async () => {
    const bytes = await makeImage(
      "png",
      ASSET_LOGO_POLICY.minimumDimension - 1,
      ASSET_LOGO_POLICY.minimumDimension - 1,
    );

    await expect(validateAssetLogo(bytes)).resolves.toMatchObject({
      ok: false,
      reason: "dimensions_too_small",
    });
  });

  it("rejects dimensions above the maximum", async () => {
    const bytes = await makeImage(
      "png",
      ASSET_LOGO_POLICY.maximumDimension + 1,
      ASSET_LOGO_POLICY.maximumDimension + 1,
      false,
    );

    await expect(validateAssetLogo(bytes)).resolves.toMatchObject({
      ok: false,
      reason: "dimensions_too_large",
    });
  });

  it("accepts a rectangular transparent PNG", async () => {
    const bytes = await makeImage("png", 128, 96);

    await expect(validateAssetLogo(bytes)).resolves.toMatchObject({
      ok: true,
      format: "png",
      width: 128,
      height: 96,
      pageOrFrameCount: 1,
      channelCount: 4,
      hasAlpha: true,
    });
  });
});

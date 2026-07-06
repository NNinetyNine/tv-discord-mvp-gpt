import { existsSync } from "node:fs";
import { resolve } from "node:path";

import sharp from "sharp";

import { logger } from "../logger.ts";

const LOGO_PATH = resolve(process.cwd(), "assets", "visionx-logo.png");
const LOGO_TARGET_WIDTH = Number(process.env.BRANDING_LOGO_WIDTH ?? 220);
const PADDING = Number(process.env.BRANDING_PADDING ?? 24);

export async function applyBranding(imagePath: string): Promise<void> {
  if (!existsSync(LOGO_PATH)) {
    logger.warn({ logoPath: LOGO_PATH }, "branding logo not found; skipping overlay");
    return;
  }

  try {
    const base = sharp(imagePath);
    const meta = await base.metadata();

    const baseWidth = meta.width ?? 1920;

    const logo = await sharp(LOGO_PATH)
      .resize({ width: LOGO_TARGET_WIDTH })
      .png()
      .toBuffer();

    const logoMeta = await sharp(logo).metadata();
    const logoWidth = logoMeta.width ?? LOGO_TARGET_WIDTH;

    const left = Math.max(0, baseWidth - logoWidth - PADDING);
    const top = PADDING;

    const composited = await base
      .composite([
        {
          input: logo,
          left,
          top,
        },
      ])
      .png()
      .toBuffer();

    await sharp(composited).toFile(imagePath);

    logger.debug({ imagePath, left, top, logoWidth }, "branding overlay applied");
  } catch (e) {
    logger.warn(
      { error: e instanceof Error ? e.message : String(e) },
      "branding overlay failed; leaving original screenshot",
    );
  }
}
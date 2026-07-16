import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ImageInspectionError,
  inspectImageFile,
  inspectImageFiles,
} from "./inspect-image.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visionx-image-inspection-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makePng(
  path: string,
  options: { readonly width?: number; readonly height?: number; readonly alpha?: boolean } = {},
): Promise<void> {
  const width = options.width ?? 7;
  const height = options.height ?? 5;
  const alpha = options.alpha ?? false;
  const channels = alpha ? 4 : 3;
  const data = Buffer.alloc(width * height * channels);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * channels;
    data[offset] = (pixel * 17) % 256;
    data[offset + 1] = (pixel * 29) % 256;
    data[offset + 2] = (pixel * 43) % 256;
    if (alpha) data[offset + 3] = 128 + (pixel % 128);
  }

  await sharp(data, { raw: { width, height, channels } }).png().toFile(path);
}

function directoryEntries(path: string): readonly string[] {
  return readdirSync(path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("inspectImageFile — observable image facts", () => {
  it("reports deterministic facts for a known PNG without acceptance semantics", async () => {
    const imagePath = join(root, "AAPL_2026-07-16_10-00-00.png");
    await makePng(imagePath, { width: 11, height: 9 });

    const bytes = readFileSync(imagePath);
    const metadata = await sharp(bytes).metadata();
    const observation = await inspectImageFile(imagePath);

    expect(observation).toEqual({
      originalBasename: "AAPL_2026-07-16_10-00-00.png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      format: "png",
      width: 11,
      height: 9,
      pageOrFrameCount: metadata.pages ?? null,
      channelCount: 3,
      hasAlpha: false,
    });
    expect(Object.keys(observation)).toEqual([
      "originalBasename",
      "sha256",
      "byteSize",
      "format",
      "width",
      "height",
      "pageOrFrameCount",
      "channelCount",
      "hasAlpha",
    ]);
    expect(JSON.stringify(observation)).not.toMatch(
      /accepted|supported|profile|asset|pack|ready|publication/i,
    );
  });

  it("reports the alpha-channel fact when an alpha channel is present", async () => {
    const imagePath = join(root, "alpha.png");
    await makePng(imagePath, { alpha: true });

    const observation = await inspectImageFile(imagePath);

    expect(observation.channelCount).toBe(4);
    expect(observation.hasAlpha).toBe(true);
  });

  it("returns the same observation for repeated inspection of unchanged bytes", async () => {
    const imagePath = join(root, "repeat.png");
    await makePng(imagePath);

    const first = await inspectImageFile(imagePath);
    const second = await inspectImageFile(imagePath);

    expect(second).toEqual(first);
  });

  it("preserves the caller's input order for multiple explicitly supplied paths", async () => {
    const firstPath = join(root, "first.png");
    const secondPath = join(root, "second.png");
    await makePng(firstPath, { width: 4, height: 3 });
    await makePng(secondPath, { width: 8, height: 6 });

    const observations = await inspectImageFiles([secondPath, firstPath]);

    expect(observations.map((observation) => observation.originalBasename)).toEqual([
      "second.png",
      "first.png",
    ]);
    expect(observations.map((observation) => observation.width)).toEqual([8, 4]);
  });

  it("gives byte-identical files equivalent meaning across differently named directories", async () => {
    const desktopDir = join(root, "macbook-desktop-import");
    const uploadDir = join(root, "ipad-upload-temporary");
    mkdirSync(desktopDir);
    mkdirSync(uploadDir);

    const desktopPath = join(desktopDir, "BTCUSD_2026-07-16_10-00-00.png");
    const uploadPath = join(uploadDir, "BTCUSD_2026-07-16_10-00-00.png");
    await makePng(desktopPath, { width: 10, height: 6, alpha: true });
    writeFileSync(uploadPath, readFileSync(desktopPath));

    const [desktop, upload] = await inspectImageFiles([desktopPath, uploadPath]);

    expect(desktop).toEqual(upload);
    expect(JSON.stringify(desktop)).not.toContain("macbook");
    expect(JSON.stringify(upload)).not.toContain("ipad");
  });

  it("leaves source bytes, basename, location, size, and modification time unchanged", async () => {
    const imagePath = join(root, "unchanged.png");
    await makePng(imagePath, { width: 9, height: 7 });

    const beforeBytes = readFileSync(imagePath);
    const beforeStat = statSync(imagePath);
    const beforeEntries = directoryEntries(root);

    await inspectImageFile(imagePath);

    const afterStat = statSync(imagePath);
    expect(existsSync(imagePath)).toBe(true);
    expect(basename(imagePath)).toBe("unchanged.png");
    expect(readFileSync(imagePath)).toEqual(beforeBytes);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(directoryEntries(root)).toEqual(beforeEntries);
  });

  it("fails clearly for a missing explicitly requested file", async () => {
    const missing = join(root, "missing.png");

    await expect(inspectImageFile(missing)).rejects.toMatchObject({
      name: "ImageInspectionError",
      inputPath: missing,
      reason: "missing_file",
      detail: "file does not exist",
    } satisfies Partial<ImageInspectionError>);
  });

  it("fails clearly for a corrupt image", async () => {
    const corrupt = join(root, "corrupt.png");
    writeFileSync(corrupt, "not an image", "utf8");

    await expect(inspectImageFile(corrupt)).rejects.toMatchObject({
      name: "ImageInspectionError",
      inputPath: corrupt,
      reason: "unreadable_image",
    } satisfies Partial<ImageInspectionError>);
  });

  it("does not touch Workspace, staging, archive, definitions, or Release state", async () => {
    const imagePath = join(root, "evidence.png");
    await makePng(imagePath);

    const sessionPath = join(root, "session.json");
    const stagingPath = join(root, "staging");
    const archivePath = join(root, "archive");
    const definitionsPath = join(root, "definitions");
    mkdirSync(stagingPath);
    mkdirSync(archivePath);
    mkdirSync(definitionsPath);
    writeFileSync(sessionPath, '{"sentinel":"workspace"}\n', "utf8");
    writeFileSync(join(stagingPath, "sentinel.txt"), "staging", "utf8");
    writeFileSync(join(archivePath, "sentinel.txt"), "archive", "utf8");
    writeFileSync(join(definitionsPath, "sentinel.json"), '{"definitions":true}\n', "utf8");

    const before = {
      session: readFileSync(sessionPath),
      staging: readFileSync(join(stagingPath, "sentinel.txt")),
      archive: readFileSync(join(archivePath, "sentinel.txt")),
      definitions: readFileSync(join(definitionsPath, "sentinel.json")),
    };

    await inspectImageFile(imagePath);

    expect(readFileSync(sessionPath)).toEqual(before.session);
    expect(readFileSync(join(stagingPath, "sentinel.txt"))).toEqual(before.staging);
    expect(readFileSync(join(archivePath, "sentinel.txt"))).toEqual(before.archive);
    expect(readFileSync(join(definitionsPath, "sentinel.json"))).toEqual(before.definitions);
  });
});

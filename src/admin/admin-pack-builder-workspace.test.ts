import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  AdminPackBuilderWorkspace,
  PACK_BUILDER_ASSET_LOGO_DIRECTORY,
} from "./admin-pack-builder-workspace.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function root(): Promise<string> {
  const path = await mkdtemp(
    join(tmpdir(), "visionx-pack-builder-workspace-"),
  );
  cleanup.push(path);
  return path;
}

async function png(
  width = 128,
  height = 128,
  seed = 17,
): Promise<Buffer> {
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * channels;
    pixels[offset] = (pixel * seed) % 256;
    pixels[offset + 1] = (pixel * (seed + 12)) % 256;
    pixels[offset + 2] = (pixel * (seed + 26)) % 256;
    pixels[offset + 3] = 255;
  }

  return sharp(pixels, {
    raw: { width, height, channels },
  }).png().toBuffer();
}

describe("Admin Pack-builder Asset-logo custody", () => {
  it("stores a validated logo beneath its fixed Pack and Asset identity", async () => {
    const workspaceRoot = await root();
    const workspace = await AdminPackBuilderWorkspace.open(workspaceRoot);
    const bytes = await png();

    const summary = await workspace.saveAssetLogo(
      "forex",
      "dxy",
      bytes,
    );

    expect(workspace.root).toBe(
      await realpath(join(workspaceRoot, "pack-builder")),
    );
    expect(summary).toMatchObject({
      assetId: "dxy",
      evidence: {
        ok: true,
        format: "png",
        width: 128,
        height: 128,
      },
    });
    expect(await workspace.readAssetLogo("forex", "dxy")).toEqual(bytes);
    expect(
      await readdir(
        join(
          workspace.root,
          "forex",
          PACK_BUILDER_ASSET_LOGO_DIRECTORY,
        ),
      ),
    ).toEqual(["dxy.png"]);
  });

  it("replaces staged bytes atomically without leaving temporary files", async () => {
    const workspace = await AdminPackBuilderWorkspace.open(await root());
    const first = await png(128, 128, 17);
    const second = await png(128, 128, 23);

    await workspace.saveAssetLogo("forex", "dxy", first);
    const summary = await workspace.saveAssetLogo(
      "forex",
      "dxy",
      second,
    );

    expect(summary.evidence.sha256).not.toBe(
      (await workspace.saveAssetLogo("forex", "exy", first))
        .evidence.sha256,
    );
    expect(await workspace.readAssetLogo("forex", "dxy")).toEqual(second);

    const names = await readdir(
      join(
        workspace.root,
        "forex",
        PACK_BUILDER_ASSET_LOGO_DIRECTORY,
      ),
    );
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects unsafe Asset IDs and invalid image bytes", async () => {
    const workspace = await AdminPackBuilderWorkspace.open(await root());

    await expect(
      workspace.saveAssetLogo(
        "forex",
        "../escape",
        await png(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });

    await expect(
      workspace.saveAssetLogo(
        "forex",
        "dxy",
        Buffer.from("not an image", "utf8"),
      ),
    ).rejects.toMatchObject({
      code: "invalid_asset_logo",
      details: { reason: "unreadable_image" },
    });
  });

  it("rejects symlinked roots, logo directories, and logo files", async () => {
    const host = await root();
    const canonicalRoot = join(host, "canonical");
    await mkdir(canonicalRoot);
    const linkedRoot = join(host, "linked");
    await symlink(canonicalRoot, linkedRoot, "dir");

    await expect(
      AdminPackBuilderWorkspace.open(linkedRoot),
    ).rejects.toMatchObject({
      code: "workspace_path_unsafe",
    });

    const workspace = await AdminPackBuilderWorkspace.open(canonicalRoot);
    const task = await workspace.taskDirectory("forex");
    const outside = await root();

    await symlink(
      outside,
      join(task, PACK_BUILDER_ASSET_LOGO_DIRECTORY),
      "dir",
    );
    await expect(
      workspace.saveAssetLogo("forex", "dxy", await png()),
    ).rejects.toMatchObject({
      code: "workspace_path_unsafe",
    });

    await rm(
      join(task, PACK_BUILDER_ASSET_LOGO_DIRECTORY),
      { force: true },
    );
    await mkdir(
      join(task, PACK_BUILDER_ASSET_LOGO_DIRECTORY),
    );
    const foreign = join(outside, "foreign.png");
    const foreignBytes = await png();
    await writeFile(foreign, foreignBytes);
    await symlink(
      foreign,
      join(
        task,
        PACK_BUILDER_ASSET_LOGO_DIRECTORY,
        "dxy.png",
      ),
    );

    await expect(
      workspace.readAssetLogo("forex", "dxy"),
    ).rejects.toMatchObject({
      code: "workspace_path_unsafe",
    });
    expect(await readFile(foreign)).toEqual(foreignBytes);
  });

  it("reports a typed not-found result for an unstaged logo", async () => {
    const workspace = await AdminPackBuilderWorkspace.open(await root());

    await expect(
      workspace.readAssetLogo("forex", "dxy"),
    ).rejects.toMatchObject({
      code: "asset_logo_not_found",
      status: 404,
    });
  });
});

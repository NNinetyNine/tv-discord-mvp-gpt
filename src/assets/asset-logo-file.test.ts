import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  join,
} from "node:path";
import {
  tmpdir,
} from "node:os";
import sharp from "sharp";

import {
  AssetLogoFileError,
  canonicalAssetLogoPath,
  deleteCanonicalAssetLogo,
  inspectCanonicalAssetLogo,
  readCanonicalAssetLogo,
  writeCanonicalAssetLogo,
} from "./asset-logo-file.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(
      (root) =>
        rm(root, {
          recursive: true,
          force: true,
        }),
    ),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "visionx-logo-file-"),
  );

  roots.push(root);

  await mkdir(
    join(
      root,
      "assets",
      "asset-logos",
    ),
    { recursive: true },
  );

  return root;
}

async function squarePng(
  size = 96,
): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: {
        r: 24,
        g: 48,
        b: 72,
        alpha: 1,
      },
    },
  })
    .png()
    .toBuffer();
}

describe("canonical Asset-logo file reads", () => {
  it("reads and validates one regular canonical PNG", async () => {
    const root = await fixture();
    const path =
      canonicalAssetLogoPath(
        root,
        "btc",
      );
    const bytes = await squarePng();

    await writeFile(path, bytes);

    const result =
      await readCanonicalAssetLogo(
        root,
        "btc",
      );

    expect(result.path).toBe(path);
    expect(result.bytes.equals(bytes)).toBe(
      true,
    );
    expect(result.evidence).toMatchObject({
      ok: true,
      format: "png",
      width: 96,
      height: 96,
      byteSize: bytes.byteLength,
    });
  });

  it("rejects unsafe Asset IDs before filesystem access", () => {
    expect(() =>
      canonicalAssetLogoPath(
        "/repo",
        "../btc",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_asset_id",
      }),
    );
  });

  it("reports a missing canonical logo", async () => {
    const root = await fixture();

    await expect(
      readCanonicalAssetLogo(
        root,
        "btc",
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "logo_not_found",
      }),
    );
  });

  it("rejects a symlinked canonical logo", async () => {
    const root = await fixture();
    const target = join(
      root,
      "target.png",
    );

    await writeFile(
      target,
      await squarePng(),
    );
    await symlink(
      target,
      canonicalAssetLogoPath(
        root,
        "btc",
      ),
    );

    await expect(
      readCanonicalAssetLogo(
        root,
        "btc",
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "logo_path_unsafe",
      }),
    );
  });

  it("rejects bytes that fail the canonical logo policy", async () => {
    const root = await fixture();

    await writeFile(
      canonicalAssetLogoPath(
        root,
        "btc",
      ),
      Buffer.from("not a png"),
    );

    await expect(
      readCanonicalAssetLogo(
        root,
        "btc",
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "invalid_asset_logo",
      }),
    );
  });

  it("detects a canonical logo changed during its read", async () => {
    const root = await fixture();
    const path =
      canonicalAssetLogoPath(
        root,
        "btc",
      );
    const original = await squarePng();

    await writeFile(path, original);

    await expect(
      readCanonicalAssetLogo(
        root,
        "btc",
        {
          afterRead: async () => {
            await writeFile(
              path,
              Buffer.concat([
                original,
                Buffer.from([0]),
              ]),
            );
          },
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "logo_changed",
      }),
    );
  });

  it("uses a typed error contract", () => {
    const error =
      new AssetLogoFileError(
        "logo_not_found",
        "missing",
      );

    expect(error.name).toBe(
      "AssetLogoFileError",
    );
    expect(error.code).toBe(
      "logo_not_found",
    );
  });
});

describe("canonical Asset-logo governed writes", () => {
  it("allows a repository path reached through a platform path alias while rejecting symlinked custody directories", async () => {
    const container = await mkdtemp(join(tmpdir(), "visionx-logo-alias-"));
    roots.push(container);
    const actualRoot = join(container, "actual");
    await mkdir(join(actualRoot, "assets", "asset-logos"), { recursive: true });
    const alias = join(container, "alias");
    await symlink(container, alias, "dir");

    const created = await writeCanonicalAssetLogo(join(alias, "actual"), "btc", await squarePng(), null);
    expect(created.evidence.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await inspectCanonicalAssetLogo(actualRoot, "btc")).evidence?.sha256).toBe(created.evidence.sha256);
  });

  it("creates, replaces, inspects, and removes one logo with exact-state confirmation", async () => {
    const root = await fixture();
    const first = await squarePng(96);
    const second = await squarePng(128);

    const created = await writeCanonicalAssetLogo(root, "btc", first, null);
    expect(created.evidence).toMatchObject({ width: 96, height: 96 });
    expect(await inspectCanonicalAssetLogo(root, "btc")).toMatchObject({
      exists: true,
      evidence: { sha256: created.evidence.sha256 },
    });

    const replaced = await writeCanonicalAssetLogo(root, "btc", second, created.evidence.sha256);
    expect(replaced.evidence).toMatchObject({ width: 128, height: 128 });
    await expect(writeCanonicalAssetLogo(root, "btc", first, created.evidence.sha256)).rejects.toEqual(
      expect.objectContaining({ code: "logo_state_conflict" }),
    );

    await deleteCanonicalAssetLogo(root, "btc", replaced.evidence.sha256);
    expect(await inspectCanonicalAssetLogo(root, "btc")).toMatchObject({ exists: false, evidence: null });
  });

  it("rejects removal when the expected logo identity is stale", async () => {
    const root = await fixture();
    const created = await writeCanonicalAssetLogo(root, "btc", await squarePng(), null);
    await expect(deleteCanonicalAssetLogo(root, "btc", "0".repeat(64))).rejects.toEqual(
      expect.objectContaining({ code: "logo_state_conflict" }),
    );
    expect((await readCanonicalAssetLogo(root, "btc")).evidence.sha256).toBe(created.evidence.sha256);
  });
});

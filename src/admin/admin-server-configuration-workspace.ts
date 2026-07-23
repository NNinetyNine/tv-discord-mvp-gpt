import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { AdminError } from "./admin-types.ts";

export interface AdminServerMigrationEvidence {
  readonly migrationId: string;
  readonly channelsBefore: Buffer;
  readonly threadBindingsBefore: Buffer;
  readonly channelsAfter: Buffer;
  readonly threadBindingsAfter: Buffer;
  readonly preview: Readonly<Record<string, unknown>>;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureSafeDirectory(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AdminError("path_collision", `${label} must be a non-symlink directory.`);
    }
  } catch (error) {
    if (error instanceof AdminError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AdminError("path_collision", `${label} must be a non-symlink directory.`);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(code)) throw error;
  } finally {
    await handle?.close();
  }
}

export class AdminServerConfigurationWorkspace {
  readonly root: string;
  readonly migrationsRoot: string;

  private constructor(root: string, migrationsRoot: string) {
    this.root = root;
    this.migrationsRoot = migrationsRoot;
  }

  static async open(workspaceRoot: string): Promise<AdminServerConfigurationWorkspace> {
    const workspace = await realpath(resolve(workspaceRoot));
    const root = join(workspace, "server-configuration");
    const migrationsRoot = join(root, "migrations");
    await ensureSafeDirectory(root, "Server-configuration custody");
    await ensureSafeDirectory(migrationsRoot, "Server-migration custody");
    const canonical = await realpath(root);
    const migrationsCanonical = await realpath(migrationsRoot);
    if (!inside(workspace, canonical) || !inside(canonical, migrationsCanonical)) {
      throw new AdminError("path_collision", "Server-configuration custody escapes the Administration workspace.");
    }
    return new AdminServerConfigurationWorkspace(canonical, migrationsCanonical);
  }

  async stageMigrationEvidence(evidence: AdminServerMigrationEvidence): Promise<void> {
    if (!/^[a-f0-9]{32}$/u.test(evidence.migrationId)) {
      throw new AdminError("invalid_request", "Migration identity is invalid.");
    }
    const temporary = join(
      this.migrationsRoot,
      `.${evidence.migrationId}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const destination = join(this.migrationsRoot, evidence.migrationId);
    const previewBytes = Buffer.from(`${JSON.stringify(evidence.preview, null, 2)}\n`, "utf8");
    try {
      let destinationExists = false;
      try {
        const existing = await lstat(destination);
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          throw new Error("existing migration evidence is not a safe directory");
        }
        destinationExists = true;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (code !== "ENOENT") throw error;
      }
      if (destinationExists) {
        const expected = [
          ["channels.before.json", evidence.channelsBefore],
          ["asset-threads.before.json", evidence.threadBindingsBefore],
          ["channels.after.json", evidence.channelsAfter],
          ["asset-threads.after.json", evidence.threadBindingsAfter],
          ["preview.json", previewBytes],
        ] as const;
        for (const [name, bytes] of expected) {
          const path = join(destination, name);
          const stat = await lstat(path);
          if (stat.isSymbolicLink() || !stat.isFile() || !(await readFile(path)).equals(bytes)) {
            throw new Error("existing migration evidence does not match the reviewed candidate");
          }
        }
        return;
      }
      await mkdir(temporary, { mode: 0o700 });
      await Promise.all([
        writeExclusive(join(temporary, "channels.before.json"), evidence.channelsBefore),
        writeExclusive(join(temporary, "asset-threads.before.json"), evidence.threadBindingsBefore),
        writeExclusive(join(temporary, "channels.after.json"), evidence.channelsAfter),
        writeExclusive(join(temporary, "asset-threads.after.json"), evidence.threadBindingsAfter),
        writeExclusive(join(temporary, "preview.json"), previewBytes),
      ]);
      await syncDirectory(temporary);
      await rename(temporary, destination);
      await syncDirectory(this.migrationsRoot);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw new AdminError(
        "temporary_write_failed",
        `Could not preserve server-migration evidence: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
  }

  async completeMigration(migrationId: string, receipt: Readonly<Record<string, unknown>>): Promise<void> {
    if (!/^[a-f0-9]{32}$/u.test(migrationId)) {
      throw new AdminError("invalid_request", "Migration identity is invalid.");
    }
    const directory = join(this.migrationsRoot, migrationId);
    const stat = await lstat(directory);
    const canonical = await realpath(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(this.migrationsRoot, canonical)) {
      throw new AdminError("path_collision", "Migration evidence custody is unsafe.");
    }
    await writeExclusive(
      join(canonical, "completion.json"),
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
    );
    await syncDirectory(canonical);
  }
}

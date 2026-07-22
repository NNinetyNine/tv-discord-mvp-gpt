import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  validateAssetLogo,
  type ValidatedAssetLogo,
} from "../assets/asset-logo.ts";
import { buildRegistry } from "../registry/registry.ts";
import { buildPacks } from "../packs/packs.ts";

import {
  CREATE_PACK_RECEIPT_SCHEMA_VERSION,
  CREATE_PACK_RECEIPT_TYPE,
  prepareCreatePackWithMissingAssets,
  serializeCreatePackPreview,
  type CreatePackPreview,
  type CreatePackWithMissingAssetsInput,
} from "./create-pack-with-missing-assets.ts";

export type CreatePackWithMissingAssetsFileFailureReason =
  | "repository_root_invalid"
  | "source_path_unsafe"
  | "workspace_path_unsafe"
  | "path_collision"
  | "unreadable_input"
  | "invalid_input"
  | "asset_logo_not_found"
  | "invalid_asset_logo"
  | "asset_logo_mismatch"
  | "preview_not_found"
  | "preview_mismatch"
  | "stale_registry_state"
  | "stale_pack_state"
  | "stale_channel_state"
  | "input_changed_during_operation"
  | "source_changed_during_operation"
  | "output_already_exists"
  | "temporary_write_failed"
  | "source_write_failed"
  | "source_write_verification_failed"
  | "application_receipt_finalize_failed"
  | "rollback_failed"
  | "rollback_verification_failed"
  | "application_already_completed"
  | "internal_error";

export interface CreatePackWithMissingAssetsFileFailure {
  readonly ok: false;
  readonly reason: CreatePackWithMissingAssetsFileFailureReason;
  readonly detail: string;
  readonly safelyRestored: boolean;
}

export interface CreatePackWithMissingAssetsReceipt {
  readonly schemaVersion: 2;
  readonly receiptType: typeof CREATE_PACK_RECEIPT_TYPE;
  readonly applicationStatus: "applied";
  readonly sourceChangesApplied: true;
  readonly previewId: string;
  readonly inputSha256: string;
  readonly pack: CreatePackPreview["pack"];
  readonly members: CreatePackPreview["members"];
  readonly assetLogos: CreatePackPreview["assetLogos"];
  readonly counts: CreatePackPreview["counts"];
  readonly sourceState: CreatePackPreview["sourceState"];
  readonly changedPaths: CreatePackPreview["changedPaths"];
  readonly publicationEffects: CreatePackPreview["publicationEffects"];
  readonly technicalValidation: {
    readonly inputVerified: true;
    readonly previewReconstructed: true;
    readonly registryPreStateVerified: true;
    readonly packsPreStateVerified: true;
    readonly channelsVerified: true;
    readonly registryPostStateVerified: true;
    readonly packsPostStateVerified: true;
    readonly jointModelReloadVerified: true;
    readonly rollbackRequired: false;
    readonly staleStateDetected: false;
  };
}

export interface CreatePackWithMissingAssetsFileSuccess {
  readonly ok: true;
  readonly receipt: CreatePackWithMissingAssetsReceipt;
  readonly receiptBytes: Buffer;
  readonly receiptSha256: string;
  readonly receiptByteSize: number;
}

export type CreatePackWithMissingAssetsFileResult =
  | CreatePackWithMissingAssetsFileSuccess
  | CreatePackWithMissingAssetsFileFailure;

export interface CreatePackWithMissingAssetsFileOptions {
  readonly repositoryRoot: string;
  readonly inputPath: string;
  readonly previewPath: string;
  readonly receiptOutputPath: string;
  readonly assetLogoInputs?: readonly {
    readonly assetId: string;
    readonly path: string;
  }[];
}

export interface CreatePackWithMissingAssetsFileDependencies {
  readonly beforeReplacement?: (index: number) => Promise<void>;
  readonly afterReplacement?: (index: number) => Promise<void>;
  readonly beforeJointVerification?: () => Promise<void>;
  readonly beforeReceiptFinalize?: () => Promise<void>;
  readonly simulateRollbackFailure?: boolean;
  readonly simulateRollbackVerificationFailure?: boolean;
  readonly syncDirectory?: (directory: string) => Promise<void>;
}

interface FileArtifact {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
}

interface Replacement {
  readonly source: FileArtifact;
  readonly after: Buffer;
  readonly temporary: string;
  readonly backup: string;
  replaced: boolean;
}

interface AssetLogoInputArtifact {
  readonly assetId: string;
  readonly artifact: FileArtifact;
  readonly evidence: ValidatedAssetLogo;
}

interface DirectoryArtifact {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface AssetLogoTarget {
  readonly assetId: string;
  readonly destination: string;
  readonly source: AssetLogoInputArtifact;
}

interface CreatedAssetLogo {
  readonly assetId: string;
  readonly destination: string;
  readonly temporary: string;
  readonly temporaryArtifact: FileArtifact;
  readonly sha256: string;
  published: boolean;
}

function failure(
  reason: CreatePackWithMissingAssetsFileFailureReason,
  detail: string,
  safelyRestored = false,
): CreatePackWithMissingAssetsFileFailure {
  return Object.freeze({ ok: false, reason, detail, safelyRestored });
}

const ASSET_ID_PATTERN =
  /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectoryDefault(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(code)) throw error;
  } finally { await handle?.close(); }
}

async function writeExclusive(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function readRegular(path: string, root?: string): Promise<FileArtifact | CreatePackWithMissingAssetsFileFailure> {
  const requested = resolve(path);
  try {
    const stat = await lstat(requested, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) return failure(root === undefined ? "workspace_path_unsafe" : "source_path_unsafe", `${requested} must be a regular non-symlink file`);
    const canonical = await realpath(requested);
    if (root !== undefined && !pathInside(root, canonical)) return failure("source_path_unsafe", `${requested} escapes the repository root`);
    const bytes = await readFile(canonical);
    return Object.freeze({ path: canonical, bytes, sha256: sha256(bytes), device: stat.dev, inode: stat.ino, mode: Number(stat.mode & 0o777n) });
  } catch (error) {
    return failure("unreadable_input", `Could not read ${requested}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyArtifact(artifact: FileArtifact): Promise<boolean> {
  try {
    const stat = await lstat(artifact.path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== artifact.device || stat.ino !== artifact.inode) return false;
    return sha256(await readFile(artifact.path)) === artifact.sha256;
  } catch { return false; }
}

async function readDirectory(
  path: string,
  root: string,
): Promise<
  DirectoryArtifact |
  CreatePackWithMissingAssetsFileFailure
> {
  const requested = resolve(path);
  try {
    const stat = await lstat(requested, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return failure(
        "source_path_unsafe",
        `${requested} must be a non-symlink directory`,
      );
    }
    const canonical = await realpath(requested);
    if (!pathInside(root, canonical)) {
      return failure(
        "source_path_unsafe",
        `${requested} escapes its canonical parent`,
      );
    }
    return Object.freeze({
      path: canonical,
      device: stat.dev,
      inode: stat.ino,
    });
  } catch (error) {
    return failure(
      "source_path_unsafe",
      `Could not inspect ${requested}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

async function verifyDirectory(
  artifact: DirectoryArtifact,
): Promise<boolean> {
  try {
    const stat = await lstat(
      artifact.path,
      { bigint: true },
    );
    return (
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      stat.dev === artifact.device &&
      stat.ino === artifact.inode
    );
  } catch {
    return false;
  }
}

async function verifyCreatedAssetLogo(
  target: CreatedAssetLogo,
): Promise<boolean> {
  try {
    const destination = await lstat(
      target.destination,
      { bigint: true },
    );
    if (
      destination.isSymbolicLink() ||
      !destination.isFile() ||
      destination.dev !==
        target.temporaryArtifact.device ||
      destination.ino !==
        target.temporaryArtifact.inode
    ) {
      return false;
    }
    return sha256(
      await readFile(target.destination),
    ) === target.sha256;
  } catch {
    return false;
  }
}

async function removeOwnedCreatedAssetLogo(
  target: CreatedAssetLogo,
): Promise<boolean> {
  try {
    const destination = await lstat(
      target.destination,
      { bigint: true },
    );
    if (
      destination.isSymbolicLink() ||
      !destination.isFile() ||
      destination.dev !==
        target.temporaryArtifact.device ||
      destination.ino !==
        target.temporaryArtifact.inode ||
      sha256(
        await readFile(target.destination),
      ) !== target.sha256
    ) {
      return false;
    }
    await unlink(target.destination);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error
        ? String(error.code)
        : "";
    return code === "ENOENT";
  }
}

function serializeReceipt(receipt: CreatePackWithMissingAssetsReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

async function cleanup(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)));
}

async function rollback(
  replacements: readonly Replacement[],
  createdAssetLogos: readonly CreatedAssetLogo[],
  immutableArtifacts: readonly FileArtifact[],
  immutableDirectories: readonly DirectoryArtifact[],
  createdAssetLogoDirectory: string | undefined,
  receiptOutput: string,
  simulateRollbackFailure: boolean,
  simulateVerificationFailure: boolean,
  syncDirectory: (directory: string) => Promise<void>,
): Promise<"ok" | "rollback_failed" | "verification_failed"> {
  let restored = true;

  await unlink(receiptOutput).catch((error) => {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      restored = false;
    }
  });

  for (
    const target of [...createdAssetLogos].reverse()
  ) {
    if (target.published) {
      if (simulateRollbackFailure) {
        restored = false;
      } else {
        const removed =
          await removeOwnedCreatedAssetLogo(target);
        if (!removed) {
          restored = false;
        } else {
          await syncDirectory(
            dirname(target.destination),
          ).catch(() => {
            restored = false;
          });
        }
      }
    }

    await unlink(target.temporary).catch((error) => {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        restored = false;
      }
    });
  }

  if (createdAssetLogoDirectory !== undefined) {
    if (simulateRollbackFailure) {
      restored = false;
    } else {
      try {
        await rmdir(createdAssetLogoDirectory);
        await syncDirectory(
          dirname(createdAssetLogoDirectory),
        );
      } catch {
        restored = false;
      }
    }
  }

  for (
    const replacement of [...replacements].reverse()
  ) {
    if (replacement.replaced) {
      if (simulateRollbackFailure) {
        restored = false;
      } else {
        try {
          await rename(
            replacement.backup,
            replacement.source.path,
          );
          await syncDirectory(
            dirname(replacement.source.path),
          );
        } catch {
          restored = false;
        }
      }
    } else {
      await unlink(replacement.backup)
        .catch(() => undefined);
    }
    await unlink(replacement.temporary)
      .catch(() => undefined);
  }

  if (!restored) return "rollback_failed";
  if (simulateVerificationFailure) {
    return "verification_failed";
  }

  for (const replacement of replacements) {
    try {
      if (
        sha256(
          await readFile(replacement.source.path),
        ) !== replacement.source.sha256
      ) {
        return "verification_failed";
      }
    } catch {
      return "verification_failed";
    }
  }

  for (const target of createdAssetLogos) {
    if (await pathExists(target.destination)) {
      return "verification_failed";
    }
  }

  if (
    createdAssetLogoDirectory !== undefined &&
    await pathExists(createdAssetLogoDirectory)
  ) {
    return "verification_failed";
  }

  for (const artifact of immutableArtifacts) {
    if (!await verifyArtifact(artifact)) {
      return "verification_failed";
    }
  }

  for (const directory of immutableDirectories) {
    if (!await verifyDirectory(directory)) {
      return "verification_failed";
    }
  }

  return "ok";
}

export async function applyCreatePackWithMissingAssetsFile(
  options: CreatePackWithMissingAssetsFileOptions,
  dependencies: CreatePackWithMissingAssetsFileDependencies = {},
): Promise<CreatePackWithMissingAssetsFileResult> {
  let root: string;
  try {
    const requested = resolve(options.repositoryRoot);
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("repository_root_invalid", "Repository root must be a non-symlink directory");
    root = await realpath(requested);
  } catch (error) {
    return failure("repository_root_invalid", `Repository root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const registry = await readRegular(join(root, "definitions/registry.json"), root);
  if (!("bytes" in registry)) return registry;
  const packs = await readRegular(join(root, "definitions/packs.json"), root);
  if (!("bytes" in packs)) return packs;
  const channels = await readRegular(join(root, "config/channels.json"), root);
  if (!("bytes" in channels)) return channels;
  const sources = [registry, packs, channels];
  if (new Set(sources.map((source) => `${source.device}:${source.inode}`)).size !== sources.length) return failure("source_path_unsafe", "Canonical source files must be distinct");

  const inputArtifact = await readRegular(options.inputPath);
  if (!("bytes" in inputArtifact)) return inputArtifact;
  const previewArtifact = await readRegular(options.previewPath);
  if (!("bytes" in previewArtifact)) return failure("preview_not_found", previewArtifact.detail);
  if (inputArtifact.path === previewArtifact.path) return failure("path_collision", "Input and preview artifacts must be distinct");

  let inputValue: unknown;
  let previewValue: unknown;
  try { inputValue = JSON.parse(inputArtifact.bytes.toString("utf8")) as unknown; }
  catch { return failure("invalid_input", "Stored Pack-builder input is not valid JSON"); }
  try { previewValue = JSON.parse(previewArtifact.bytes.toString("utf8")) as unknown; }
  catch { return failure("preview_mismatch", "Stored Pack-builder preview is not valid JSON"); }
  const storedPreview = previewValue as Partial<CreatePackPreview>;
  if (storedPreview.sourceState?.registryBeforeSha256 !== registry.sha256) return failure("stale_registry_state", "Registry definitions changed after preview");
  if (storedPreview.sourceState?.packsBeforeSha256 !== packs.sha256) return failure("stale_pack_state", "Pack definitions changed after preview");
  if (storedPreview.sourceState?.channelsSha256 !== channels.sha256) return failure("stale_channel_state", "Channel configuration changed after preview");

  if (!Array.isArray(storedPreview.assetLogos)) {
    return failure(
      "preview_mismatch",
      "Stored Pack-builder preview does not contain valid Asset-logo evidence.",
    );
  }

  const expectedLogos = new Map<
    string,
    CreatePackPreview["assetLogos"][number]
  >();
  for (const entry of storedPreview.assetLogos) {
    if (
      !isRecord(entry) ||
      typeof entry.assetId !== "string" ||
      !ASSET_ID_PATTERN.test(entry.assetId) ||
      expectedLogos.has(entry.assetId)
    ) {
      return failure(
        "preview_mismatch",
        "Stored Pack-builder Asset-logo evidence is invalid.",
      );
    }
    expectedLogos.set(
      entry.assetId,
      entry as CreatePackPreview["assetLogos"][number],
    );
  }

  const stagedLogoArtifacts: AssetLogoInputArtifact[] = [];
  const suppliedIds = new Set<string>();
  const occupiedArtifacts = [
    ...sources,
    inputArtifact,
    previewArtifact,
  ];
  const occupiedPaths = new Set(
    occupiedArtifacts.map(({ path }) => path),
  );
  const occupiedIdentities = new Set(
    occupiedArtifacts.map(
      ({ device, inode }) => `${device}:${inode}`,
    ),
  );

  for (const logoInput of options.assetLogoInputs ?? []) {
    if (
      !ASSET_ID_PATTERN.test(logoInput.assetId) ||
      suppliedIds.has(logoInput.assetId)
    ) {
      return failure(
        "invalid_input",
        "Asset-logo inputs must have unique lowercase safe Asset IDs.",
      );
    }
    suppliedIds.add(logoInput.assetId);

    const expected = expectedLogos.get(logoInput.assetId);
    if (expected === undefined) {
      return failure(
        "asset_logo_mismatch",
        `Staged Asset logo ${logoInput.assetId} is not present in the stored preview.`,
      );
    }

    const artifact = await readRegular(logoInput.path);
    if (!("bytes" in artifact)) {
      if (artifact.reason === "workspace_path_unsafe") {
        return failure(
          "workspace_path_unsafe",
          `The staged Asset logo for ${logoInput.assetId} must be a regular non-symlink file.`,
        );
      }
      return failure(
        "asset_logo_not_found",
        `Could not read the staged Asset logo for ${logoInput.assetId}.`,
      );
    }

    const artifactIdentity =
      `${artifact.device}:${artifact.inode}`;
    if (
      occupiedPaths.has(artifact.path) ||
      occupiedIdentities.has(artifactIdentity)
    ) {
      return failure(
        "path_collision",
        "Staged Asset-logo inputs must be distinct from every other transaction artifact.",
      );
    }
    occupiedPaths.add(artifact.path);
    occupiedIdentities.add(artifactIdentity);

    const validated = await validateAssetLogo(artifact.bytes);
    if (!validated.ok) {
      return failure(
        "invalid_asset_logo",
        `Staged Asset logo ${logoInput.assetId} is invalid: ${validated.detail}`,
      );
    }

    const actualEvidence = Object.freeze({
      assetId: logoInput.assetId,
      ...validated,
    });
    if (
      JSON.stringify(actualEvidence) !==
      JSON.stringify(expected)
    ) {
      return failure(
        "asset_logo_mismatch",
        `Staged Asset logo ${logoInput.assetId} no longer matches the stored preview.`,
      );
    }

    stagedLogoArtifacts.push(
      Object.freeze({
        assetId: logoInput.assetId,
        artifact,
        evidence: validated,
      }),
    );
  }

  for (const assetId of expectedLogos.keys()) {
    if (!suppliedIds.has(assetId)) {
      return failure(
        "asset_logo_not_found",
        `The staged Asset logo for ${assetId} is required by the stored preview.`,
      );
    }
  }

  const prepared = prepareCreatePackWithMissingAssets({
    value: inputValue,
    registryBytes: registry.bytes,
    packsBytes: packs.bytes,
    channelsBytes: channels.bytes,
    assetLogos: new Map(
      stagedLogoArtifacts.map(
        ({ assetId, evidence }) =>
          [assetId, evidence] as const,
      ),
    ),
  });
  if (!prepared.ok) {
    const stale = prepared.reason === "pack_already_exists" || prepared.reason === "asset_id_conflict" || prepared.reason === "tradingview_conflict";
    return failure(stale ? "stale_registry_state" : "invalid_input", prepared.detail);
  }
  const canonicalPreviewBytes = serializeCreatePackPreview(prepared.value.preview);
  if (!previewArtifact.bytes.equals(canonicalPreviewBytes) || JSON.stringify(previewValue) !== JSON.stringify(prepared.value.preview)) {
    return failure("preview_mismatch", "Stored input no longer reconstructs the exact preview");
  }

  let assetsDirectory:
    DirectoryArtifact | undefined;
  let existingAssetLogoDirectory:
    DirectoryArtifact | undefined;
  let assetLogoDirectoryRequested:
    string | undefined;
  let createAssetLogoDirectory = false;
  const assetLogoTargets: AssetLogoTarget[] = [];

  if (stagedLogoArtifacts.length > 0) {
    const inspectedAssets = await readDirectory(
      join(root, "assets"),
      root,
    );
    if (!("device" in inspectedAssets)) {
      return inspectedAssets;
    }
    assetsDirectory = inspectedAssets;

    assetLogoDirectoryRequested = join(
      assetsDirectory.path,
      "asset-logos",
    );

    if (await pathExists(assetLogoDirectoryRequested)) {
      const inspectedLogoDirectory =
        await readDirectory(
          assetLogoDirectoryRequested,
          assetsDirectory.path,
        );
      if (!("device" in inspectedLogoDirectory)) {
        return inspectedLogoDirectory;
      }
      existingAssetLogoDirectory =
        inspectedLogoDirectory;
    } else {
      createAssetLogoDirectory = true;
    }

    const destinationDirectory =
      existingAssetLogoDirectory?.path ??
      assetLogoDirectoryRequested;

    for (const staged of stagedLogoArtifacts) {
      const destination = join(
        destinationDirectory,
        `${staged.assetId}.png`,
      );
      if (await pathExists(destination)) {
        return failure(
          "output_already_exists",
          `Canonical Asset logo ${staged.assetId} already exists.`,
        );
      }
      assetLogoTargets.push(
        Object.freeze({
          assetId: staged.assetId,
          destination,
          source: staged,
        }),
      );
    }
  }

  const outputRequested = resolve(options.receiptOutputPath);
  let outputDirectory: string;
  try {
    const parentStat = await lstat(dirname(outputRequested));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return failure("workspace_path_unsafe", "Receipt directory must be a non-symlink directory");
    outputDirectory = await realpath(dirname(outputRequested));
  } catch (error) {
    return failure("workspace_path_unsafe", `Receipt directory is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const output = join(outputDirectory, basename(outputRequested));
  if ([
    inputArtifact.path,
    previewArtifact.path,
    ...sources.map((source) => source.path),
    ...stagedLogoArtifacts.map(
      ({ artifact }) => artifact.path,
    ),
    ...assetLogoTargets.map(
      ({ destination }) => destination,
    ),
  ].includes(output)) {
    return failure(
      "path_collision",
      "Receipt path collides with an input or canonical source.",
    );
  }
  if (await pathExists(output)) return failure("application_already_completed", "This Pack creation has already completed");

  const receipt: CreatePackWithMissingAssetsReceipt = Object.freeze({
    schemaVersion: CREATE_PACK_RECEIPT_SCHEMA_VERSION,
    receiptType: CREATE_PACK_RECEIPT_TYPE,
    applicationStatus: "applied",
    sourceChangesApplied: true,
    previewId: prepared.value.preview.previewId,
    inputSha256: prepared.value.preview.inputSha256,
    pack: prepared.value.preview.pack,
    members: prepared.value.preview.members,
    assetLogos: prepared.value.preview.assetLogos,
    counts: prepared.value.preview.counts,
    sourceState: prepared.value.preview.sourceState,
    changedPaths: prepared.value.preview.changedPaths,
    publicationEffects: prepared.value.preview.publicationEffects,
    technicalValidation: Object.freeze({
      inputVerified: true,
      previewReconstructed: true,
      registryPreStateVerified: true,
      packsPreStateVerified: true,
      channelsVerified: true,
      registryPostStateVerified: true,
      packsPostStateVerified: true,
      jointModelReloadVerified: true,
      rollbackRequired: false,
      staleStateDetected: false,
    }),
  });
  const receiptBytes = serializeReceipt(receipt);
  const replacements: Replacement[] = [];
  const createdAssetLogos: CreatedAssetLogo[] = [];
  const receiptTemporary = join(
    outputDirectory,
    `.${basename(output)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const syncDirectory =
    dependencies.syncDirectory ??
    syncDirectoryDefault;

  const transactionTemporaryPaths = (): string[] => [
    ...replacements.flatMap(
      (replacement) => [
        replacement.temporary,
        replacement.backup,
      ],
    ),
    ...createdAssetLogos.map(
      ({ temporary }) => temporary,
    ),
    receiptTemporary,
  ];

  try {
    const changes = [
      {
        source: registry,
        after: prepared.value.registryAfterBytes,
      },
      {
        source: packs,
        after: prepared.value.packsAfterBytes,
      },
    ].filter(
      (change) =>
        !change.source.bytes.equals(change.after),
    );

    for (const change of changes) {
      const token =
        randomBytes(12).toString("hex");
      const directory = dirname(
        change.source.path,
      );
      const temporary = join(
        directory,
        `.${basename(change.source.path)}.${token}.future.tmp`,
      );
      const backup = join(
        directory,
        `.${basename(change.source.path)}.${token}.rollback.tmp`,
      );
      await writeExclusive(
        temporary,
        change.after,
        change.source.mode,
      );
      await link(change.source.path, backup);
      replacements.push({
        source: change.source,
        after: change.after,
        temporary,
        backup,
        replaced: false,
      });
    }

    for (const target of assetLogoTargets) {
      if (assetsDirectory === undefined) {
        throw new Error(
          "Canonical assets directory was not resolved.",
        );
      }
      const token =
        randomBytes(12).toString("hex");
      const temporary = join(
        assetsDirectory.path,
        `.${target.assetId}.${token}.asset-logo.future.tmp`,
      );
      await writeExclusive(
        temporary,
        target.source.artifact.bytes,
        0o644,
      );
      const temporaryArtifact =
        await readRegular(temporary, root);
      if (!("bytes" in temporaryArtifact)) {
        throw new Error(
          `Could not verify temporary Asset logo ${target.assetId}.`,
        );
      }
      createdAssetLogos.push({
        assetId: target.assetId,
        destination: target.destination,
        temporary,
        temporaryArtifact,
        sha256: target.source.evidence.sha256,
        published: false,
      });
    }

    await writeExclusive(
      receiptTemporary,
      receiptBytes,
      0o600,
    );
  } catch (error) {
    await cleanup(transactionTemporaryPaths());
    return failure(
      "temporary_write_failed",
      `Could not prepare transaction: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  if (
    !await verifyArtifact(inputArtifact) ||
    !await verifyArtifact(previewArtifact) ||
    !await Promise.all(
      stagedLogoArtifacts.map(
        ({ artifact }) => verifyArtifact(artifact),
      ),
    ).then((results) => results.every(Boolean))
  ) {
    await cleanup(transactionTemporaryPaths());
    return failure("input_changed_during_operation", "Pack-builder input, preview, or staged Asset logo changed before source replacement");
  }
  for (const source of sources) {
    if (!await verifyArtifact(source)) {
      await cleanup(transactionTemporaryPaths());
      return failure(
        "source_changed_during_operation",
        "A canonical source changed before source replacement",
      );
    }
  }

  if (
    assetsDirectory !== undefined &&
    !await verifyDirectory(assetsDirectory)
  ) {
    await cleanup(transactionTemporaryPaths());
    return failure(
      "source_changed_during_operation",
      "The canonical assets directory changed before application.",
    );
  }

  if (
    existingAssetLogoDirectory !== undefined &&
    !await verifyDirectory(
      existingAssetLogoDirectory,
    )
  ) {
    await cleanup(transactionTemporaryPaths());
    return failure(
      "source_changed_during_operation",
      "The canonical Asset-logo directory changed before application.",
    );
  }

  if (
    createAssetLogoDirectory &&
    assetLogoDirectoryRequested !== undefined &&
    await pathExists(assetLogoDirectoryRequested)
  ) {
    await cleanup(transactionTemporaryPaths());
    return failure(
      "source_changed_during_operation",
      "The canonical Asset-logo directory appeared after preview.",
    );
  }

  for (const target of assetLogoTargets) {
    if (await pathExists(target.destination)) {
      await cleanup(transactionTemporaryPaths());
      return failure(
        "source_changed_during_operation",
        `Canonical Asset logo ${target.assetId} appeared after preview.`,
      );
    }
  }

  let receiptFinalizationStarted = false;
  let receiptPublished = false;
  let assetLogoDirectoryCreated = false;
  let activeAssetLogoDirectory =
    existingAssetLogoDirectory;

  try {
    for (
      let index = 0;
      index < replacements.length;
      index += 1
    ) {
      await dependencies.beforeReplacement?.(index);
      const replacement =
        replacements[index] as Replacement;
      await rename(
        replacement.temporary,
        replacement.source.path,
      );
      replacement.replaced = true;
      await syncDirectory(
        dirname(replacement.source.path),
      );
      await dependencies.afterReplacement?.(index);
    }

    if (assetLogoTargets.length > 0) {
      if (
        assetsDirectory === undefined ||
        assetLogoDirectoryRequested === undefined
      ) {
        throw new Error(
          "Canonical Asset-logo destination was not resolved.",
        );
      }
      if (!await verifyDirectory(assetsDirectory)) {
        throw new Error(
          "Canonical assets directory changed during application.",
        );
      }

      if (createAssetLogoDirectory) {
        await mkdir(
          assetLogoDirectoryRequested,
          { mode: 0o755 },
        );
        assetLogoDirectoryCreated = true;

        const createdDirectory =
          await readDirectory(
            assetLogoDirectoryRequested,
            assetsDirectory.path,
          );
        if (!("device" in createdDirectory)) {
          throw new Error(
            "Created Asset-logo directory could not be verified.",
          );
        }
        activeAssetLogoDirectory =
          createdDirectory;
        await syncDirectory(
          assetsDirectory.path,
        );
      } else if (
        activeAssetLogoDirectory === undefined ||
        !await verifyDirectory(
          activeAssetLogoDirectory,
        )
      ) {
        throw new Error(
          "Canonical Asset-logo directory changed during application.",
        );
      }

      for (const target of createdAssetLogos) {
        await link(
          target.temporary,
          target.destination,
        );
        target.published = true;
        await syncDirectory(
          dirname(target.destination),
        );
      }
    }

    await dependencies.beforeJointVerification?.();

    if (
      !await verifyArtifact(inputArtifact) ||
      !await verifyArtifact(previewArtifact) ||
      !await Promise.all(
        stagedLogoArtifacts.map(
          ({ artifact }) =>
            verifyArtifact(artifact),
        ),
      ).then(
        (results) => results.every(Boolean),
      )
    ) {
      throw new Error(
        "Pack-builder input, preview, or staged Asset logo changed during application",
      );
    }

    if (
      !await Promise.all(
        createdAssetLogos.map(
          verifyCreatedAssetLogo,
        ),
      ).then(
        (results) => results.every(Boolean),
      )
    ) {
      throw new Error(
        "Canonical Asset-logo creation could not be verified.",
      );
    }

    if (
      sha256(await readFile(registry.path)) !==
      prepared.value.preview.sourceState
        .registryAfterSha256
    ) {
      throw new Error(
        "Registry post-state hash mismatch",
      );
    }
    if (
      sha256(await readFile(packs.path)) !==
      prepared.value.preview.sourceState
        .packsAfterSha256
    ) {
      throw new Error(
        "Packs post-state hash mismatch",
      );
    }
    if (
      sha256(await readFile(channels.path)) !==
      prepared.value.preview.sourceState
        .channelsSha256
    ) {
      throw new Error(
        "Channel configuration changed during application",
      );
    }

    const registryAfterValue = JSON.parse(
      (
        await readFile(registry.path)
      ).toString("utf8"),
    ) as Record<
      string,
      Record<string, unknown>
    >;
    const packsAfterValue = JSON.parse(
      (
        await readFile(packs.path)
      ).toString("utf8"),
    ) as unknown;
    const channelsValue = JSON.parse(
      channels.bytes.toString("utf8"),
    ) as Record<string, unknown>;

    const registryAfter = buildRegistry(
      registryAfterValue,
      channelsValue,
    );
    const packsAfter = buildPacks(
      packsAfterValue,
      new Set(
        registryAfter.all().map(
          (asset) => asset.id,
        ),
      ),
      new Set(Object.keys(channelsValue)),
    );

    if (
      registryAfter.all().length !==
      prepared.value.preview.counts
        .registryAssetsAfter
    ) {
      throw new Error(
        "Registry post-state count mismatch",
      );
    }
    if (
      packsAfter.length !==
      prepared.value.preview.counts.packsAfter
    ) {
      throw new Error(
        "Packs post-state count mismatch",
      );
    }

    const createdPack = packsAfter.find(
      (pack) =>
        pack.id ===
        prepared.value.preview.pack.id,
    );
    if (
      createdPack === undefined ||
      createdPack.display !==
        prepared.value.preview.pack.display ||
      createdPack.channel !==
        prepared.value.preview.pack.channel ||
      JSON.stringify(createdPack.assets) !==
        JSON.stringify(
          prepared.value.preview.pack.assetIds,
        )
    ) {
      throw new Error(
        "Created Pack post-state mismatch",
      );
    }

    for (
      const expected of
      prepared.value.preview.members
    ) {
      const actual = registryAfter.all().find(
        (asset) => asset.id === expected.id,
      );
      if (actual === undefined) {
        throw new Error(
          `Created Asset ${expected.id} is absent after application`,
        );
      }
      if (
        actual.display !== expected.display ||
        actual.tradingView !==
          expected.tradingView ||
        actual.currency !== expected.currency ||
        actual.channel !== expected.channel ||
        JSON.stringify(
          actual.tradingViewAliases ?? [],
        ) !==
          JSON.stringify(
            expected.tradingViewAliases ?? [],
          )
      ) {
        throw new Error(
          `Created Asset ${expected.id} post-state mismatch`,
        );
      }
    }

    for (const target of createdAssetLogos) {
      await unlink(target.temporary);
    }
    if (assetsDirectory !== undefined) {
      await syncDirectory(
        assetsDirectory.path,
      );
    }

    receiptFinalizationStarted = true;
    await dependencies.beforeReceiptFinalize?.();

    await link(receiptTemporary, output);
    receiptPublished = true;
    await syncDirectory(outputDirectory);
    await unlink(receiptTemporary);

    for (const replacement of replacements) {
      await unlink(replacement.backup);
    }
    for (
      const directory of new Set(
        replacements.map(
          (replacement) =>
            dirname(replacement.source.path),
        ),
      )
    ) {
      await syncDirectory(directory);
    }

    if (activeAssetLogoDirectory !== undefined) {
      await syncDirectory(
        activeAssetLogoDirectory.path,
      );
    }
    if (assetsDirectory !== undefined) {
      await syncDirectory(
        assetsDirectory.path,
      );
    }
  } catch (error) {
    if (receiptPublished) {
      await unlink(output).catch(
        () => undefined,
      );
    }

    const rollbackResult = await rollback(
      replacements,
      createdAssetLogos,
      [
        channels,
        ...stagedLogoArtifacts.map(
          ({ artifact }) => artifact,
        ),
      ],
      [
        ...(assetsDirectory === undefined
          ? []
          : [assetsDirectory]),
        ...(existingAssetLogoDirectory === undefined
          ? []
          : [existingAssetLogoDirectory]),
      ],
      assetLogoDirectoryCreated
        ? assetLogoDirectoryRequested
        : undefined,
      output,
      dependencies.simulateRollbackFailure ??
        false,
      dependencies
        .simulateRollbackVerificationFailure ??
        false,
      syncDirectory,
    );

    await unlink(receiptTemporary)
      .catch(() => undefined);

    if (rollbackResult === "rollback_failed") {
      return failure(
        "rollback_failed",
        `Application failed and rollback could not be completed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }
    if (
      rollbackResult === "verification_failed"
    ) {
      return failure(
        "rollback_verification_failed",
        `Application failed and exact rollback could not be verified: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    const reason = receiptFinalizationStarted
      ? "application_receipt_finalize_failed"
      : replacements.some(
          (replacement) =>
            replacement.replaced,
        ) ||
          createdAssetLogos.some(
            ({ published }) => published,
          )
        ? "source_write_verification_failed"
        : "source_write_failed";

    return failure(
      reason,
      `Application failed and canonical state was restored: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
      true,
    );
  }

  return Object.freeze({
    ok: true,
    receipt,
    receiptBytes,
    receiptSha256: sha256(receiptBytes),
    receiptByteSize: receiptBytes.length,
  });
}

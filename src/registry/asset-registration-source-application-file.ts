import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  prepareAssetRegistrationSourceApplication,
  type AssetRegistrationSourceApplicationFailureReason,
  type AssetRegistrationSourceApplicationReceipt,
} from "./asset-registration-source-application.ts";

export type AssetRegistrationSourceApplicationFileFailureReason =
  | "invalid_arguments"
  | "unreadable_input"
  | "repository_root_invalid"
  | "source_path_unsafe"
  | "path_collision"
  | "output_already_exists"
  | "input_changed_during_operation"
  | "source_changed_during_operation"
  | "temporary_write_failed"
  | "source_replace_failed"
  | "post_apply_validation_failed"
  | "finalize_failed"
  | "rollback_failed"
  | AssetRegistrationSourceApplicationFailureReason;

export interface AssetRegistrationSourceApplicationFileFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationSourceApplicationFileFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationSourceApplicationFileSuccess {
  readonly ok: true;
  readonly outputBasename: string;
  readonly receiptSha256: string;
  readonly receipt: AssetRegistrationSourceApplicationReceipt;
}

export type AssetRegistrationSourceApplicationFileResult =
  | AssetRegistrationSourceApplicationFileSuccess
  | AssetRegistrationSourceApplicationFileFailure;

export interface ApplyAssetRegistrationSourceChangeFileOptions {
  readonly proposalPath: string;
  readonly planningAuthorizationPath: string;
  readonly planPath: string;
  readonly patchPath: string;
  readonly sourceChangeReceiptPath: string;
  readonly reviewPath: string;
  readonly applicationAuthorizationPath: string;
  readonly repositoryRoot: string;
  readonly applicationReceiptOutputPath: string;
}

export interface ApplyAssetRegistrationSourceChangeFileDependencies {
  readonly verifyPatch?: (repositoryRoot: string, patchBytes: Buffer, registryBytes: Buffer, packsBytes: Buffer, channelsBytes: Buffer) => Promise<boolean>;
  readonly beforeReplacement?: (index: number) => Promise<void>;
  readonly afterReplacement?: (index: number) => Promise<void>;
  readonly beforeReceiptFinalize?: () => Promise<void>;
  readonly syncDirectory?: (directory: string) => Promise<void>;
  readonly simulateRollbackFailure?: boolean;
}

interface Artifact { readonly path: string; readonly bytes: Buffer; readonly sha256: string }
interface SourceArtifact extends Artifact { readonly relativePath: "definitions/registry.json" | "definitions/packs.json" | "config/channels.json"; readonly mode: number; readonly device: bigint; readonly inode: bigint }
interface Replacement { readonly source: SourceArtifact; readonly after: Buffer; readonly temporary: string; readonly backup: string; replaced: boolean }

function failure(reason: AssetRegistrationSourceApplicationFileFailureReason, detail: string): AssetRegistrationSourceApplicationFileFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function key(value: string): string { return value.normalize("NFC").toLocaleLowerCase("en-US"); }
function isInside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(path).startsWith(`${resolve(root)}${sep}..${sep}`); }

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readArtifact(path: string, label: string): Promise<Artifact | AssetRegistrationSourceApplicationFileFailure> {
  try {
    const canonical = await realpath(resolve(path));
    const bytes = await readFile(canonical);
    return Object.freeze({ path: canonical, bytes, sha256: sha256(bytes) });
  } catch (error) {
    return failure("unreadable_input", `could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFailure(value: Artifact | AssetRegistrationSourceApplicationFileFailure): value is AssetRegistrationSourceApplicationFileFailure {
  return "ok" in value && value.ok === false;
}

async function readSource(root: string, relativePath: SourceArtifact["relativePath"]): Promise<SourceArtifact | AssetRegistrationSourceApplicationFileFailure> {
  const requested = join(root, relativePath);
  try {
    const lst = await lstat(requested, { bigint: true });
    if (lst.isSymbolicLink() || !lst.isFile()) return failure("source_path_unsafe", `${relativePath} must be a regular non-symlink file`);
    const canonical = await realpath(requested);
    if (!isInside(root, canonical)) return failure("source_path_unsafe", `${relativePath} escapes the repository root`);
    const bytes = await readFile(canonical);
    return Object.freeze({
      path: canonical,
      relativePath,
      bytes,
      sha256: sha256(bytes),
      mode: Number(lst.mode & 0o777n),
      device: lst.dev,
      inode: lst.ino,
    });
  } catch (error) {
    return failure("repository_root_invalid", `could not read canonical source ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function parseJson(artifact: Artifact, label: string): Promise<unknown | AssetRegistrationSourceApplicationFileFailure> {
  try { return JSON.parse(artifact.bytes.toString("utf8")) as unknown; }
  catch (error) { return failure("unreadable_input", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

async function verifyArtifact(artifact: Artifact): Promise<boolean> {
  try { return sha256(await readFile(artifact.path)) === artifact.sha256; } catch { return false; }
}

async function writeExclusive(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function defaultSyncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, fsConstants.O_RDONLY); await handle.sync(); }
  catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(code)) throw error;
  } finally { await handle?.close(); }
}

async function defaultVerifyPatch(_repositoryRoot: string, patchBytes: Buffer, registryBytes: Buffer, packsBytes: Buffer, channelsBytes: Buffer): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "visionx-source-application-check-"));
  try {
    await mkdir(join(directory, "definitions"), { recursive: true });
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "definitions/registry.json"), registryBytes);
    await writeFile(join(directory, "definitions/packs.json"), packsBytes);
    await writeFile(join(directory, "config/channels.json"), channelsBytes);
    const patchPath = join(directory, "change.patch");
    await writeFile(patchPath, patchBytes);
    return await new Promise<boolean>((done) => {
      const child = spawn("git", ["apply", "--check", "--whitespace=nowarn", patchPath], { cwd: directory, stdio: "ignore", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
      child.once("error", () => done(false));
      child.once("exit", (code) => done(code === 0));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function cleanup(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => unlink(path).catch(() => undefined)));
}

async function rollback(replacements: readonly Replacement[], receiptOutput: string, simulateFailure: boolean): Promise<boolean> {
  let ok = true;
  await unlink(receiptOutput).catch((error) => {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) ok = false;
  });
  for (const replacement of [...replacements].reverse()) {
    if (replacement.replaced) {
      if (simulateFailure) { ok = false; continue; }
      try { await rename(replacement.backup, replacement.source.path); }
      catch { ok = false; }
    } else {
      await unlink(replacement.backup).catch(() => undefined);
    }
    await unlink(replacement.temporary).catch(() => undefined);
  }
  for (const replacement of replacements) {
    try {
      if (sha256(await readFile(replacement.source.path)) !== replacement.source.sha256) ok = false;
    } catch { ok = false; }
  }
  return ok;
}

export async function applyAssetRegistrationSourceChangeFile(
  options: ApplyAssetRegistrationSourceChangeFileOptions,
  dependencies: ApplyAssetRegistrationSourceChangeFileDependencies = {},
): Promise<AssetRegistrationSourceApplicationFileResult> {
  let root: string;
  try {
    const requested = resolve(options.repositoryRoot);
    const rootStat = await lstat(requested);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return failure("repository_root_invalid", "repository root must be an explicit non-symlink directory");
    root = await realpath(requested);
  } catch (error) {
    return failure("repository_root_invalid", `repository root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const specs = [
    [options.proposalPath, "proposal"], [options.planningAuthorizationPath, "planning authorization"],
    [options.planPath, "application plan"], [options.patchPath, "source patch"],
    [options.sourceChangeReceiptPath, "source-change receipt"], [options.reviewPath, "source-change review"],
    [options.applicationAuthorizationPath, "application authorization"],
  ] as const;
  const artifacts: Artifact[] = [];
  for (const [path, label] of specs) {
    const artifact = await readArtifact(path, label); if (isFailure(artifact)) return artifact; artifacts.push(artifact);
  }
  if (new Set(artifacts.map((item) => key(item.path))).size !== artifacts.length) return failure("path_collision", "all application inputs must be distinct files");
  const [proposal, planningAuthorization, plan, patch, sourceReceipt, review, applicationAuthorization] = artifacts as [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];

  const registry = await readSource(root, "definitions/registry.json"); if (isFailure(registry)) return registry;
  const packs = await readSource(root, "definitions/packs.json"); if (isFailure(packs)) return packs;
  const channels = await readSource(root, "config/channels.json"); if (isFailure(channels)) return channels;
  const sourceIdentities = [registry, packs, channels].map((item) => `${item.device}:${item.inode}`);
  if (new Set(sourceIdentities).size !== sourceIdentities.length) return failure("source_path_unsafe", "canonical source files must not alias one another");

  const outputRequested = resolve(options.applicationReceiptOutputPath);
  let outputDirectory: string;
  try { outputDirectory = await realpath(dirname(outputRequested)); }
  catch (error) { return failure("repository_root_invalid", `application receipt parent is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  const output = join(outputDirectory, basename(outputRequested));
  if ([...artifacts, registry, packs, channels].some((item) => key(item.path) === key(output))) return failure("path_collision", "application receipt must not collide with inputs or canonical source files");
  if (await pathExists(output)) return failure("output_already_exists", "application receipt output already exists");

  const parsed: unknown[] = [];
  for (const [artifact, label] of [
    [proposal, "proposal"], [planningAuthorization, "planning authorization"], [plan, "application plan"],
    [sourceReceipt, "source-change receipt"], [review, "source-change review"], [applicationAuthorization, "application authorization"],
  ] as const) {
    const value = await parseJson(artifact, label); if (isFailure(value as never)) return value as AssetRegistrationSourceApplicationFileFailure; parsed.push(value);
  }
  const [proposalJson, planningAuthorizationJson, planJson, sourceReceiptJson, reviewJson, applicationAuthorizationJson] = parsed;
  const patchVerified = await (dependencies.verifyPatch ?? defaultVerifyPatch)(root, patch.bytes, registry.bytes, packs.bytes, channels.bytes);
  const prepared = prepareAssetRegistrationSourceApplication({
    proposal: proposalJson, proposalBytes: proposal.bytes, proposalSha256: proposal.sha256,
    planningAuthorization: planningAuthorizationJson, planningAuthorizationBytes: planningAuthorization.bytes, planningAuthorizationSha256: planningAuthorization.sha256,
    applicationPlan: planJson, applicationPlanBytes: plan.bytes, applicationPlanSha256: plan.sha256,
    sourcePatchBytes: patch.bytes, sourcePatchSha256: patch.sha256,
    sourceChangeReceipt: sourceReceiptJson, sourceChangeReceiptBytes: sourceReceipt.bytes, sourceChangeReceiptSha256: sourceReceipt.sha256,
    sourceChangeReview: reviewJson, sourceChangeReviewBytes: review.bytes, sourceChangeReviewSha256: review.sha256,
    applicationAuthorization: applicationAuthorizationJson, applicationAuthorizationBytes: applicationAuthorization.bytes, applicationAuthorizationSha256: applicationAuthorization.sha256,
    registryBytes: registry.bytes, packsBytes: packs.bytes, channelsBytes: channels.bytes,
    patchApplyCheckVerified: patchVerified,
  });
  if (!prepared.ok) return prepared;

  const changes = [
    { source: registry, after: prepared.registryAfterBytes },
    { source: packs, after: prepared.packsAfterBytes },
  ].filter((item) => !item.source.bytes.equals(item.after));
  const replacements: Replacement[] = [];
  const receiptTemporary = join(outputDirectory, `.${basename(output)}.${randomBytes(12).toString("hex")}.tmp`);
  const syncDirectory = dependencies.syncDirectory ?? defaultSyncDirectory;
  try {
    for (const change of changes) {
      const directory = dirname(change.source.path);
      const token = randomBytes(12).toString("hex");
      const temporary = join(directory, `.${basename(change.source.path)}.${token}.future.tmp`);
      const backup = join(directory, `.${basename(change.source.path)}.${token}.rollback.tmp`);
      await writeExclusive(temporary, change.after, change.source.mode);
      await link(change.source.path, backup);
      replacements.push({ source: change.source, after: change.after, temporary, backup, replaced: false });
    }
    await writeExclusive(receiptTemporary, prepared.receiptBytes, 0o600);
  } catch (error) {
    await cleanup([...replacements.flatMap((item) => [item.temporary, item.backup]), receiptTemporary]);
    return failure("temporary_write_failed", `could not prepare application transaction: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const artifact of artifacts) {
    if (!await verifyArtifact(artifact)) { await cleanup([...replacements.flatMap((item) => [item.temporary, item.backup]), receiptTemporary]); return failure("input_changed_during_operation", "an application input changed before source replacement"); }
  }
  for (const source of [registry, packs, channels]) {
    if (!await verifyArtifact(source)) { await cleanup([...replacements.flatMap((item) => [item.temporary, item.backup]), receiptTemporary]); return failure("source_changed_during_operation", "a canonical source changed before source replacement"); }
  }

  let finalReceiptPublished = false;
  try {
    for (let index = 0; index < replacements.length; index += 1) {
      await dependencies.beforeReplacement?.(index);
      const replacement = replacements[index] as Replacement;
      await rename(replacement.temporary, replacement.source.path);
      replacement.replaced = true;
      await syncDirectory(dirname(replacement.source.path));
      await dependencies.afterReplacement?.(index);
    }
    for (const replacement of replacements) {
      if (sha256(await readFile(replacement.source.path)) !== sha256(replacement.after)) throw new Error(`post-state hash mismatch for ${replacement.source.relativePath}`);
    }
    if (sha256(await readFile(channels.path)) !== channels.sha256) throw new Error("channel configuration changed during application");
    await dependencies.beforeReceiptFinalize?.();
    await link(receiptTemporary, output);
    finalReceiptPublished = true;
    await syncDirectory(outputDirectory);
    await unlink(receiptTemporary);
    for (const replacement of replacements) await unlink(replacement.backup);
    for (const directory of new Set(replacements.map((item) => dirname(item.source.path)))) await syncDirectory(directory);
  } catch (error) {
    if (finalReceiptPublished) await unlink(output).catch(() => undefined);
    const restored = await rollback(replacements, output, dependencies.simulateRollbackFailure ?? false);
    await unlink(receiptTemporary).catch(() => undefined);
    if (!restored) return failure("rollback_failed", `application failed and exact rollback could not be proven: ${error instanceof Error ? error.message : String(error)}`);
    const reason: AssetRegistrationSourceApplicationFileFailureReason = replacements.some((item) => item.replaced)
      ? (finalReceiptPublished ? "finalize_failed" : "post_apply_validation_failed")
      : "source_replace_failed";
    return failure(reason, `application failed and sources were restored: ${error instanceof Error ? error.message : String(error)}`);
  }

  return Object.freeze({ ok: true, outputBasename: basename(output), receiptSha256: sha256(prepared.receiptBytes), receipt: prepared.receipt });
}

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, lstat, link, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { AdminService } from "../admin/admin-service.ts";
import { validatePackDraftPromotionRequest, sha256 } from "./pack-draft-promotion.ts";
import {
  preparePackSourceApplication,
  type PackSourceApplicationFailureReason,
  type PackSourceApplicationReceipt,
} from "./pack-source-application.ts";

export type PackSourceApplicationFileFailureReason =
  | "invalid_arguments"
  | "unreadable_input"
  | "repository_root_invalid"
  | "workspace_root_invalid"
  | "source_path_unsafe"
  | "workspace_path_unsafe"
  | "path_collision"
  | "output_already_exists"
  | "input_changed_during_operation"
  | "source_changed_during_operation"
  | "temporary_write_failed"
  | "source_write_failed"
  | "source_write_verification_failed"
  | "application_receipt_finalize_failed"
  | "rollback_failed"
  | "rollback_verification_failed"
  | PackSourceApplicationFailureReason;

export interface PackSourceApplicationFileFailure {
  readonly ok: false;
  readonly reason: PackSourceApplicationFileFailureReason;
  readonly detail: string;
}

export interface PackSourceApplicationFileSuccess {
  readonly ok: true;
  readonly outputBasename: string;
  readonly receiptSha256: string;
  readonly receiptBytes: number;
  readonly receipt: PackSourceApplicationReceipt;
}

export type PackSourceApplicationFileResult = PackSourceApplicationFileSuccess | PackSourceApplicationFileFailure;

export interface ApplyPackSourceChangeFileOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly promotionRequestPath: string;
  readonly proposalPath: string;
  readonly planningAuthorizationPath: string;
  readonly planPath: string;
  readonly patchPath: string;
  readonly sourceChangePath: string;
  readonly reviewDecisionPath: string;
  readonly reviewPath: string;
  readonly applicationAuthorizationPath: string;
  readonly receiptOutputPath: string;
}

export interface ApplyPackSourceChangeFileDependencies {
  readonly verifyPatch?: (patchBytes: Buffer, packsBytes: Buffer) => Promise<boolean>;
  readonly beforeSourceReplace?: () => Promise<void>;
  readonly afterSourceReplace?: () => Promise<void>;
  readonly beforeReceiptFinalize?: () => Promise<void>;
  readonly syncDirectory?: (directory: string) => Promise<void>;
  readonly simulateRollbackFailure?: boolean;
}

interface Artifact { readonly path: string; readonly bytes: Buffer; readonly sha256: string }
interface SourceArtifact extends Artifact { readonly mode: number; readonly device: bigint; readonly inode: bigint }

function failure(reason: PackSourceApplicationFileFailureReason, detail: string): PackSourceApplicationFileFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isFailure(value: Artifact | PackSourceApplicationFileFailure): value is PackSourceApplicationFileFailure {
  return "ok" in value && value.ok === false;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readArtifact(path: string, label: string): Promise<Artifact | PackSourceApplicationFileFailure> {
  try {
    const requested = resolve(path);
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isFile()) return failure("unreadable_input", `${label} must be a regular non-symlink file`);
    const canonical = await realpath(requested);
    const bytes = await readFile(canonical);
    return Object.freeze({ path: canonical, bytes, sha256: sha256(bytes) });
  } catch {
    return failure("unreadable_input", `${label} could not be read`);
  }
}

async function readPacksSource(root: string): Promise<SourceArtifact | PackSourceApplicationFileFailure> {
  const requested = join(root, "definitions/packs.json");
  try {
    const stat = await lstat(requested, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) return failure("source_path_unsafe", "definitions/packs.json must be a regular non-symlink file");
    const canonical = await realpath(requested);
    if (!pathInside(root, canonical)) return failure("source_path_unsafe", "definitions/packs.json escapes the repository root");
    const bytes = await readFile(canonical);
    return Object.freeze({ path: canonical, bytes, sha256: sha256(bytes), mode: Number(stat.mode & 0o777n), device: stat.dev, inode: stat.ino });
  } catch (error) {
    return failure("repository_root_invalid", `Pack source is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJson(artifact: Artifact, label: string): unknown | PackSourceApplicationFileFailure {
  try { return JSON.parse(artifact.bytes.toString("utf8")) as unknown; }
  catch { return failure("unreadable_input", `${label} is not valid JSON`); }
}

function isParseFailure(value: unknown): value is PackSourceApplicationFileFailure {
  return typeof value === "object" && value !== null && "ok" in value && (value as { readonly ok?: unknown }).ok === false;
}

async function unchanged(artifact: Artifact): Promise<boolean> {
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

async function defaultVerifyPatch(patchBytes: Buffer, packsBytes: Buffer): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "visionx-pack-application-check-"));
  try {
    await mkdir(join(directory, "definitions"), { recursive: true });
    await writeFile(join(directory, "definitions/packs.json"), packsBytes);
    const patch = join(directory, "change.patch");
    await writeFile(patch, patchBytes);
    return await new Promise<boolean>((done) => {
      const child = spawn("git", ["apply", "--check", "--whitespace=nowarn", patch], { cwd: directory, stdio: "ignore", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
      child.once("error", () => done(false));
      child.once("exit", (code) => done(code === 0));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function rollback(
  packs: SourceArtifact,
  backup: string,
  temporary: string,
  receiptOutput: string,
  receiptTemporary: string,
  replaced: boolean,
  simulateFailure: boolean,
): Promise<boolean> {
  let ok = true;
  await unlink(receiptOutput).catch((error) => {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) ok = false;
  });
  if (replaced) {
    if (simulateFailure) ok = false;
    else {
      try { await rename(backup, packs.path); } catch { ok = false; }
    }
  } else await unlink(backup).catch(() => undefined);
  await unlink(temporary).catch(() => undefined);
  await unlink(receiptTemporary).catch(() => undefined);
  try { if (sha256(await readFile(packs.path)) !== packs.sha256) ok = false; } catch { ok = false; }
  return ok;
}

export async function applyPackSourceChangeFile(
  options: ApplyPackSourceChangeFileOptions,
  dependencies: ApplyPackSourceChangeFileDependencies = {},
): Promise<PackSourceApplicationFileResult> {
  let service: AdminService;
  try { service = await AdminService.create({ repositoryRoot: options.repositoryRoot, workspaceRoot: options.workspaceRoot }); }
  catch (error) { return failure("repository_root_invalid", error instanceof Error ? error.message : String(error)); }
  const root = service.repositoryRoot;

  const specs = [
    [options.promotionRequestPath, "promotion request"],
    [options.proposalPath, "Pack proposal"],
    [options.planningAuthorizationPath, "planning authorization"],
    [options.planPath, "Pack application plan"],
    [options.patchPath, "Pack source patch"],
    [options.sourceChangePath, "Pack source-change receipt"],
    [options.reviewDecisionPath, "review decision"],
    [options.reviewPath, "Pack source-change review"],
    [options.applicationAuthorizationPath, "Pack application authorization"],
  ] as const;
  const artifacts: Artifact[] = [];
  for (const [path, label] of specs) { const artifact = await readArtifact(path, label); if (isFailure(artifact)) return artifact; artifacts.push(artifact); }
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length) return failure("path_collision", "All application input files must be distinct");
  const [request, proposal, planningAuthorization, plan, patch, sourceChange, reviewDecision, review, applicationAuthorization] = artifacts as [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
  const values = [parseJson(request, "promotion request"), parseJson(proposal, "Pack proposal"), parseJson(planningAuthorization, "planning authorization"), parseJson(plan, "Pack application plan"), parseJson(sourceChange, "Pack source-change receipt"), parseJson(reviewDecision, "review decision"), parseJson(review, "Pack source-change review"), parseJson(applicationAuthorization, "Pack application authorization")];
  const parseFailure = values.find(isParseFailure); if (parseFailure !== undefined) return parseFailure;

  const context = service.promotionContext();
  const requestValidation = validatePackDraftPromotionRequest(values[0], context.channels);
  if (!requestValidation.ok) return failure(requestValidation.reason, requestValidation.detail);
  let draft: Awaited<ReturnType<AdminService["draftArtifact"]>>;
  try { draft = await service.draftArtifact(requestValidation.value.draftId); }
  catch (error) { return failure("draft_not_found", error instanceof Error ? error.message : String(error)); }

  const packs = await readPacksSource(root); if (isFailure(packs)) return packs;
  const outputRequested = resolve(options.receiptOutputPath);
  let outputDirectory: string;
  try { outputDirectory = await realpath(dirname(outputRequested)); }
  catch { return failure("invalid_arguments", "Application receipt output directory is unavailable"); }
  const output = join(outputDirectory, basename(outputRequested));
  if ([...artifacts, packs].some((entry) => entry.path === output)) return failure("path_collision", "Application receipt must not collide with an input or canonical source");
  if (await exists(output)) return failure("output_already_exists", "Application receipt output already exists");

  const patchVerified = await (dependencies.verifyPatch ?? defaultVerifyPatch)(patch.bytes, context.packsBytes);
  const prepared = preparePackSourceApplication({
    promotionRequestValue: values[0], promotionRequestBytes: request.bytes, promotionRequestSha256: request.sha256,
    draftBytes: draft.bytes, draftSha256: sha256(draft.bytes),
    proposalValue: values[1], proposalBytes: proposal.bytes, proposalSha256: proposal.sha256,
    planningAuthorizationValue: values[2], planningAuthorizationBytes: planningAuthorization.bytes, planningAuthorizationSha256: planningAuthorization.sha256,
    applicationPlanValue: values[3], applicationPlanBytes: plan.bytes, applicationPlanSha256: plan.sha256,
    sourcePatchBytes: patch.bytes, sourcePatchSha256: patch.sha256,
    sourceChangeReceiptValue: values[4], sourceChangeReceiptBytes: sourceChange.bytes, sourceChangeReceiptSha256: sourceChange.sha256,
    reviewDecisionValue: values[5], reviewDecisionBytes: reviewDecision.bytes, reviewDecisionSha256: reviewDecision.sha256,
    sourceChangeReviewValue: values[6], sourceChangeReviewBytes: review.bytes, sourceChangeReviewSha256: review.sha256,
    applicationAuthorizationValue: values[7], applicationAuthorizationBytes: applicationAuthorization.bytes, applicationAuthorizationSha256: applicationAuthorization.sha256,
    context, patchApplyCheckVerified: patchVerified,
  });
  if (!prepared.ok) return prepared;

  const token = randomBytes(12).toString("hex");
  const sourceDirectory = dirname(packs.path);
  const future = join(sourceDirectory, `.${basename(packs.path)}.${token}.future.tmp`);
  const backup = join(sourceDirectory, `.${basename(packs.path)}.${token}.rollback.tmp`);
  const receiptTemporary = join(outputDirectory, `.${basename(output)}.${token}.tmp`);
  const syncDirectory = dependencies.syncDirectory ?? defaultSyncDirectory;
  let replaced = false;
  let receiptPublished = false;
  try {
    await writeExclusive(future, prepared.packsAfterBytes, packs.mode);
    await link(packs.path, backup);
    await writeExclusive(receiptTemporary, prepared.receiptBytes, 0o600);
  } catch (error) {
    await Promise.all([rm(future, { force: true }), rm(backup, { force: true }), rm(receiptTemporary, { force: true })]);
    return failure("temporary_write_failed", `Could not prepare Pack source application transaction: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!(await Promise.all(artifacts.map(unchanged))).every(Boolean) || sha256((await service.draftArtifact(requestValidation.value.draftId)).bytes) !== sha256(draft.bytes)) {
    await Promise.all([rm(future, { force: true }), rm(backup, { force: true }), rm(receiptTemporary, { force: true })]);
    return failure("input_changed_during_operation", "An application input or saved draft changed before source replacement");
  }
  const current = service.promotionContext();
  if (current.registrySha256 !== context.registrySha256 || current.packsSha256 !== context.packsSha256 || current.channelsSha256 !== context.channelsSha256 || !await unchanged(packs)) {
    await Promise.all([rm(future, { force: true }), rm(backup, { force: true }), rm(receiptTemporary, { force: true })]);
    return failure("source_changed_during_operation", "Canonical source changed before Pack source replacement");
  }

  let stage: "source_replace" | "source_verification" | "receipt_finalize" = "source_replace";
  try {
    await dependencies.beforeSourceReplace?.();
    await rename(future, packs.path); replaced = true; await syncDirectory(sourceDirectory);
    stage = "source_verification";
    await dependencies.afterSourceReplace?.();
    if (sha256(await readFile(packs.path)) !== sha256(prepared.packsAfterBytes)) throw new Error("Pack source post-state hash mismatch");
    if (sha256(await readFile(join(root, "definitions/registry.json"))) !== context.registrySha256) throw new Error("Registry source changed during Pack application");
    if (sha256(await readFile(join(root, "config/channels.json"))) !== context.channelsSha256) throw new Error("Channel configuration changed during Pack application");
    stage = "receipt_finalize";
    await dependencies.beforeReceiptFinalize?.();
    await link(receiptTemporary, output); receiptPublished = true; await syncDirectory(outputDirectory);
  } catch (error) {
    if (receiptPublished) await unlink(output).catch(() => undefined);
    const restored = await rollback(packs, backup, future, output, receiptTemporary, replaced, dependencies.simulateRollbackFailure ?? false);
    if (!restored) return failure("rollback_failed", `Pack application failed and exact rollback could not be proven: ${error instanceof Error ? error.message : String(error)}`);
    const reason = stage === "source_replace" ? "source_write_failed" : stage === "source_verification" ? "source_write_verification_failed" : "application_receipt_finalize_failed";
    return failure(reason, `Pack application failed and source was restored: ${error instanceof Error ? error.message : String(error)}`);
  }

  await Promise.all([unlink(receiptTemporary).catch(() => undefined), unlink(backup).catch(() => undefined), rm(future, { force: true })]);
  await syncDirectory(sourceDirectory).catch(() => undefined);
  return Object.freeze({ ok: true, outputBasename: basename(output), receiptSha256: sha256(prepared.receiptBytes), receiptBytes: prepared.receiptBytes.length, receipt: prepared.receipt });
}

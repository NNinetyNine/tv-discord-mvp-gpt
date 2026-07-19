import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, lstat, link, mkdir, mkdtemp, open, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { AdminService } from "../admin/admin-service.ts";
import { validatePackDraftPromotionRequest, sha256 } from "./pack-draft-promotion.ts";
import {
  reviewPackSourceChange,
  type PackSourceChangeReviewFailureReason,
  type PackSourceChangeReviewReceipt,
} from "./pack-source-change-review.ts";

export type PackSourceChangeReviewFileFailureReason =
  | "invalid_arguments"
  | "unreadable_input"
  | "repository_root_invalid"
  | "workspace_root_invalid"
  | "path_collision"
  | "output_already_exists"
  | "input_changed_during_operation"
  | "source_changed_during_operation"
  | "temporary_write_failed"
  | "finalize_failed"
  | PackSourceChangeReviewFailureReason;

export interface PackSourceChangeReviewFileFailure {
  readonly ok: false;
  readonly reason: PackSourceChangeReviewFileFailureReason;
  readonly detail: string;
}

export interface PackSourceChangeReviewFileSuccess {
  readonly ok: true;
  readonly outputBasename: string;
  readonly receiptSha256: string;
  readonly receipt: PackSourceChangeReviewReceipt;
}

export type PackSourceChangeReviewFileResult = PackSourceChangeReviewFileSuccess | PackSourceChangeReviewFileFailure;

export interface ReviewPackSourceChangeFileOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly promotionRequestPath: string;
  readonly proposalPath: string;
  readonly planningAuthorizationPath: string;
  readonly planPath: string;
  readonly patchPath: string;
  readonly sourceChangePath: string;
  readonly decisionPath: string;
  readonly outputPath: string;
}

export interface ReviewPackSourceChangeFileDependencies {
  readonly beforeFinalize?: () => Promise<void>;
  readonly verifyPatch?: (patchBytes: Buffer, packsBytes: Buffer) => Promise<boolean>;
}

interface Artifact { readonly path: string; readonly bytes: Buffer; readonly sha256: string }

function failure(reason: PackSourceChangeReviewFileFailureReason, detail: string): PackSourceChangeReviewFileFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isFailure(value: Artifact | PackSourceChangeReviewFileFailure): value is PackSourceChangeReviewFileFailure {
  return "ok" in value && value.ok === false;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readArtifact(path: string, label: string): Promise<Artifact | PackSourceChangeReviewFileFailure> {
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

function parseJson(artifact: Artifact, label: string): unknown | PackSourceChangeReviewFileFailure {
  try { return JSON.parse(artifact.bytes.toString("utf8")) as unknown; }
  catch { return failure("unreadable_input", `${label} is not valid JSON`); }
}

function isParseFailure(value: unknown): value is PackSourceChangeReviewFileFailure {
  return typeof value === "object" && value !== null && "ok" in value && (value as { readonly ok?: unknown }).ok === false;
}

async function unchanged(artifact: Artifact): Promise<boolean> {
  try { return sha256(await readFile(artifact.path)) === artifact.sha256; } catch { return false; }
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, fsConstants.O_RDONLY); await handle.sync(); }
  catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(code)) throw error;
  } finally { await handle?.close(); }
}

async function defaultVerifyPatch(patchBytes: Buffer, packsBytes: Buffer): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "visionx-pack-review-check-"));
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

export async function reviewPackSourceChangeFile(
  options: ReviewPackSourceChangeFileOptions,
  dependencies: ReviewPackSourceChangeFileDependencies = {},
): Promise<PackSourceChangeReviewFileResult> {
  let service: AdminService;
  try { service = await AdminService.create({ repositoryRoot: options.repositoryRoot, workspaceRoot: options.workspaceRoot }); }
  catch (error) { return failure("repository_root_invalid", error instanceof Error ? error.message : String(error)); }

  const specs = [
    [options.promotionRequestPath, "promotion request"],
    [options.proposalPath, "Pack proposal"],
    [options.planningAuthorizationPath, "planning authorization"],
    [options.planPath, "Pack application plan"],
    [options.patchPath, "Pack source patch"],
    [options.sourceChangePath, "Pack source-change receipt"],
    [options.decisionPath, "review decision"],
  ] as const;
  const artifacts: Artifact[] = [];
  for (const [path, label] of specs) { const artifact = await readArtifact(path, label); if (isFailure(artifact)) return artifact; artifacts.push(artifact); }
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length) return failure("path_collision", "All review input files must be distinct");
  const [request, proposal, planningAuthorization, plan, patch, sourceChange, decision] = artifacts as [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];
  const values = [parseJson(request, "promotion request"), parseJson(proposal, "Pack proposal"), parseJson(planningAuthorization, "planning authorization"), parseJson(plan, "Pack application plan"), parseJson(sourceChange, "Pack source-change receipt"), parseJson(decision, "review decision")];
  const parseFailure = values.find(isParseFailure); if (parseFailure !== undefined) return parseFailure;

  const context = service.promotionContext();
  const requestValidation = validatePackDraftPromotionRequest(values[0], context.channels);
  if (!requestValidation.ok) return failure(requestValidation.reason, requestValidation.detail);
  let draft: Awaited<ReturnType<AdminService["draftArtifact"]>>;
  try { draft = await service.draftArtifact(requestValidation.value.draftId); }
  catch (error) { return failure("draft_not_found", error instanceof Error ? error.message : String(error)); }

  const outputRequested = resolve(options.outputPath);
  let outputDirectory: string;
  try { outputDirectory = await realpath(dirname(outputRequested)); }
  catch { return failure("invalid_arguments", "Review output directory is unavailable"); }
  const output = join(outputDirectory, basename(outputRequested));
  if ([...artifacts].some((entry) => entry.path === output)) return failure("path_collision", "Review output must not collide with an input");
  if (await exists(output)) return failure("output_already_exists", "Review output already exists");

  const patchVerified = await (dependencies.verifyPatch ?? defaultVerifyPatch)(patch.bytes, context.packsBytes);
  const result = reviewPackSourceChange({
    promotionRequestValue: values[0], promotionRequestBytes: request.bytes, promotionRequestSha256: request.sha256,
    draftBytes: draft.bytes, draftSha256: sha256(draft.bytes),
    proposalValue: values[1], proposalBytes: proposal.bytes, proposalSha256: proposal.sha256,
    planningAuthorizationValue: values[2], planningAuthorizationBytes: planningAuthorization.bytes, planningAuthorizationSha256: planningAuthorization.sha256,
    applicationPlanValue: values[3], applicationPlanBytes: plan.bytes, applicationPlanSha256: plan.sha256,
    sourcePatchBytes: patch.bytes, sourcePatchSha256: patch.sha256,
    sourceChangeReceiptValue: values[4], sourceChangeReceiptBytes: sourceChange.bytes, sourceChangeReceiptSha256: sourceChange.sha256,
    reviewDecisionValue: values[5], reviewDecisionBytes: decision.bytes, reviewDecisionSha256: decision.sha256,
    context, patchApplyCheckVerified: patchVerified,
  });
  if (!result.ok) return result;

  const temporary = join(outputDirectory, `.${basename(output)}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    await writeExclusive(temporary, result.receiptBytes);
    await dependencies.beforeFinalize?.();
    if (!(await Promise.all(artifacts.map(unchanged))).every(Boolean) || sha256((await service.draftArtifact(requestValidation.value.draftId)).bytes) !== sha256(draft.bytes)) {
      return failure("input_changed_during_operation", "A review input or saved draft changed before finalization");
    }
    const current = service.promotionContext();
    if (current.registrySha256 !== context.registrySha256 || current.packsSha256 !== context.packsSha256 || current.channelsSha256 !== context.channelsSha256) return failure("source_changed_during_operation", "Canonical source changed before review finalization");
    await link(temporary, output); await unlink(temporary); await syncDirectory(outputDirectory);
    return Object.freeze({ ok: true, outputBasename: basename(output), receiptSha256: sha256(result.receiptBytes), receipt: result.receipt });
  } catch (error) {
    return failure("finalize_failed", `Could not finalize Pack source-change review: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await rm(temporary, { force: true }); }
}

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, unlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  reviewAssetRegistrationSourceChange,
  type AssetRegistrationSourceChangeReviewFailureReason,
  type AssetRegistrationSourceChangeReviewReceipt,
} from "./asset-registration-source-change-review.ts";
import { ASSET_REGISTRATION_SOURCE_CHANGE_BASE } from "./asset-registration-source-change-file.ts";

export type AssetRegistrationSourceChangeReviewFileFailureReason =
  | "invalid_arguments"
  | "unreadable_input"
  | "input_changed_during_operation"
  | "path_collision"
  | "output_already_exists"
  | "temporary_write_failed"
  | "finalize_failed"
  | AssetRegistrationSourceChangeReviewFailureReason;

export interface AssetRegistrationSourceChangeReviewFileFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationSourceChangeReviewFileFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationSourceChangeReviewFileSuccess {
  readonly ok: true;
  readonly outputBasename: string;
  readonly receiptSha256: string;
  readonly receipt: AssetRegistrationSourceChangeReviewReceipt;
}

export type AssetRegistrationSourceChangeReviewFileResult =
  | AssetRegistrationSourceChangeReviewFileSuccess
  | AssetRegistrationSourceChangeReviewFileFailure;

export interface ReviewAssetRegistrationSourceChangeFileOptions {
  readonly proposalPath: string;
  readonly planningAuthorizationPath: string;
  readonly planPath: string;
  readonly patchPath: string;
  readonly sourceChangeReceiptPath: string;
  readonly decisionPath: string;
  readonly outputPath: string;
  readonly repositoryRoot?: string;
}

export interface ReviewAssetRegistrationSourceChangeFileDependencies {
  readonly beforeFinalize?: () => Promise<void>;
  readonly verifyPatch?: (repositoryRoot: string, patchBytes: Buffer, registryBytes: Buffer, packsBytes: Buffer, channelsBytes: Buffer) => Promise<boolean>;
}

interface Artifact { readonly path: string; readonly bytes: Buffer; readonly sha256: string }

function failure(reason: AssetRegistrationSourceChangeReviewFileFailureReason, detail: string): AssetRegistrationSourceChangeReviewFileFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function key(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") && Promise.reject(error) as never;
  }
}

async function readArtifact(path: string, label: string): Promise<Artifact | AssetRegistrationSourceChangeReviewFileFailure> {
  try {
    const canonical = await realpath(resolve(path));
    const bytes = await readFile(canonical);
    return Object.freeze({ path: canonical, bytes, sha256: sha256(bytes) });
  } catch (error) {
    return failure("unreadable_input", `could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFailure(value: Artifact | AssetRegistrationSourceChangeReviewFileFailure): value is AssetRegistrationSourceChangeReviewFileFailure {
  return "ok" in value && value.ok === false;
}

async function parseJson(artifact: Artifact, label: string): Promise<unknown | AssetRegistrationSourceChangeReviewFileFailure> {
  try { return JSON.parse(artifact.bytes.toString("utf8")) as unknown; }
  catch (error) { return failure("unreadable_input", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

async function verifyUnchanged(artifact: Artifact): Promise<boolean> {
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

async function defaultVerifyPatch(_repositoryRoot: string, patchBytes: Buffer, registryBytes: Buffer, packsBytes: Buffer, channelsBytes: Buffer): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "visionx-source-review-check-"));
  try {
    await mkdir(join(directory, "definitions"), { recursive: true });
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "definitions/registry.json"), registryBytes);
    await writeFile(join(directory, "definitions/packs.json"), packsBytes);
    await writeFile(join(directory, "config/channels.json"), channelsBytes);
    const patchPath = join(directory, "change.patch");
    await writeFile(patchPath, patchBytes);
    return await new Promise<boolean>((done) => {
      const child = spawn("git", ["apply", "--check", "--whitespace=nowarn", patchPath], {
        cwd: directory,
        stdio: "ignore",
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      });
      child.once("error", () => done(false));
      child.once("exit", (code) => done(code === 0));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function reviewAssetRegistrationSourceChangeFile(
  options: ReviewAssetRegistrationSourceChangeFileOptions,
  dependencies: ReviewAssetRegistrationSourceChangeFileDependencies = {},
): Promise<AssetRegistrationSourceChangeReviewFileResult> {
  const specs = [
    [options.proposalPath, "proposal"], [options.planningAuthorizationPath, "planning authorization"],
    [options.planPath, "application plan"], [options.patchPath, "source patch"],
    [options.sourceChangeReceiptPath, "source-change receipt"], [options.decisionPath, "review decision"],
  ] as const;
  const artifacts: Artifact[] = [];
  for (const [path, label] of specs) {
    const artifact = await readArtifact(path, label);
    if (isFailure(artifact)) return artifact;
    artifacts.push(artifact);
  }
  if (new Set(artifacts.map((item) => key(item.path))).size !== artifacts.length) return failure("path_collision", "all review inputs must be distinct files");
  const [proposal, planningAuthorization, plan, patch, sourceReceipt, decision] = artifacts as [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact];

  const root = await realpath(resolve(options.repositoryRoot ?? "."));
  const registry = await readArtifact(join(root, "definitions/registry.json"), "Registry source");
  if (isFailure(registry)) return registry;
  const packs = await readArtifact(join(root, "definitions/packs.json"), "Pack source");
  if (isFailure(packs)) return packs;
  const channels = await readArtifact(join(root, "config/channels.json"), "channel configuration");
  if (isFailure(channels)) return channels;
  if (registry.sha256 !== ASSET_REGISTRATION_SOURCE_CHANGE_BASE.registrySha256) return failure("stale_registry_state", "Registry source differs from the approved source-change base");
  if (packs.sha256 !== ASSET_REGISTRATION_SOURCE_CHANGE_BASE.packsSha256) return failure("stale_pack_state", "Pack source differs from the approved source-change base");

  const output = resolve(options.outputPath);
  const outputDirectory = await realpath(dirname(output));
  const outputCanonical = join(outputDirectory, basename(output));
  if ([...artifacts, registry, packs, channels].some((item) => key(item.path) === key(outputCanonical))) return failure("path_collision", "review output must not collide with an input or canonical source");
  if (await exists(outputCanonical)) return failure("output_already_exists", "review output already exists");

  const proposalJson = await parseJson(proposal, "proposal"); if (isFailure(proposalJson as never)) return proposalJson as AssetRegistrationSourceChangeReviewFileFailure;
  const authorizationJson = await parseJson(planningAuthorization, "planning authorization"); if (isFailure(authorizationJson as never)) return authorizationJson as AssetRegistrationSourceChangeReviewFileFailure;
  const planJson = await parseJson(plan, "application plan"); if (isFailure(planJson as never)) return planJson as AssetRegistrationSourceChangeReviewFileFailure;
  const receiptJson = await parseJson(sourceReceipt, "source-change receipt"); if (isFailure(receiptJson as never)) return receiptJson as AssetRegistrationSourceChangeReviewFileFailure;
  const decisionJson = await parseJson(decision, "review decision"); if (isFailure(decisionJson as never)) return decisionJson as AssetRegistrationSourceChangeReviewFileFailure;

  const verified = await (dependencies.verifyPatch ?? defaultVerifyPatch)(root, patch.bytes, registry.bytes, packs.bytes, channels.bytes);
  const result = reviewAssetRegistrationSourceChange({
    proposal: proposalJson, proposalBytes: proposal.bytes, proposalSha256: proposal.sha256,
    planningAuthorization: authorizationJson, planningAuthorizationBytes: planningAuthorization.bytes, planningAuthorizationSha256: planningAuthorization.sha256,
    applicationPlan: planJson, applicationPlanBytes: plan.bytes, applicationPlanSha256: plan.sha256,
    sourcePatchBytes: patch.bytes, sourcePatchSha256: patch.sha256,
    sourceChangeReceipt: receiptJson, sourceChangeReceiptBytes: sourceReceipt.bytes, sourceChangeReceiptSha256: sourceReceipt.sha256,
    reviewDecision: decisionJson, reviewDecisionBytes: decision.bytes, reviewDecisionSha256: decision.sha256,
    registryBytes: registry.bytes, packsBytes: packs.bytes, channelsBytes: channels.bytes,
    patchApplyCheckVerified: verified,
  });
  if (!result.ok) return result;

  const temporary = join(outputDirectory, `.${basename(outputCanonical)}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    await writeExclusive(temporary, result.receiptBytes);
    await dependencies.beforeFinalize?.();
    for (const artifact of [...artifacts, registry, packs, channels]) {
      if (!await verifyUnchanged(artifact)) { await unlink(temporary).catch(() => undefined); return failure("input_changed_during_operation", "an input or canonical source changed during review"); }
    }
    await link(temporary, outputCanonical);
    await syncDirectory(outputDirectory);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    await unlink(outputCanonical).catch(() => undefined);
    return failure("finalize_failed", `could not finalize review receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze({ ok: true, outputBasename: basename(outputCanonical), receiptSha256: sha256(result.receiptBytes), receipt: result.receipt });
}

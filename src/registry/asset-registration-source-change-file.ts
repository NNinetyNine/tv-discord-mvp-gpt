import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  generateAssetRegistrationSourceChange,
  type AssetRegistrationSourceChangeFailureReason,
  type AssetRegistrationSourceChangeReceipt,
} from "./asset-registration-source-change.ts";

export const ASSET_REGISTRATION_SOURCE_CHANGE_BASE = Object.freeze({
  commit: "f5ba97bce499684aff210e253652a263dc887f81",
  registrySha256: "1da65e9cade5d5dd516e726787ac9a9ac8f916543de35ccb9d823bd2bb4b1286",
  packsSha256: "29a8284033f1c67466f7a50b54a64d208e72e8dcce25e1cd897a650bdbc3c0b4",
  channelsSha256: "3adb7aa6a40e2a5ef7aa9c19440bfc771b5cbdc4f443ad10e0d3235fca550988",
});

export type AssetRegistrationSourceChangeFileFailureReason =
  | "invalid_arguments"
  | "unreadable_input"
  | "input_changed_during_generation"
  | "path_collision"
  | "output_already_exists"
  | "patch_verification_failed"
  | "temporary_write_failed"
  | "finalize_failed"
  | "rollback_failed"
  | AssetRegistrationSourceChangeFailureReason;

export interface AssetRegistrationSourceChangeFileFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationSourceChangeFileFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationSourceChangeFileSuccess {
  readonly ok: true;
  readonly patchBasename: string;
  readonly receiptBasename: string;
  readonly patchSha256: string;
  readonly receiptSha256: string;
  readonly receipt: AssetRegistrationSourceChangeReceipt;
}

export type AssetRegistrationSourceChangeFileResult =
  | AssetRegistrationSourceChangeFileSuccess
  | AssetRegistrationSourceChangeFileFailure;

export interface GenerateAssetRegistrationSourceChangeFileOptions {
  readonly proposalPath: string;
  readonly authorizationPath: string;
  readonly planPath: string;
  readonly patchOutputPath: string;
  readonly receiptOutputPath: string;
  readonly registryPath?: string;
  readonly packsPath?: string;
  readonly channelsPath?: string;
  readonly repositoryRoot?: string;
  readonly expectedRegistrySha256?: string;
  readonly expectedPacksSha256?: string;
  readonly expectedChannelsSha256?: string;
}

export interface GenerateAssetRegistrationSourceChangeFileDependencies {
  readonly beforeFinalize?: () => Promise<void>;
  readonly beforeSecondFinalize?: () => Promise<void>;
  readonly verifyPatch?: (repositoryRoot: string, patchPath: string) => Promise<boolean>;
}

interface FileArtifact {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface DestinationPath {
  readonly canonical: string;
  readonly directory: string;
  readonly basename: string;
  readonly exists: boolean;
  readonly existingRealPath: string | null;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

function failure(
  reason: AssetRegistrationSourceChangeFileFailureReason,
  detail: string,
): AssetRegistrationSourceChangeFileFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparisonKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readArtifact(path: string, label: string): Promise<FileArtifact | AssetRegistrationSourceChangeFileFailure> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch (error) {
    return failure("unreadable_input", `could not resolve ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const bytes = await readFile(canonical);
    return Object.freeze({ path: canonical, bytes, sha256: hash(bytes) });
  } catch (error) {
    return failure("unreadable_input", `could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFailure(value: FileArtifact | AssetRegistrationSourceChangeFileFailure): value is AssetRegistrationSourceChangeFileFailure {
  return "ok" in value && value.ok === false;
}

async function resolveDestination(path: string): Promise<DestinationPath> {
  const requested = resolve(path);
  const directory = await realpath(dirname(requested));
  const canonical = join(directory, basename(requested));
  const exists = await pathExists(canonical);
  return Object.freeze({
    canonical,
    directory,
    basename: basename(canonical),
    exists,
    existingRealPath: exists ? await realpath(canonical) : null,
  });
}

function destinationCollides(destination: DestinationPath, path: string): boolean {
  const key = comparisonKey(path);
  return comparisonKey(destination.canonical) === key ||
    (destination.existingRealPath !== null && comparisonKey(destination.existingRealPath) === key);
}

function parseJson(artifact: FileArtifact, label: string):
  | { readonly ok: true; readonly value: unknown }
  | AssetRegistrationSourceChangeFileFailure {
  try {
    return Object.freeze({ ok: true, value: JSON.parse(artifact.bytes.toString("utf8")) as unknown });
  } catch (error) {
    return failure("unreadable_input", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyUnchanged(artifact: FileArtifact): Promise<boolean> {
  try {
    return hash(await readFile(artifact.path)) === artifact.sha256;
  } catch {
    return false;
  }
}

async function writeAndSyncNewFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close();
  }
}

async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    return false;
  }
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const stats = await lstat(path, { bigint: true });
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

async function removeOwnedFinal(path: string, expected: FileIdentity): Promise<boolean> {
  try {
    const actual = await fileIdentity(path);
    if (actual.device !== expected.device || actual.inode !== expected.inode) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    return false;
  }
}

async function defaultVerifyPatch(repositoryRoot: string, patchPath: string): Promise<boolean> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["-C", repositoryRoot, "apply", "--check", "--whitespace=nowarn", patchPath], {
      stdio: "ignore",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    child.once("error", () => resolveResult(false));
    child.once("exit", (code) => resolveResult(code === 0));
  });
}

async function finalizePair(
  patchTemporary: string,
  patchDestination: DestinationPath,
  receiptTemporary: string,
  receiptDestination: DestinationPath,
  beforeSecondFinalize?: () => Promise<void>,
): Promise<AssetRegistrationSourceChangeFileFailure | null> {
  let patchIdentity: FileIdentity;
  let receiptIdentity: FileIdentity;
  try {
    patchIdentity = await fileIdentity(patchTemporary);
    receiptIdentity = await fileIdentity(receiptTemporary);
  } catch (error) {
    await removeIfPresent(patchTemporary);
    await removeIfPresent(receiptTemporary);
    return failure("finalize_failed", `could not verify temporary outputs: ${error instanceof Error ? error.message : String(error)}`);
  }
  let patchPublished = false;
  let receiptPublished = false;
  try {
    await link(patchTemporary, patchDestination.canonical);
    patchPublished = true;
    await syncDirectoryBestEffort(patchDestination.directory);
    await beforeSecondFinalize?.();
    await link(receiptTemporary, receiptDestination.canonical);
    receiptPublished = true;
    await syncDirectoryBestEffort(receiptDestination.directory);
    const patchTempRemoved = await removeIfPresent(patchTemporary);
    const receiptTempRemoved = await removeIfPresent(receiptTemporary);
    if (!patchTempRemoved || !receiptTempRemoved) throw new Error("temporary output cleanup failed after finalization");
    return null;
  } catch (error) {
    const patchRolledBack = !patchPublished || await removeOwnedFinal(patchDestination.canonical, patchIdentity);
    const receiptRolledBack = !receiptPublished || await removeOwnedFinal(receiptDestination.canonical, receiptIdentity);
    const patchTempRemoved = await removeIfPresent(patchTemporary);
    const receiptTempRemoved = await removeIfPresent(receiptTemporary);
    if (!(patchRolledBack && receiptRolledBack && patchTempRemoved && receiptTempRemoved)) {
      return failure("rollback_failed", `source-change output finalization failed and rollback was incomplete: ${error instanceof Error ? error.message : String(error)}`);
    }
    return failure("finalize_failed", `source-change output finalization failed; rollback removed partial outputs: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function generateAssetRegistrationSourceChangeFile(
  options: GenerateAssetRegistrationSourceChangeFileOptions,
  dependencies: GenerateAssetRegistrationSourceChangeFileDependencies = {},
): Promise<AssetRegistrationSourceChangeFileResult> {
  const proposal = await readArtifact(options.proposalPath, "proposal");
  if (isFailure(proposal)) return proposal;
  const authorization = await readArtifact(options.authorizationPath, "authorization");
  if (isFailure(authorization)) return authorization;
  const plan = await readArtifact(options.planPath, "application plan");
  if (isFailure(plan)) return plan;

  const inputKeys = [proposal.path, authorization.path, plan.path].map(comparisonKey);
  if (new Set(inputKeys).size !== inputKeys.length) {
    return failure("path_collision", "proposal, authorization, and application plan must be distinct files");
  }

  const registry = await readArtifact(options.registryPath ?? resolve("definitions/registry.json"), "Registry source");
  if (isFailure(registry)) return registry;
  const packs = await readArtifact(options.packsPath ?? resolve("definitions/packs.json"), "Pack source");
  if (isFailure(packs)) return packs;
  const channels = await readArtifact(options.channelsPath ?? resolve("config/channels.json"), "channel configuration");
  if (isFailure(channels)) return channels;

  const expectedRegistry = options.expectedRegistrySha256 ?? ASSET_REGISTRATION_SOURCE_CHANGE_BASE.registrySha256;
  const expectedPacks = options.expectedPacksSha256 ?? ASSET_REGISTRATION_SOURCE_CHANGE_BASE.packsSha256;
  const expectedChannels = options.expectedChannelsSha256;
  if (registry.sha256 !== expectedRegistry) return failure("stale_registry_state", "Registry source SHA-256 differs from the generator base state");
  if (packs.sha256 !== expectedPacks) return failure("stale_pack_state", "Pack source SHA-256 differs from the generator base state");
  if (expectedChannels !== undefined && channels.sha256 !== expectedChannels) {
    return failure("stale_channel_configuration", "channel configuration SHA-256 differs from the explicitly required source state");
  }

  let patchOutput: DestinationPath;
  let receiptOutput: DestinationPath;
  try {
    patchOutput = await resolveDestination(options.patchOutputPath);
    receiptOutput = await resolveDestination(options.receiptOutputPath);
  } catch (error) {
    return failure("temporary_write_failed", `could not resolve output parent: ${error instanceof Error ? error.message : String(error)}`);
  }
  const protectedPaths = [proposal.path, authorization.path, plan.path, registry.path, packs.path, channels.path];
  if (protectedPaths.some((path) => destinationCollides(patchOutput, path) || destinationCollides(receiptOutput, path))) {
    return failure("path_collision", "outputs must not resolve to any input or canonical source file");
  }
  if (
    comparisonKey(patchOutput.canonical) === comparisonKey(receiptOutput.canonical) ||
    (patchOutput.existingRealPath !== null && receiptOutput.existingRealPath !== null &&
      comparisonKey(patchOutput.existingRealPath) === comparisonKey(receiptOutput.existingRealPath))
  ) {
    return failure("path_collision", "patch and receipt outputs must use distinct destinations");
  }
  if (patchOutput.exists || receiptOutput.exists) return failure("output_already_exists", "patch or receipt output already exists");

  const parsedProposal = parseJson(proposal, "proposal");
  if (!parsedProposal.ok) return parsedProposal;
  const parsedAuthorization = parseJson(authorization, "authorization");
  if (!parsedAuthorization.ok) return parsedAuthorization;
  const parsedPlan = parseJson(plan, "application plan");
  if (!parsedPlan.ok) return parsedPlan;

  const generated = generateAssetRegistrationSourceChange({
    proposal: parsedProposal.value,
    proposalBytes: proposal.bytes,
    proposalSha256: proposal.sha256,
    authorization: parsedAuthorization.value,
    authorizationBytes: authorization.bytes,
    authorizationSha256: authorization.sha256,
    applicationPlan: parsedPlan.value,
    applicationPlanBytes: plan.bytes,
    applicationPlanSha256: plan.sha256,
    registryBytes: registry.bytes,
    packsBytes: packs.bytes,
    channelsBytes: channels.bytes,
  });
  if (!generated.ok) return generated;

  const token = randomBytes(12).toString("hex");
  const patchTemporary = join(patchOutput.directory, `.${patchOutput.basename}.visionx-source-change-${token}.tmp`);
  const receiptTemporary = join(receiptOutput.directory, `.${receiptOutput.basename}.visionx-source-change-${token}.tmp`);
  try {
    await writeAndSyncNewFile(patchTemporary, generated.patchBytes);
    await writeAndSyncNewFile(receiptTemporary, generated.receiptBytes);
  } catch (error) {
    const patchCleaned = await removeIfPresent(patchTemporary);
    const receiptCleaned = await removeIfPresent(receiptTemporary);
    return failure("temporary_write_failed", `could not write temporary outputs; cleanup ${patchCleaned && receiptCleaned ? "succeeded" : "was incomplete"}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const patchVerified = await (dependencies.verifyPatch ?? defaultVerifyPatch)(
    resolve(options.repositoryRoot ?? "."),
    patchTemporary,
  );
  if (!patchVerified) {
    await removeIfPresent(patchTemporary);
    await removeIfPresent(receiptTemporary);
    return failure("patch_verification_failed", "generated source patch failed git apply --check");
  }

  try {
    await dependencies.beforeFinalize?.();
  } catch (error) {
    await removeIfPresent(patchTemporary);
    await removeIfPresent(receiptTemporary);
    return failure("finalize_failed", `finalization hook failed before output publication: ${error instanceof Error ? error.message : String(error)}`);
  }

  const artifacts = [proposal, authorization, plan, registry, packs, channels];
  const unchanged = await Promise.all(artifacts.map(verifyUnchanged));
  if (unchanged.some((value) => !value)) {
    await removeIfPresent(patchTemporary);
    await removeIfPresent(receiptTemporary);
    return failure("input_changed_during_generation", "an input or canonical source file changed before finalization");
  }

  const finalizationFailure = await finalizePair(
    patchTemporary,
    patchOutput,
    receiptTemporary,
    receiptOutput,
    dependencies.beforeSecondFinalize,
  );
  if (finalizationFailure !== null) return finalizationFailure;

  return Object.freeze({
    ok: true,
    patchBasename: patchOutput.basename,
    receiptBasename: receiptOutput.basename,
    patchSha256: hash(generated.patchBytes),
    receiptSha256: hash(generated.receiptBytes),
    receipt: generated.receipt,
  });
}

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { loadPacks } from "../packs/packs.ts";
import { loadRegistry } from "./registry.ts";
import {
  planAssetRegistrationApplication,
  serializeAssetRegistrationApplicationPlan,
  type AssetRegistrationApplicationPlan,
  type AssetRegistrationApplicationPlanFailureReason,
} from "./asset-registration-application-plan.ts";

export type AssetRegistrationApplicationPlanFileFailureReason =
  | "invalid_arguments"
  | "unreadable_proposal"
  | "unreadable_authorization"
  | "input_changed_during_planning"
  | "path_collision"
  | "output_already_exists"
  | "temporary_write_failed"
  | "finalize_failed"
  | AssetRegistrationApplicationPlanFailureReason;

export interface AssetRegistrationApplicationPlanFileFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationApplicationPlanFileFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationApplicationPlanFileSuccess {
  readonly ok: true;
  readonly plan: AssetRegistrationApplicationPlan;
  readonly proposalSha256: string;
  readonly authorizationSha256: string;
  readonly outputSha256: string;
}

export type AssetRegistrationApplicationPlanFileResult =
  | AssetRegistrationApplicationPlanFileSuccess
  | AssetRegistrationApplicationPlanFileFailure;

export interface PlanAssetRegistrationApplicationFileOptions {
  readonly proposalPath: string;
  readonly authorizationPath: string;
  readonly outputPath: string;
  readonly registryPath?: string;
  readonly packsPath?: string;
  readonly channelsPath?: string;
}

export interface PlanAssetRegistrationApplicationFileDependencies {
  readonly beforeFinalize?: () => Promise<void>;
}

interface InputArtifact {
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

function failure(
  reason: AssetRegistrationApplicationPlanFileFailureReason,
  detail: string,
): AssetRegistrationApplicationPlanFileFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparisonKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

async function readInput(
  path: string,
  reason: "unreadable_proposal" | "unreadable_authorization",
): Promise<InputArtifact | AssetRegistrationApplicationPlanFileFailure> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch (error) {
    return failure(reason, `could not resolve input: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const bytes = await readFile(canonical);
    return Object.freeze({ path: canonical, bytes, sha256: hash(bytes) });
  } catch (error) {
    return failure(reason, `could not read input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFailure(value: InputArtifact | AssetRegistrationApplicationPlanFileFailure): value is AssetRegistrationApplicationPlanFileFailure {
  return "ok" in value && value.ok === false;
}

async function resolveDestination(path: string): Promise<DestinationPath> {
  const requested = resolve(path);
  const directory = await realpath(dirname(requested));
  const canonical = join(directory, basename(requested));
  let existingRealPath: string | null = null;
  let exists = false;
  try {
    existingRealPath = await realpath(canonical);
    exists = true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  return Object.freeze({ canonical, directory, basename: basename(canonical), exists, existingRealPath });
}

function collides(output: DestinationPath, inputPath: string): boolean {
  const inputKey = comparisonKey(inputPath);
  return comparisonKey(output.canonical) === inputKey ||
    (output.existingRealPath !== null && comparisonKey(output.existingRealPath) === inputKey);
}

async function verifyUnchanged(input: InputArtifact): Promise<boolean> {
  try {
    return hash(await readFile(input.path)) === input.sha256;
  } catch {
    return false;
  }
}

function parseJson(
  input: InputArtifact,
  reason: "unreadable_proposal" | "unreadable_authorization",
): { readonly ok: true; readonly value: unknown } | AssetRegistrationApplicationPlanFileFailure {
  try {
    return Object.freeze({ ok: true, value: JSON.parse(input.bytes.toString("utf8")) as unknown });
  } catch (error) {
    return failure(reason, `input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
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

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function planAssetRegistrationApplicationFile(
  options: PlanAssetRegistrationApplicationFileOptions,
  dependencies: PlanAssetRegistrationApplicationFileDependencies = {},
): Promise<AssetRegistrationApplicationPlanFileResult> {
  const proposal = await readInput(options.proposalPath, "unreadable_proposal");
  if (isFailure(proposal)) return proposal;
  const authorization = await readInput(options.authorizationPath, "unreadable_authorization");
  if (isFailure(authorization)) return authorization;
  if (comparisonKey(proposal.path) === comparisonKey(authorization.path)) {
    return failure("path_collision", "proposal and authorization must be distinct files");
  }

  let output: DestinationPath;
  try {
    output = await resolveDestination(options.outputPath);
  } catch (error) {
    return failure("temporary_write_failed", `could not resolve output parent: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (collides(output, proposal.path) || collides(output, authorization.path)) {
    return failure("path_collision", "application-plan output must not resolve to an input path");
  }
  if (output.exists) return failure("output_already_exists", "application-plan output already exists");

  const parsedProposal = parseJson(proposal, "unreadable_proposal");
  if (!parsedProposal.ok) return parsedProposal;
  const parsedAuthorization = parseJson(authorization, "unreadable_authorization");
  if (!parsedAuthorization.ok) return parsedAuthorization;

  const registryPath = options.registryPath ?? resolve("definitions/registry.json");
  const packsPath = options.packsPath ?? resolve("definitions/packs.json");
  const channelsPath = options.channelsPath ?? resolve("config/channels.json");
  let registry;
  let packs;
  try {
    registry = loadRegistry(registryPath, channelsPath);
    const channels = JSON.parse(await readFile(channelsPath, "utf8")) as Record<string, unknown>;
    packs = loadPacks(
      packsPath,
      new Set(registry.all().map((asset) => asset.id)),
      new Set(Object.keys(channels)),
    );
  } catch (error) {
    return failure("stale_registry_state", `canonical Registry or Pack definitions are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const planned = planAssetRegistrationApplication({
    proposal: parsedProposal.value,
    proposalSha256: proposal.sha256,
    authorization: parsedAuthorization.value,
    authorizationSha256: authorization.sha256,
    assets: registry.all(),
    packs,
  });
  if (!planned.ok) return planned;
  const outputBytes = serializeAssetRegistrationApplicationPlan(planned.plan);

  if (!(await verifyUnchanged(proposal)) || !(await verifyUnchanged(authorization))) {
    return failure("input_changed_during_planning", "proposal or authorization changed during application planning");
  }

  const token = randomBytes(12).toString("hex");
  const temporary = join(output.directory, `.${output.basename}.visionx-asset-plan-${token}.tmp`);
  try {
    await writeAndSyncNewFile(temporary, outputBytes);
  } catch (error) {
    await removeIfPresent(temporary).catch(() => undefined);
    return failure("temporary_write_failed", `could not write temporary application plan: ${error instanceof Error ? error.message : String(error)}`);
  }

  await dependencies.beforeFinalize?.();
  if (!(await verifyUnchanged(proposal)) || !(await verifyUnchanged(authorization))) {
    await removeIfPresent(temporary).catch(() => undefined);
    return failure("input_changed_during_planning", "proposal or authorization changed before plan finalization");
  }

  try {
    await link(temporary, output.canonical);
    await syncDirectoryBestEffort(output.directory);
    await removeIfPresent(temporary);
  } catch (error) {
    await removeIfPresent(temporary).catch(() => undefined);
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") return failure("output_already_exists", "application-plan output appeared before finalization");
    return failure("finalize_failed", `could not finalize application plan: ${error instanceof Error ? error.message : String(error)}`);
  }

  return Object.freeze({
    ok: true,
    plan: planned.plan,
    proposalSha256: proposal.sha256,
    authorizationSha256: authorization.sha256,
    outputSha256: hash(outputBytes),
  });
}

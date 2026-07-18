import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { loadPacks } from "../packs/packs.ts";
import { loadRegistry } from "./registry.ts";
import { loadChannels } from "../wiring/channels.ts";
import {
  proposeAssetRegistration,
  serializeAssetRegistrationProposal,
  type AssetRegistrationProposal,
  type AssetRegistrationProposalFailure,
  type AssetRegistrationProposalFailureReason,
} from "./asset-registration-proposal.ts";

export interface ProposeAssetRegistrationFileOptions {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly registryPath?: string;
  readonly packsPath?: string;
  readonly channelsPath?: string;
}

export type AssetRegistrationFileFailureReason =
  | "invalid_arguments"
  | "unreadable_registration_input"
  | "input_changed_during_proposal"
  | "path_collision"
  | "output_already_exists"
  | "temporary_write_failed"
  | "finalize_failed"
  | AssetRegistrationProposalFailureReason;

export interface AssetRegistrationFileFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationFileFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationFileSuccess {
  readonly ok: true;
  readonly proposal: AssetRegistrationProposal;
  readonly inputSha256: string;
  readonly outputSha256: string;
}

export type AssetRegistrationFileResult = AssetRegistrationFileSuccess | AssetRegistrationFileFailure;

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

function failure(reason: AssetRegistrationFileFailureReason, detail: string): AssetRegistrationFileFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparisonKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

async function readInput(path: string): Promise<InputArtifact | AssetRegistrationFileFailure> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch (error) {
    return failure("unreadable_registration_input", `could not resolve registration input: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const bytes = await readFile(canonical);
    return Object.freeze({ path: canonical, bytes, sha256: hash(bytes) });
  } catch (error) {
    return failure("unreadable_registration_input", `could not read registration input: ${error instanceof Error ? error.message : String(error)}`);
  }
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

async function verifyUnchanged(input: InputArtifact): Promise<boolean> {
  try {
    return hash(await readFile(input.path)) === input.sha256;
  } catch {
    return false;
  }
}

function parseInput(bytes: Buffer): unknown | AssetRegistrationFileFailure {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    return failure("unreadable_registration_input", `registration input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFailure(value: unknown): value is AssetRegistrationFileFailure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

export async function proposeAssetRegistrationFile(
  options: ProposeAssetRegistrationFileOptions,
): Promise<AssetRegistrationFileResult> {
  const input = await readInput(options.inputPath);
  if (isFailure(input)) return input;

  let output: DestinationPath;
  try {
    output = await resolveDestination(options.outputPath);
  } catch (error) {
    return failure("temporary_write_failed", `could not resolve output parent: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    comparisonKey(output.canonical) === comparisonKey(input.path) ||
    (output.existingRealPath !== null && comparisonKey(output.existingRealPath) === comparisonKey(input.path))
  ) {
    return failure("path_collision", "proposal output must not resolve to the registration input");
  }
  if (output.exists) return failure("output_already_exists", "proposal output already exists");

  const parsed = parseInput(input.bytes);
  if (isFailure(parsed)) return parsed;

  const registryPath = options.registryPath ?? resolve("definitions/registry.json");
  const packsPath = options.packsPath ?? resolve("definitions/packs.json");
  const channelsPath = options.channelsPath ?? resolve("config/channels.json");

  let registry;
  let packs;
  let channels: Record<string, unknown>;
  try {
    channels = loadChannels(channelsPath);
    registry = loadRegistry(registryPath, channelsPath);
    packs = loadPacks(
      packsPath,
      new Set(registry.all().map((asset) => asset.id)),
      new Set(Object.keys(channels)),
    );
  } catch (error) {
    return failure("invalid_registration_input", `canonical Registry or Pack definitions are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const proposed = proposeAssetRegistration(parsed, registry.all(), packs, channels);
  if (!proposed.ok) return proposed;
  const outputBytes = serializeAssetRegistrationProposal(proposed.proposal);

  if (!(await verifyUnchanged(input))) {
    return failure("input_changed_during_proposal", "registration input changed during proposal construction");
  }

  const token = randomBytes(12).toString("hex");
  const temporary = join(output.directory, `.${output.basename}.visionx-asset-proposal-${token}.tmp`);
  try {
    await writeAndSyncNewFile(temporary, outputBytes);
  } catch (error) {
    await removeIfPresent(temporary).catch(() => undefined);
    return failure("temporary_write_failed", `could not write temporary proposal: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!(await verifyUnchanged(input))) {
    await removeIfPresent(temporary).catch(() => undefined);
    return failure("input_changed_during_proposal", "registration input changed before proposal finalization");
  }

  try {
    await link(temporary, output.canonical);
    await syncDirectoryBestEffort(output.directory);
    await removeIfPresent(temporary);
  } catch (error) {
    await removeIfPresent(temporary).catch(() => undefined);
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") return failure("output_already_exists", "proposal output appeared before finalization");
    return failure("finalize_failed", `could not finalize proposal: ${error instanceof Error ? error.message : String(error)}`);
  }

  return Object.freeze({
    ok: true,
    proposal: proposed.proposal,
    inputSha256: input.sha256,
    outputSha256: hash(outputBytes),
  });
}

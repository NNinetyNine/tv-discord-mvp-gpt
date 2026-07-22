import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { buildPacks, type Pack } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import { buildRegistry } from "./registry.ts";
import {
  planAssetRegistrationApplication,
  serializeAssetRegistrationApplicationPlan,
  validateAssetRegistrationApplicationPlanReceipt,
  type AssetRegistrationApplicationOperationV2,
  type AssetRegistrationApplicationPlanFailureReason,
  type AssetRegistrationApplicationPlanV2,
  type InsertPackAssetOperation,
} from "./asset-registration-application-plan.ts";
import {
  serializeAssetRegistrationApplicationAuthorization,
  validateAssetRegistrationApplicationAuthorization,
} from "./asset-registration-application-authorization.ts";
import {
  computeAssetRegistrationRegistryFingerprint,
  serializeAssetRegistrationProposal,
  validateAssetRegistrationProposalReceipt,
  type AssetRegistrationProposalV2,
} from "./asset-registration-proposal.ts";

export const ASSET_REGISTRATION_SOURCE_CHANGE_SCHEMA_VERSION = 1 as const;
export const ASSET_REGISTRATION_SOURCE_CHANGE_TYPE = "visionx.asset-registration.source-change" as const;

export type AssetRegistrationSourceChangeFailureReason =
  | "invalid_proposal"
  | "invalid_authorization"
  | "invalid_application_plan"
  | "unsupported_schema_version"
  | "legacy_plan_not_applicable"
  | "application_not_authorized"
  | "application_plan_not_applicable"
  | "proposal_hash_mismatch"
  | "authorization_hash_mismatch"
  | "application_plan_hash_mismatch"
  | "plan_reconstruction_mismatch"
  | "stale_registry_state"
  | "stale_pack_state"
  | "stale_asset_state"
  | "stale_channel_configuration"
  | "unknown_channel"
  | "unresolved_channel"
  | "unsupported_operation"
  | "source_shape_unsupported"
  | "source_serialization_failed"
  | "source_reload_failed"
  | "source_result_mismatch"
  | "patch_generation_failed";

export interface AssetRegistrationSourceChangeFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationSourceChangeFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationSourceChangeReceipt {
  readonly schemaVersion: 1;
  readonly changeType: "visionx.asset-registration.source-change";
  readonly generationStatus: "generated_not_applied";
  readonly technicalValidation: {
    readonly ok: true;
    readonly applicationAuthorized: true;
    readonly proposalVerified: true;
    readonly authorizationVerified: true;
    readonly planReconstructed: true;
    readonly planBytesVerified: true;
    readonly registryFingerprintVerified: true;
    readonly channelConfigurationVerified: true;
    readonly sourceStateVerified: true;
    readonly staleStateDetected: false;
    readonly patchVerified: true;
  };
  readonly inputs: {
    readonly proposalSha256: string;
    readonly authorizationSha256: string;
    readonly applicationPlanSha256: string;
  };
  readonly proposal: {
    readonly operation: "add" | "update_identity";
    readonly assetId: string;
    readonly channel: string;
  };
  readonly sourceState: {
    readonly registry: {
      readonly path: "definitions/registry.json";
      readonly beforeSha256: string;
      readonly afterSha256: string;
      readonly bytesBefore: number;
      readonly bytesAfter: number;
      readonly changed: boolean;
    };
    readonly packs: {
      readonly path: "definitions/packs.json";
      readonly beforeSha256: string;
      readonly afterSha256: string;
      readonly bytesBefore: number;
      readonly bytesAfter: number;
      readonly changed: boolean;
    };
    readonly channels: {
      readonly path: "config/channels.json";
      readonly sha256: string;
      readonly bytes: number;
      readonly changed: false;
    };
  };
  readonly simulatedResult: {
    readonly registryAssetCountBefore: number;
    readonly registryAssetCountAfter: number;
    readonly packMembershipCountBefore: number;
    readonly packMembershipCountAfter: number;
    readonly registryFingerprintBefore: string;
    readonly registryFingerprintAfter: string;
  };
  readonly patch: {
    readonly format: "unified-diff";
    readonly sha256: string;
    readonly bytes: number;
    readonly changedPaths: readonly string[];
  };
  readonly sourceChangesApplied: false;
}

export interface GenerateAssetRegistrationSourceChangeInput {
  readonly proposal: unknown;
  readonly proposalBytes: Buffer;
  readonly proposalSha256: string;
  readonly authorization: unknown;
  readonly authorizationBytes: Buffer;
  readonly authorizationSha256: string;
  readonly applicationPlan: unknown;
  readonly applicationPlanBytes: Buffer;
  readonly applicationPlanSha256: string;
  readonly registryBytes: Buffer;
  readonly packsBytes: Buffer;
  readonly channelsBytes: Buffer;
}

export interface AssetRegistrationSourceChangeSuccess {
  readonly ok: true;
  readonly patchBytes: Buffer;
  readonly receipt: AssetRegistrationSourceChangeReceipt;
  readonly receiptBytes: Buffer;
  readonly registryAfterBytes: Buffer;
  readonly packsAfterBytes: Buffer;
}

export type AssetRegistrationSourceChangeResult =
  | AssetRegistrationSourceChangeSuccess
  | AssetRegistrationSourceChangeFailure;

interface ParsedSourceState {
  readonly registryRaw: Record<string, unknown>;
  readonly packsRaw: readonly unknown[];
  readonly channels: Readonly<Record<string, unknown>>;
  readonly assets: readonly Asset[];
  readonly packs: readonly Pack[];
  readonly registryText: string;
  readonly packsText: string;
}

interface SourceFileChange {
  readonly path: "definitions/registry.json" | "definitions/packs.json";
  readonly before: Buffer;
  readonly after: Buffer;
}

interface DiffOperation {
  readonly tag: " " | "+" | "-";
  readonly text: string;
  readonly oldLine: number;
  readonly newLine: number;
}

function failure(
  reason: AssetRegistrationSourceChangeFailureReason,
  detail: string,
): AssetRegistrationSourceChangeFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceChangeFailure(
  value: ParsedSourceState | AssetRegistrationSourceChangeFailure,
): value is AssetRegistrationSourceChangeFailure {
  return "ok" in value && value.ok === false;
}

function isUnknownFailure(value: unknown): value is AssetRegistrationSourceChangeFailure {
  return isRecord(value) && value.ok === false && typeof value.reason === "string" && typeof value.detail === "string";
}

function decodeCanonicalJsonSource(
  bytes: Buffer,
  name: string,
): string | AssetRegistrationSourceChangeFailure {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return failure("source_shape_unsupported", `${name} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text.startsWith("\uFEFF")) {
    return failure("source_shape_unsupported", `${name} must not contain a UTF-8 BOM`);
  }
  if (text.includes("\r")) {
    return failure("source_shape_unsupported", `${name} must use LF line endings`);
  }
  if (text.endsWith("\n\n")) {
    return failure("source_shape_unsupported", `${name} must not contain multiple trailing newlines`);
  }
  return text;
}

function parseJsonBytes(
  bytes: Buffer,
  name: string,
): unknown | AssetRegistrationSourceChangeFailure {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    return failure("source_shape_unsupported", `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceLines(text: string): string[] {
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

function validateRegistryLineShape(
  text: string,
  raw: Record<string, unknown>,
): Map<string, number> | AssetRegistrationSourceChangeFailure {
  const lines = sourceLines(text);
  if (lines[0]?.trim() !== "{" || lines.at(-1)?.trim() !== "}") {
    return failure("source_shape_unsupported", "definitions/registry.json must be one JSON object with brace-only boundary lines");
  }
  const lineById = new Map<string, number>();
  const entryPattern = /^\s*("(?:\\.|[^"\\])*")\s*:\s*\{.*\}\s*,?\s*$/u;
  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const match = entryPattern.exec(line);
    if (match === null || match[1] === undefined) {
      return failure("source_shape_unsupported", `definitions/registry.json line ${index + 1} is not one complete Asset entry`);
    }
    let id: unknown;
    try {
      id = JSON.parse(match[1]) as unknown;
    } catch {
      return failure("source_shape_unsupported", `definitions/registry.json line ${index + 1} has an invalid Asset id token`);
    }
    if (typeof id !== "string") {
      return failure("source_shape_unsupported", `definitions/registry.json line ${index + 1} has a non-string Asset id`);
    }
    if (lineById.has(id)) {
      return failure("source_shape_unsupported", `definitions/registry.json contains duplicate source entries for Asset ${id}`);
    }
    lineById.set(id, index);
  }
  const rawIds = Object.keys(raw);
  if (lineById.size !== rawIds.length || rawIds.some((id) => !lineById.has(id))) {
    return failure("source_shape_unsupported", "definitions/registry.json source entries do not match its parsed Asset keys");
  }
  return lineById;
}

function parseSourceState(
  registryBytes: Buffer,
  packsBytes: Buffer,
  channelsBytes: Buffer,
): ParsedSourceState | AssetRegistrationSourceChangeFailure {
  const registryText = decodeCanonicalJsonSource(registryBytes, "definitions/registry.json");
  if (typeof registryText !== "string") return registryText;
  const packsText = decodeCanonicalJsonSource(packsBytes, "definitions/packs.json");
  if (typeof packsText !== "string") return packsText;
  const channelsText = decodeCanonicalJsonSource(channelsBytes, "config/channels.json");
  if (typeof channelsText !== "string") return channelsText;

  const registryValue = parseJsonBytes(registryBytes, "definitions/registry.json");
  if (isUnknownFailure(registryValue)) return registryValue;
  if (!isRecord(registryValue)) {
    return failure("source_shape_unsupported", "definitions/registry.json must be an object keyed by Asset id");
  }
  const packsValue = parseJsonBytes(packsBytes, "definitions/packs.json");
  if (isUnknownFailure(packsValue)) return packsValue;
  if (!Array.isArray(packsValue)) {
    return failure("source_shape_unsupported", "definitions/packs.json must be an array");
  }
  const channelsValue = parseJsonBytes(channelsBytes, "config/channels.json");
  if (isUnknownFailure(channelsValue)) return channelsValue;
  if (!isRecord(channelsValue)) {
    return failure("stale_channel_configuration", "config/channels.json must be an object keyed by logical channel");
  }
  const lineShape = validateRegistryLineShape(registryText, registryValue);
  if (!(lineShape instanceof Map)) return lineShape;

  try {
    const registry = buildRegistry(
      registryValue as Parameters<typeof buildRegistry>[0],
      channelsValue,
    );
    const packs = buildPacks(
      packsValue,
      new Set(registry.all().map((asset) => asset.id)),
      new Set(Object.keys(channelsValue)),
    );
    return Object.freeze({
      registryRaw: registryValue,
      packsRaw: Object.freeze([...packsValue]),
      channels: Object.freeze({ ...channelsValue }),
      assets: Object.freeze([...registry.all()]),
      packs: Object.freeze([...packs]),
      registryText,
      packsText,
    });
  } catch (error) {
    return failure("stale_registry_state", `canonical source state is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mapPlanFailure(
  reason: AssetRegistrationApplicationPlanFailureReason,
): AssetRegistrationSourceChangeFailureReason {
  if (reason === "unsupported_schema_version") return "unsupported_schema_version";
  if (reason === "legacy_proposal_not_applicable") return "legacy_plan_not_applicable";
  if (reason === "proposal_hash_mismatch") return "proposal_hash_mismatch";
  if (reason === "stale_registry_state") return "stale_registry_state";
  if (reason === "asset_already_exists" || reason === "unknown_asset" || reason === "stale_asset_state") return "stale_asset_state";
  if (reason === "unknown_channel") return "unknown_channel";
  if (reason === "unresolved_channel") return "unresolved_channel";
  if (
    reason === "unknown_target_pack" ||
    reason === "missing_pack_placement" ||
    reason === "unexpected_pack_placement" ||
    reason === "duplicate_pack_placement" ||
    reason === "invalid_pack_placement" ||
    reason === "unknown_pack_anchor" ||
    reason === "pack_membership_already_exists"
  ) {
    return "stale_pack_state";
  }
  return "invalid_application_plan";
}

function replaceSingleJsonStringProperty(
  line: string,
  property: string,
  value: string,
): string | AssetRegistrationSourceChangeFailure {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`("${escaped}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gu");
  const matches = [...line.matchAll(pattern)];
  if (matches.length !== 1) {
    return failure("source_shape_unsupported", `Asset source line must contain exactly one ${property} string field`);
  }
  return line.replace(pattern, `$1${JSON.stringify(value)}`);
}

function upsertSingleJsonStringPropertyBefore(
  line: string,
  property: string,
  value: string,
  beforeProperty: string,
): string | AssetRegistrationSourceChangeFailure {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`("${escaped}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gu");
  const matches = [...line.matchAll(pattern)];
  if (matches.length > 1) {
    return failure("source_shape_unsupported", `Asset source line must contain at most one ${property} string field`);
  }
  if (matches.length === 1) return line.replace(pattern, `$1${JSON.stringify(value)}`);

  const escapedBefore = beforeProperty.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const beforePattern = new RegExp(`"${escapedBefore}"\\s*:`, "gu");
  const beforeMatches = [...line.matchAll(beforePattern)];
  if (beforeMatches.length !== 1) {
    return failure("source_shape_unsupported", `Asset source line must contain exactly one ${beforeProperty} field to insert ${property}`);
  }
  return line.replace(beforePattern, `${JSON.stringify(property)}: ${JSON.stringify(value)}, $&`);
}

function transformRegistrySource(
  state: ParsedSourceState,
  plan: AssetRegistrationApplicationPlanV2,
): Buffer | AssetRegistrationSourceChangeFailure {
  const identityOperation = plan.operations.find((operation) =>
    operation.type === "add_asset" || operation.type === "update_asset_identity");
  if (identityOperation === undefined) {
    return failure("unsupported_operation", "approved application plan has no Asset identity operation");
  }
  const extraIdentity = plan.operations.filter((operation) =>
    operation.type === "add_asset" || operation.type === "update_asset_identity");
  if (extraIdentity.length !== 1) {
    return failure("unsupported_operation", "approved application plan must contain exactly one Asset identity operation");
  }

  const current = state.registryRaw;
  let candidate: Record<string, unknown>;
  let newText: string;

  if (identityOperation.type === "add_asset") {
    const asset = identityOperation.asset;
    if (Object.prototype.hasOwnProperty.call(current, asset.id)) {
      return failure("stale_asset_state", `Asset ${asset.id} already exists in Registry source`);
    }
    const entry = Object.freeze({
      tradingView: asset.tradingViewSymbol,
      display: asset.displayName,
      currency: asset.currency,
      channel: asset.channel,
    });
    candidate = { ...current, [asset.id]: entry };
    try {
      buildRegistry(candidate as Parameters<typeof buildRegistry>[0], state.channels as Record<string, unknown>);
    } catch (error) {
      return failure("source_serialization_failed", `future Registry failed validation: ${error instanceof Error ? error.message : String(error)}`);
    }
    const trimmedEnd = state.registryText.replace(/\s+$/u, "");
    if (!trimmedEnd.endsWith("}")) {
      return failure("source_shape_unsupported", "definitions/registry.json does not end with a closing object brace");
    }
    const body = trimmedEnd.slice(0, -1).replace(/\s+$/u, "");
    const separator = body.endsWith("{") ? "\n" : ",\n";
    const entryLine =
      `  ${JSON.stringify(asset.id)}: { "tradingView": ${JSON.stringify(asset.tradingViewSymbol)},` +
      ` "display": ${JSON.stringify(asset.displayName)},` +
      ` "currency": ${JSON.stringify(asset.currency)},` +
      ` "channel": ${JSON.stringify(asset.channel)} }`;
    newText = `${body}${separator}${entryLine}\n}\n`;
  } else {
    const asset = identityOperation.asset;
    const currentEntry = current[asset.id];
    if (!isRecord(currentEntry)) {
      return failure("stale_asset_state", `Asset ${asset.id} is absent or malformed in Registry source`);
    }
    const nextEntry: Record<string, unknown> = {};
    const hasCurrency = Object.prototype.hasOwnProperty.call(currentEntry, "currency");
    for (const [key, value] of Object.entries(currentEntry)) {
      if (key === "tradingView") {
        nextEntry[key] = asset.tradingViewSymbol;
      } else if (key === "display") {
        nextEntry[key] = asset.displayName;
      } else if (key === "currency") {
        nextEntry[key] = asset.currency;
      } else if (key === "channel") {
        if (!hasCurrency) nextEntry.currency = asset.currency;
        nextEntry[key] = asset.channel;
      } else {
        nextEntry[key] = value;
      }
    }
    candidate = { ...current, [asset.id]: nextEntry };
    try {
      buildRegistry(candidate as Parameters<typeof buildRegistry>[0], state.channels as Record<string, unknown>);
    } catch (error) {
      return failure("source_serialization_failed", `future Registry failed validation: ${error instanceof Error ? error.message : String(error)}`);
    }
    const lineById = validateRegistryLineShape(state.registryText, current);
    if (!(lineById instanceof Map)) return lineById;
    const lineIndex = lineById.get(asset.id);
    if (lineIndex === undefined) {
      return failure("source_shape_unsupported", `could not locate Asset ${asset.id} source line`);
    }
    const lines = sourceLines(state.registryText);
    let line = lines[lineIndex] ?? "";
    const tradingView = replaceSingleJsonStringProperty(line, "tradingView", asset.tradingViewSymbol);
    if (typeof tradingView !== "string") return tradingView;
    line = tradingView;
    const display = replaceSingleJsonStringProperty(line, "display", asset.displayName);
    if (typeof display !== "string") return display;
    line = display;
    const currency = upsertSingleJsonStringPropertyBefore(line, "currency", asset.currency, "channel");
    if (typeof currency !== "string") return currency;
    line = currency;
    const channel = replaceSingleJsonStringProperty(line, "channel", asset.channel);
    if (typeof channel !== "string") return channel;
    lines[lineIndex] = channel;
    newText = `${lines.join("\n")}\n`;
  }

  try {
    const reparsed = JSON.parse(newText) as unknown;
    if (JSON.stringify(reparsed) !== JSON.stringify(candidate)) {
      return failure("source_serialization_failed", "future Registry bytes do not match the validated candidate Registry");
    }
  } catch (error) {
    return failure("source_serialization_failed", `future Registry serialization is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Buffer.from(newText, "utf8");
}

function locatePackAssetsLine(
  lines: readonly string[],
  packId: string,
): number | AssetRegistrationSourceChangeFailure {
  const idToken = `"id": ${JSON.stringify(packId)}`;
  const idMatches = lines
    .map((line, index) => line.includes(idToken) ? index : -1)
    .filter((index) => index >= 0);
  if (idMatches.length !== 1) {
    return failure("source_shape_unsupported", `definitions/packs.json must contain exactly one source block for Pack ${packId}`);
  }
  const idLine = idMatches[0] ?? -1;
  const assetsMatches: number[] = [];
  for (let index = idLine; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (index > idLine && /^\s*"id"\s*:/u.test(line)) break;
    if (/^\s*"assets"\s*:/u.test(line)) assetsMatches.push(index);
  }
  if (assetsMatches.length !== 1) {
    return failure("source_shape_unsupported", `Pack ${packId} must have exactly one single-line assets field`);
  }
  return assetsMatches[0] ?? -1;
}

function transformPacksSource(
  state: ParsedSourceState,
  plan: AssetRegistrationApplicationPlanV2,
  registryAfterBytes: Buffer,
): Buffer | AssetRegistrationSourceChangeFailure {
  const insertOperations = plan.operations.filter(
    (operation): operation is InsertPackAssetOperation => operation.type === "insert_pack_asset",
  );
  if (insertOperations.length === 0) return Buffer.from(state.packsText, "utf8");

  let candidate: readonly unknown[];
  try {
    candidate = state.packsRaw.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string") return entry;
      const operation = insertOperations.find((item) => item.packId === entry.id);
      if (operation === undefined) return entry;
      if (!Array.isArray(entry.assets)) {
        throw new Error(`Pack ${entry.id} assets are not an array`);
      }
      const assets = [...entry.assets];
      if (assets.includes(operation.assetId)) {
        throw new Error(`Pack ${entry.id} already contains Asset ${operation.assetId}`);
      }
      if (operation.resultingIndex < 0 || operation.resultingIndex > assets.length) {
        throw new Error(`Pack ${entry.id} resultingIndex is outside its membership bounds`);
      }
      assets.splice(operation.resultingIndex, 0, operation.assetId);
      return { ...entry, assets };
    });
  } catch (error) {
    return failure("stale_pack_state", `future Pack transformation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let futureRegistryValue: unknown;
  try {
    futureRegistryValue = JSON.parse(registryAfterBytes.toString("utf8")) as unknown;
  } catch (error) {
    return failure("source_reload_failed", `future Registry could not be reloaded for Pack validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(futureRegistryValue)) {
    return failure("source_reload_failed", "future Registry is not an object");
  }
  let futureRegistry;
  try {
    futureRegistry = buildRegistry(
      futureRegistryValue as Parameters<typeof buildRegistry>[0],
      state.channels as Record<string, unknown>,
    );
    buildPacks(
      candidate,
      new Set(futureRegistry.all().map((asset) => asset.id)),
      new Set(Object.keys(state.channels)),
    );
  } catch (error) {
    return failure("source_serialization_failed", `future Packs failed validation: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lines = sourceLines(state.packsText);
  for (const operation of insertOperations) {
    const pack = candidate.find((entry) => isRecord(entry) && entry.id === operation.packId);
    if (!isRecord(pack) || !Array.isArray(pack.assets)) {
      return failure("stale_pack_state", `Pack ${operation.packId} is absent from future Pack state`);
    }
    const lineIndex = locatePackAssetsLine(lines, operation.packId);
    if (typeof lineIndex !== "number") return lineIndex;
    const original = lines[lineIndex] ?? "";
    const assetsPattern = /("assets"\s*:\s*)\[[^\]]*\](\s*,?\s*)$/u;
    if (!assetsPattern.test(original)) {
      return failure("source_shape_unsupported", `Pack ${operation.packId} assets must be a single-line JSON array`);
    }
    const replacement = `[${pack.assets.map((assetId) => JSON.stringify(assetId)).join(", ")}]`;
    lines[lineIndex] = original.replace(assetsPattern, `$1${replacement}$2`);
  }
  const newText = `${lines.join("\n")}\n`;
  try {
    const reparsed = JSON.parse(newText) as unknown;
    if (JSON.stringify(reparsed) !== JSON.stringify(candidate)) {
      return failure("source_serialization_failed", "future Pack bytes do not match the validated candidate Packs");
    }
  } catch (error) {
    return failure("source_serialization_failed", `future Pack serialization is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Buffer.from(newText, "utf8");
}

interface DiffFileLines {
  readonly lines: readonly string[];
  readonly hasFinalNewline: boolean;
}

function splitDiffLines(bytes: Buffer): DiffFileLines {
  const text = bytes.toString("utf8");
  const hasFinalNewline = text.endsWith("\n");
  return Object.freeze({
    lines: Object.freeze((hasFinalNewline ? text.slice(0, -1) : text).split("\n")),
    hasFinalNewline,
  });
}

function linesEqual(
  before: DiffFileLines,
  after: DiffFileLines,
  oldIndex: number,
  newIndex: number,
): boolean {
  if (before.lines[oldIndex] !== after.lines[newIndex]) return false;
  const oldIsLast = oldIndex === before.lines.length - 1;
  const newIsLast = newIndex === after.lines.length - 1;
  return !(oldIsLast && newIsLast && before.hasFinalNewline !== after.hasFinalNewline);
}

function lineDiff(before: DiffFileLines, after: DiffFileLines): readonly DiffOperation[] {
  const rows = before.lines.length + 1;
  const columns = after.lines.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let oldIndex = before.lines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.lines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex]![newIndex] = linesEqual(before, after, oldIndex, newIndex)
        ? 1 + table[oldIndex + 1]![newIndex + 1]!
        : Math.max(table[oldIndex + 1]![newIndex]!, table[oldIndex]![newIndex + 1]!);
    }
  }
  const operations: DiffOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.lines.length || newIndex < after.lines.length) {
    if (
      oldIndex < before.lines.length &&
      newIndex < after.lines.length &&
      linesEqual(before, after, oldIndex, newIndex)
    ) {
      operations.push({ tag: " ", text: before.lines[oldIndex] ?? "", oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < after.lines.length &&
      (oldIndex >= before.lines.length || table[oldIndex]![newIndex + 1]! > table[oldIndex + 1]![newIndex]!)
    ) {
      operations.push({ tag: "+", text: after.lines[newIndex] ?? "", oldLine: oldIndex + 1, newLine: newIndex + 1 });
      newIndex += 1;
    } else {
      operations.push({ tag: "-", text: before.lines[oldIndex] ?? "", oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex += 1;
    }
  }
  return Object.freeze(operations);
}

function range(start: number, count: number): string {
  if (count === 0) return `${Math.max(0, start - 1)},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function unifiedFileDiff(change: SourceFileChange): string | AssetRegistrationSourceChangeFailure {
  const before = splitDiffLines(change.before);
  const after = splitDiffLines(change.after);
  const operations = lineDiff(before, after);
  const changed = operations
    .map((operation, index) => operation.tag === " " ? -1 : index)
    .filter((index) => index >= 0);
  if (changed.length === 0) return "";
  const context = 3;
  const spans: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(operations.length, index + context + 1);
    const previous = spans.at(-1);
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      spans.push({ start, end });
    }
  }
  const output: string[] = [
    `diff --git a/${change.path} b/${change.path}`,
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
  ];
  for (const span of spans) {
    const hunk = operations.slice(span.start, span.end);
    const first = hunk[0];
    if (first === undefined) return failure("patch_generation_failed", `empty diff hunk for ${change.path}`);
    const oldCount = hunk.filter((operation) => operation.tag !== "+").length;
    const newCount = hunk.filter((operation) => operation.tag !== "-").length;
    output.push(`@@ -${range(first.oldLine, oldCount)} +${range(first.newLine, newCount)} @@`);
    for (const operation of hunk) {
      output.push(`${operation.tag}${operation.text}`);
      const oldMissing =
        operation.tag !== "+" &&
        !before.hasFinalNewline &&
        operation.oldLine === before.lines.length;
      const newMissing =
        operation.tag !== "-" &&
        !after.hasFinalNewline &&
        operation.newLine === after.lines.length;
      if (oldMissing || newMissing) output.push("\\ No newline at end of file");
    }
  }
  return output.join("\n");
}

export function createAssetRegistrationUnifiedPatch(
  changes: readonly SourceFileChange[],
): Buffer | AssetRegistrationSourceChangeFailure {
  const sections: string[] = [];
  for (const change of [...changes].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    if (change.before.equals(change.after)) continue;
    const section = unifiedFileDiff(change);
    if (typeof section !== "string") return section;
    if (section.length > 0) sections.push(section);
  }
  if (sections.length === 0) {
    return failure("patch_generation_failed", "approved application plan produced no source changes");
  }
  return Buffer.from(`${sections.join("\n")}\n`, "utf8");
}

function freezeReceipt(receipt: AssetRegistrationSourceChangeReceipt): AssetRegistrationSourceChangeReceipt {
  return Object.freeze({
    ...receipt,
    technicalValidation: Object.freeze({ ...receipt.technicalValidation }),
    inputs: Object.freeze({ ...receipt.inputs }),
    proposal: Object.freeze({ ...receipt.proposal }),
    sourceState: Object.freeze({
      registry: Object.freeze({ ...receipt.sourceState.registry }),
      packs: Object.freeze({ ...receipt.sourceState.packs }),
      channels: Object.freeze({ ...receipt.sourceState.channels }),
    }),
    simulatedResult: Object.freeze({ ...receipt.simulatedResult }),
    patch: Object.freeze({ ...receipt.patch, changedPaths: Object.freeze([...receipt.patch.changedPaths]) }),
  });
}

export function serializeAssetRegistrationSourceChangeReceipt(
  receipt: AssetRegistrationSourceChangeReceipt,
): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export function generateAssetRegistrationSourceChange(
  input: GenerateAssetRegistrationSourceChangeInput,
): AssetRegistrationSourceChangeResult {
  if (hash(input.proposalBytes) !== input.proposalSha256) {
    return failure("proposal_hash_mismatch", "proposal SHA-256 does not match the supplied proposal bytes");
  }
  if (hash(input.authorizationBytes) !== input.authorizationSha256) {
    return failure("authorization_hash_mismatch", "authorization SHA-256 does not match the supplied authorization bytes");
  }
  if (hash(input.applicationPlanBytes) !== input.applicationPlanSha256) {
    return failure("application_plan_hash_mismatch", "application-plan SHA-256 does not match the supplied plan bytes");
  }

  const sourceState = parseSourceState(input.registryBytes, input.packsBytes, input.channelsBytes);
  if (isSourceChangeFailure(sourceState)) return sourceState;

  const proposalValidation = validateAssetRegistrationProposalReceipt(input.proposal, sourceState.channels);
  if (!proposalValidation.ok) {
    const reason: AssetRegistrationSourceChangeFailureReason =
      proposalValidation.reason === "unsupported_schema_version"
        ? "unsupported_schema_version"
        : proposalValidation.reason === "unknown_channel"
          ? "unknown_channel"
          : proposalValidation.reason === "unresolved_channel"
            ? "unresolved_channel"
            : "invalid_proposal";
    return failure(reason, proposalValidation.detail);
  }
  if (proposalValidation.proposal.schemaVersion !== 2) {
    return failure("legacy_plan_not_applicable", "schemaVersion 1 proposals cannot generate source changes");
  }
  if (!serializeAssetRegistrationProposal(proposalValidation.proposal).equals(input.proposalBytes)) {
    return failure("proposal_hash_mismatch", "proposal bytes are not the canonical deterministic schema-v2 proposal receipt");
  }

  const authorizationValidation = validateAssetRegistrationApplicationAuthorization(input.authorization);
  if (!authorizationValidation.ok) return failure("invalid_authorization", authorizationValidation.detail);
  if (!serializeAssetRegistrationApplicationAuthorization(authorizationValidation.authorization).equals(input.authorizationBytes)) {
    return failure("authorization_hash_mismatch", "authorization bytes are not the canonical deterministic authorization receipt");
  }
  if (authorizationValidation.authorization.proposalSha256 !== input.proposalSha256) {
    return failure("proposal_hash_mismatch", "authorization does not bind to the supplied proposal SHA-256");
  }

  const planValidation = validateAssetRegistrationApplicationPlanReceipt(input.applicationPlan, sourceState.channels);
  if (!planValidation.ok) {
    const reason = planValidation.reason === "unsupported_schema_version"
      ? "unsupported_schema_version"
      : "invalid_application_plan";
    return failure(reason, planValidation.detail);
  }
  if (planValidation.plan.schemaVersion !== 2) {
    return failure("legacy_plan_not_applicable", "schemaVersion 1 application plans cannot generate source changes");
  }

  const reconstructed = planAssetRegistrationApplication({
    proposal: input.proposal,
    proposalSha256: input.proposalSha256,
    authorization: input.authorization,
    authorizationSha256: input.authorizationSha256,
    assets: sourceState.assets,
    packs: sourceState.packs,
    channels: sourceState.channels,
  });
  if (!reconstructed.ok) return failure(mapPlanFailure(reconstructed.reason), reconstructed.detail);
  const reconstructedBytes = serializeAssetRegistrationApplicationPlan(reconstructed.plan);
  if (!reconstructedBytes.equals(input.applicationPlanBytes)) {
    return failure("plan_reconstruction_mismatch", "supplied application-plan bytes differ from a fresh canonical reconstruction");
  }
  const plan = reconstructed.plan;
  if (
    plan.applicationAuthorized !== true ||
    plan.applicationStatus !== "planned_not_applied" ||
    plan.technicalValidation.ok !== true ||
    plan.technicalValidation.registryFingerprintVerified !== true ||
    plan.technicalValidation.channelConfigurationVerified !== true ||
    plan.technicalValidation.staleStateDetected !== false ||
    plan.sourceChangesApplied !== false
  ) {
    return failure("application_not_authorized", "application plan is not an approved unapplied schema-v2 plan");
  }
  if (authorizationValidation.authorization.decision !== "approved") {
    return failure("application_not_authorized", "application authorization decision is not approved");
  }

  const registryAfter = transformRegistrySource(sourceState, plan);
  if (!Buffer.isBuffer(registryAfter)) return registryAfter;
  const packsAfter = transformPacksSource(sourceState, plan, registryAfter);
  if (!Buffer.isBuffer(packsAfter)) return packsAfter;

  let futureRegistry;
  let futurePacks: readonly Pack[];
  try {
    const registryValue = JSON.parse(registryAfter.toString("utf8")) as unknown;
    const packsValue = JSON.parse(packsAfter.toString("utf8")) as unknown;
    if (!isRecord(registryValue) || !Array.isArray(packsValue)) {
      return failure("source_reload_failed", "future source bytes do not have canonical Registry and Pack JSON shapes");
    }
    futureRegistry = buildRegistry(
      registryValue as Parameters<typeof buildRegistry>[0],
      sourceState.channels as Record<string, unknown>,
    );
    futurePacks = buildPacks(
      packsValue,
      new Set(futureRegistry.all().map((asset) => asset.id)),
      new Set(Object.keys(sourceState.channels)),
    );
  } catch (error) {
    return failure("source_reload_failed", `future source bytes failed canonical reload: ${error instanceof Error ? error.message : String(error)}`);
  }

  const membershipCount = futurePacks.reduce((total, pack) => total + pack.assets.length, 0);
  const fingerprint = computeAssetRegistrationRegistryFingerprint(futureRegistry.all(), futurePacks);
  if (
    futureRegistry.all().length !== plan.simulatedResult.registryAssetCountAfter ||
    membershipCount !== plan.simulatedResult.packMembershipCountAfter ||
    fingerprint !== plan.simulatedResult.registryFingerprintAfter
  ) {
    return failure("source_result_mismatch", "reloaded future source state does not match the approved plan simulation");
  }
  const futureAsset = futureRegistry.all().find((asset) => asset.id === plan.proposal.assetId);
  if (futureAsset === undefined || futureAsset.channel !== plan.proposal.channel) {
    return failure("source_result_mismatch", "future Registry does not preserve the approved logical Asset channel");
  }

  const changes: SourceFileChange[] = [
    { path: "definitions/registry.json", before: input.registryBytes, after: registryAfter },
    { path: "definitions/packs.json", before: input.packsBytes, after: packsAfter },
  ];
  const patchBytes = createAssetRegistrationUnifiedPatch(changes);
  if (!Buffer.isBuffer(patchBytes)) return patchBytes;
  const changedPaths = changes
    .filter((change) => !change.before.equals(change.after))
    .map((change) => change.path)
    .sort((left, right) => left.localeCompare(right, "en"));

  const receipt = freezeReceipt({
    schemaVersion: ASSET_REGISTRATION_SOURCE_CHANGE_SCHEMA_VERSION,
    changeType: ASSET_REGISTRATION_SOURCE_CHANGE_TYPE,
    generationStatus: "generated_not_applied",
    technicalValidation: Object.freeze({
      ok: true,
      applicationAuthorized: true,
      proposalVerified: true,
      authorizationVerified: true,
      planReconstructed: true,
      planBytesVerified: true,
      registryFingerprintVerified: true,
      channelConfigurationVerified: true,
      sourceStateVerified: true,
      staleStateDetected: false,
      patchVerified: true,
    }),
    inputs: Object.freeze({
      proposalSha256: input.proposalSha256,
      authorizationSha256: input.authorizationSha256,
      applicationPlanSha256: input.applicationPlanSha256,
    }),
    proposal: Object.freeze({
      operation: plan.proposal.operation,
      assetId: plan.proposal.assetId,
      channel: plan.proposal.channel,
    }),
    sourceState: Object.freeze({
      registry: Object.freeze({
        path: "definitions/registry.json",
        beforeSha256: hash(input.registryBytes),
        afterSha256: hash(registryAfter),
        bytesBefore: input.registryBytes.byteLength,
        bytesAfter: registryAfter.byteLength,
        changed: !input.registryBytes.equals(registryAfter),
      }),
      packs: Object.freeze({
        path: "definitions/packs.json",
        beforeSha256: hash(input.packsBytes),
        afterSha256: hash(packsAfter),
        bytesBefore: input.packsBytes.byteLength,
        bytesAfter: packsAfter.byteLength,
        changed: !input.packsBytes.equals(packsAfter),
      }),
      channels: Object.freeze({
        path: "config/channels.json",
        sha256: hash(input.channelsBytes),
        bytes: input.channelsBytes.byteLength,
        changed: false,
      }),
    }),
    simulatedResult: Object.freeze({
      registryAssetCountBefore: plan.simulatedResult.registryAssetCountBefore,
      registryAssetCountAfter: plan.simulatedResult.registryAssetCountAfter,
      packMembershipCountBefore: plan.simulatedResult.packMembershipCountBefore,
      packMembershipCountAfter: plan.simulatedResult.packMembershipCountAfter,
      registryFingerprintBefore: plan.simulatedResult.registryFingerprintBefore,
      registryFingerprintAfter: plan.simulatedResult.registryFingerprintAfter,
    }),
    patch: Object.freeze({
      format: "unified-diff",
      sha256: hash(patchBytes),
      bytes: patchBytes.byteLength,
      changedPaths: Object.freeze(changedPaths),
    }),
    sourceChangesApplied: false,
  });
  const receiptBytes = serializeAssetRegistrationSourceChangeReceipt(receipt);
  return Object.freeze({
    ok: true,
    patchBytes,
    receipt,
    receiptBytes,
    registryAfterBytes: registryAfter,
    packsAfterBytes: packsAfter,
  });
}

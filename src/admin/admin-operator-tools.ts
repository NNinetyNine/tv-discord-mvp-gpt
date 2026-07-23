import { createHash } from "node:crypto";

import type { Asset } from "../types.ts";
import { buildPacks, type Pack } from "../packs/packs.ts";
import { AdminError } from "./admin-types.ts";

const PACK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ASSET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export type AdminPackMaintenanceInput =
  | {
      readonly operation: "update";
      readonly packId: string;
      readonly displayName: string;
      readonly logicalChannel: string;
      readonly assetIds: readonly string[];
      readonly packOrder: readonly string[];
    }
  | {
      readonly operation: "delete";
      readonly packId: string;
    };

export interface AdminPackMaintenancePreview {
  readonly schemaVersion: 1;
  readonly previewId: string;
  readonly operation: "update" | "delete";
  readonly packId: string;
  readonly packDisplayName: string;
  readonly sourceState: {
    readonly packsSha256: string;
  };
  readonly workspace: {
    readonly state: "empty" | "building" | "complete";
    readonly capturedCount: number;
  };
  readonly boundThreadCount: number;
  readonly changes: readonly {
    readonly field: "displayName" | "logicalChannel" | "membership" | "assetOrder" | "packOrder" | "definition";
    readonly before: unknown;
    readonly after: unknown;
  }[];
  readonly blockers: readonly {
    readonly code: "pack_not_empty" | "thread_bindings_exist";
    readonly detail: string;
  }[];
  readonly ready: boolean;
  readonly confirmation: string;
  readonly candidatePacks: readonly Pack[];
}

export interface AdminAliasChangeInput {
  readonly assetId: string;
  readonly operation: "add" | "remove";
  readonly alias: string;
}

export interface AdminAliasChangePreview {
  readonly schemaVersion: 1;
  readonly previewId: string;
  readonly assetId: string;
  readonly displayName: string;
  readonly operation: "add" | "remove";
  readonly alias: string;
  readonly aliasesBefore: readonly string[];
  readonly aliasesAfter: readonly string[];
  readonly registrySha256: string;
  readonly confirmation: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nonEmptyString(value: unknown, label: string, max = 120): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AdminError("invalid_request", `${label} must be a non-empty single-line value of at most ${max} characters.`);
  }
  return value;
}

function safePackId(value: unknown): string {
  const packId = nonEmptyString(value, "Pack ID", 64);
  if (!PACK_ID.test(packId)) throw new AdminError("invalid_request", "Pack ID must be a lowercase safe slug.");
  return packId;
}

function stringArray(value: unknown, label: string, matcher: RegExp): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new AdminError("invalid_request", `${label} must be a nonempty array.`);
  const out = value.map((item) => nonEmptyString(item, label, 64));
  if (out.some((item) => !matcher.test(item))) throw new AdminError("invalid_request", `${label} contains an invalid identifier.`);
  if (new Set(out).size !== out.length) throw new AdminError("invalid_request", `${label} cannot contain duplicates.`);
  return Object.freeze(out);
}

export function parsePackMaintenanceInput(value: unknown): AdminPackMaintenanceInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AdminError("invalid_request", "Pack maintenance input must be an object.");
  const record = value as Record<string, unknown>;
  if (record.operation === "delete") {
    const allowed = new Set(["operation", "packId"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new AdminError("invalid_request", "Delete Pack input contains unexpected fields.");
    return Object.freeze({ operation: "delete", packId: safePackId(record.packId) });
  }
  if (record.operation !== "update") throw new AdminError("invalid_request", "Pack maintenance operation must be update or delete.");
  const allowed = new Set(["operation", "packId", "displayName", "logicalChannel", "assetIds", "packOrder"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new AdminError("invalid_request", "Update Pack input contains unexpected fields.");
  return Object.freeze({
    operation: "update",
    packId: safePackId(record.packId),
    displayName: nonEmptyString(record.displayName, "Display Name"),
    logicalChannel: nonEmptyString(record.logicalChannel, "Logical Channel", 64),
    assetIds: stringArray(record.assetIds, "Asset IDs", ASSET_ID),
    packOrder: stringArray(record.packOrder, "Pack order", PACK_ID),
  });
}

export function buildPackMaintenancePreview(input: {
  readonly value: unknown;
  readonly packs: readonly Pack[];
  readonly assets: readonly Asset[];
  readonly channelNames: ReadonlySet<string>;
  readonly packsSha256: string;
  readonly workspaceState: "empty" | "building" | "complete";
  readonly capturedCount: number;
  readonly boundThreadCount: number;
}): AdminPackMaintenancePreview {
  const request = parsePackMaintenanceInput(input.value);
  const current = input.packs.find((pack) => pack.id === request.packId);
  if (current === undefined) throw new AdminError("pack_not_found", `Pack ${request.packId} was not found.`, 404);
  const validIds = new Set(input.assets.map((asset) => asset.id));
  const changes: AdminPackMaintenancePreview["changes"][number][] = [];
  let candidateRaw: readonly unknown[];

  if (request.operation === "delete") {
    candidateRaw = input.packs.filter((pack) => pack.id !== request.packId).map((pack) => ({ ...pack, assets: [...pack.assets] }));
    try { buildPacks(candidateRaw, validIds, input.channelNames); }
    catch (error) { throw new AdminError("pack_maintenance_invalid", error instanceof Error ? error.message : String(error), 409); }
    changes.push(Object.freeze({ field: "definition", before: current.id, after: null }));
  } else {
    if (!input.channelNames.has(request.logicalChannel)) throw new AdminError("invalid_request", `Logical Channel ${request.logicalChannel} is not configured.`);
    if (request.packOrder.length !== input.packs.length || request.packOrder.some((id) => !input.packs.some((pack) => pack.id === id))) {
      throw new AdminError("invalid_request", "Pack order must list every current Pack exactly once.");
    }
    for (const assetId of request.assetIds) {
      if (!validIds.has(assetId)) throw new AdminError("asset_not_found", `Asset ${assetId} was not found.`, 404);
      const owner = input.packs.find((pack) => pack.id !== request.packId && pack.assets.includes(assetId));
      if (owner !== undefined) throw new AdminError("pack_membership_conflict", `Asset ${assetId} already belongs to Pack ${owner.id}.`, 409);
    }
    const changedPack = Object.freeze({ id: current.id, display: request.displayName, channel: request.logicalChannel, assets: Object.freeze([...request.assetIds]) });
    const byId = new Map(input.packs.map((pack) => [pack.id, pack.id === current.id ? changedPack : pack] as const));
    candidateRaw = request.packOrder.map((id) => {
      const pack = byId.get(id);
      if (pack === undefined) throw new AdminError("invalid_request", `Pack order contains unknown Pack ${id}.`);
      return { id: pack.id, display: pack.display, channel: pack.channel, assets: [...pack.assets] };
    });
    try { buildPacks(candidateRaw, validIds, input.channelNames); }
    catch (error) { throw new AdminError("pack_maintenance_invalid", error instanceof Error ? error.message : String(error), 409); }
    if (current.display !== request.displayName) changes.push(Object.freeze({ field: "displayName", before: current.display, after: request.displayName }));
    if (current.channel !== request.logicalChannel) changes.push(Object.freeze({ field: "logicalChannel", before: current.channel, after: request.logicalChannel }));
    const sameMembers = current.assets.length === request.assetIds.length && current.assets.every((id) => request.assetIds.includes(id));
    if (!sameMembers) changes.push(Object.freeze({ field: "membership", before: [...current.assets], after: [...request.assetIds] }));
    else if (current.assets.some((id, index) => request.assetIds[index] !== id)) changes.push(Object.freeze({ field: "assetOrder", before: [...current.assets], after: [...request.assetIds] }));
    if (input.packs.some((pack, index) => request.packOrder[index] !== pack.id)) changes.push(Object.freeze({ field: "packOrder", before: input.packs.map((pack) => pack.id), after: [...request.packOrder] }));
    if (changes.length === 0) throw new AdminError("no_change", "The proposed Pack maintenance operation changes nothing.");
  }

  const blockers: AdminPackMaintenancePreview["blockers"][number][] = [];
  const membershipSensitive = changes.some((change) => change.field === "membership" || change.field === "assetOrder");
  if ((request.operation === "delete" || membershipSensitive) && input.workspaceState !== "empty") {
    blockers.push(Object.freeze({ code: "pack_not_empty", detail: `Pack ${request.packId} is ${input.workspaceState}; reset or publish its ${input.capturedCount} current analyses before changing membership or deleting it.` }));
  }
  const routeSensitive = request.operation === "delete" || changes.some((change) => change.field === "logicalChannel");
  if (routeSensitive && input.boundThreadCount > 0) {
    blockers.push(Object.freeze({ code: "thread_bindings_exist", detail: `Pack ${request.packId} owns ${input.boundThreadCount} persistent thread bindings. Remove or migrate those bindings before changing its route or deleting it.` }));
  }

  const candidatePacks = buildPacks(candidateRaw, validIds, input.channelNames);
  const confirmation = request.operation === "delete"
    ? `DELETE PACK ${request.packId.toUpperCase()}`
    : `APPLY PACK ${request.packId.toUpperCase()}`;
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    operation: request.operation,
    packId: request.packId,
    packDisplayName: current.display,
    sourceState: Object.freeze({ packsSha256: input.packsSha256 }),
    workspace: Object.freeze({ state: input.workspaceState, capturedCount: input.capturedCount }),
    boundThreadCount: input.boundThreadCount,
    changes: Object.freeze(changes),
    blockers: Object.freeze(blockers),
    ready: blockers.length === 0,
    confirmation,
    candidatePacks: Object.freeze(candidatePacks.map((pack) => Object.freeze({ ...pack, assets: Object.freeze([...pack.assets]) }))),
  });
  return Object.freeze({ ...payload, previewId: hash(payload) });
}

export function buildAliasChangePreview(input: {
  readonly value: unknown;
  readonly asset: Asset;
  readonly registrySha256: string;
  readonly allAssets: readonly Asset[];
}): AdminAliasChangePreview {
  if (typeof input.value !== "object" || input.value === null || Array.isArray(input.value)) throw new AdminError("invalid_request", "Alias change input must be an object.");
  const record = input.value as Record<string, unknown>;
  const allowed = new Set(["assetId", "operation", "alias"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new AdminError("invalid_request", "Alias change input contains unexpected fields.");
  if (record.assetId !== input.asset.id) throw new AdminError("invalid_request", "Alias change Asset ID does not match the route Asset.");
  if (record.operation !== "add" && record.operation !== "remove") throw new AdminError("invalid_request", "Alias operation must be add or remove.");
  const alias = nonEmptyString(record.alias, "Alias", 96);
  const aliasesBefore = Object.freeze([...(input.asset.tradingViewAliases ?? [])]);
  const folded = alias.toLocaleUpperCase("en-US");
  const matchingExisting = aliasesBefore.find((item) => item.toLocaleUpperCase("en-US") === folded);
  let aliasesAfter: readonly string[];
  if (record.operation === "add") {
    if (matchingExisting !== undefined || input.asset.tradingView.toLocaleUpperCase("en-US") === folded) throw new AdminError("alias_conflict", "That alias is already assigned to this Asset.", 409);
    for (const asset of input.allAssets) {
      if (asset.id === input.asset.id) continue;
      const tokens = [asset.tradingView, ...(asset.tradingViewAliases ?? [])].map((item) => item.toLocaleUpperCase("en-US"));
      if (tokens.includes(folded)) throw new AdminError("alias_conflict", `Alias ${alias} is already assigned to Asset ${asset.id}.`, 409);
    }
    aliasesAfter = Object.freeze([...aliasesBefore, alias]);
  } else {
    if (matchingExisting === undefined) throw new AdminError("alias_not_found", `Alias ${alias} is not assigned to Asset ${input.asset.id}.`, 404);
    aliasesAfter = Object.freeze(aliasesBefore.filter((item) => item !== matchingExisting));
  }
  const canonicalAlias = record.operation === "remove" ? matchingExisting ?? alias : alias;
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    assetId: input.asset.id,
    displayName: input.asset.display,
    operation: record.operation,
    alias: canonicalAlias,
    aliasesBefore,
    aliasesAfter,
    registrySha256: input.registrySha256,
    confirmation: `APPLY ALIAS ${input.asset.id.toUpperCase()}`,
  });
  return Object.freeze({ ...payload, previewId: hash(payload) });
}

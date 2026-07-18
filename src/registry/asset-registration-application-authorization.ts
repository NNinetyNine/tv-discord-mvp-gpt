/**
 * Explicit curator authorization for planning a previously validated Asset
 * registration proposal. Authorization is a separate artifact from the
 * proposal and never implies that source definitions have been changed.
 */

export const ASSET_APPLICATION_AUTHORIZATION_MAX_LENGTHS = Object.freeze({
  reviewerId: 64,
  decidedAt: 40,
  referenceId: 96,
  notes: 500,
});

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u;
const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

export type AssetApplicationAuthorizationDecision = "approved" | "rejected";
export type AssetPackPlacementMode = "append" | "before" | "after";

export interface AssetPackPlacementAppend {
  readonly mode: "append";
}

export interface AssetPackPlacementRelative {
  readonly mode: "before" | "after";
  readonly anchorAssetId: string;
}

export type AssetPackPlacement = AssetPackPlacementAppend | AssetPackPlacementRelative;

export interface AssetApplicationPackPlacement {
  readonly packId: string;
  readonly placement: AssetPackPlacement;
}

export interface AssetRegistrationApplicationAuthorization {
  readonly schemaVersion: 1;
  readonly decision: AssetApplicationAuthorizationDecision;
  readonly proposalSha256: string;
  readonly reviewerId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly packPlacements: readonly AssetApplicationPackPlacement[];
  readonly notes?: string;
}

export type AssetApplicationAuthorizationFailureReason =
  | "invalid_authorization"
  | "unsupported_decision"
  | "duplicate_pack_placement"
  | "invalid_pack_placement";

export interface AssetApplicationAuthorizationFailure {
  readonly ok: false;
  readonly reason: AssetApplicationAuthorizationFailureReason;
  readonly detail: string;
}

export interface AssetApplicationAuthorizationSuccess {
  readonly ok: true;
  readonly authorization: AssetRegistrationApplicationAuthorization;
}

export type AssetApplicationAuthorizationResult =
  | AssetApplicationAuthorizationSuccess
  | AssetApplicationAuthorizationFailure;

function failure(
  reason: AssetApplicationAuthorizationFailureReason,
  detail: string,
): AssetApplicationAuthorizationFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  where: string,
): AssetApplicationAuthorizationFailure | null {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  return unknown.length === 0
    ? null
    : failure(
      "invalid_authorization",
      `${where} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
}

function exactString(
  value: unknown,
  field: keyof typeof ASSET_APPLICATION_AUTHORIZATION_MAX_LENGTHS,
  multiline: boolean,
): string | AssetApplicationAuthorizationFailure {
  if (typeof value !== "string") {
    return failure("invalid_authorization", `${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    return failure("invalid_authorization", `${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    return failure("invalid_authorization", `${field} must not contain outer whitespace`);
  }
  if ((multiline ? MULTILINE_CONTROL : SINGLE_LINE_CONTROL).test(value)) {
    return failure(
      "invalid_authorization",
      `${field} contains forbidden control characters${multiline ? "" : " or newlines"}`,
    );
  }
  if (value.length > ASSET_APPLICATION_AUTHORIZATION_MAX_LENGTHS[field]) {
    return failure(
      "invalid_authorization",
      `${field} exceeds maximum length ${ASSET_APPLICATION_AUTHORIZATION_MAX_LENGTHS[field]}`,
    );
  }
  return value;
}

function validTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const date = match[1];
  if (date === undefined) return false;
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
}


function isAuthorizationFailure(
  value: AssetPackPlacement | AssetApplicationAuthorizationFailure,
): value is AssetApplicationAuthorizationFailure {
  return "ok" in value && value.ok === false;
}

function validatePackId(value: unknown, where: string): string | AssetApplicationAuthorizationFailure {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || SINGLE_LINE_CONTROL.test(value)) {
    return failure("invalid_pack_placement", `${where} must be an exact non-empty string`);
  }
  return value;
}

function validatePlacement(
  value: unknown,
  where: string,
): AssetPackPlacement | AssetApplicationAuthorizationFailure {
  if (!isRecord(value)) {
    return failure("invalid_pack_placement", `${where} must be a JSON object`);
  }
  if (value.mode === "append") {
    const unknown = unknownFields(value, new Set(["mode"]), where);
    if (unknown !== null) return failure("invalid_pack_placement", unknown.detail);
    return Object.freeze({ mode: "append" });
  }
  if (value.mode === "before" || value.mode === "after") {
    const unknown = unknownFields(value, new Set(["mode", "anchorAssetId"]), where);
    if (unknown !== null) return failure("invalid_pack_placement", unknown.detail);
    const anchor = validatePackId(value.anchorAssetId, `${where}.anchorAssetId`);
    if (typeof anchor !== "string") return anchor;
    return Object.freeze({ mode: value.mode, anchorAssetId: anchor });
  }
  return failure("invalid_pack_placement", `${where}.mode must be append, before, or after`);
}

export function validateAssetRegistrationApplicationAuthorization(
  value: unknown,
): AssetApplicationAuthorizationResult {
  if (!isRecord(value)) {
    return failure("invalid_authorization", "authorization must be a JSON object");
  }
  const unknown = unknownFields(
    value,
    new Set([
      "schemaVersion",
      "decision",
      "proposalSha256",
      "reviewerId",
      "decidedAt",
      "referenceId",
      "packPlacements",
      "notes",
    ]),
    "authorization",
  );
  if (unknown !== null) return unknown;
  if (value.schemaVersion !== 1) {
    return failure("invalid_authorization", "authorization.schemaVersion must equal 1");
  }
  if (value.decision !== "approved" && value.decision !== "rejected") {
    return failure("unsupported_decision", "authorization.decision must be approved or rejected");
  }
  if (typeof value.proposalSha256 !== "string" || !LOWER_SHA256.test(value.proposalSha256)) {
    return failure("invalid_authorization", "authorization.proposalSha256 must be a lowercase SHA-256 digest");
  }
  const reviewerId = exactString(value.reviewerId, "reviewerId", false);
  if (typeof reviewerId !== "string") return reviewerId;
  const decidedAt = exactString(value.decidedAt, "decidedAt", false);
  if (typeof decidedAt !== "string") return decidedAt;
  if (!validTimestamp(decidedAt)) {
    return failure("invalid_authorization", "authorization.decidedAt must be a valid ISO-8601 timestamp with an explicit timezone");
  }
  const referenceId = exactString(value.referenceId, "referenceId", false);
  if (typeof referenceId !== "string") return referenceId;
  let notes: string | undefined;
  if (value.notes !== undefined) {
    const validated = exactString(value.notes, "notes", true);
    if (typeof validated !== "string") return validated;
    notes = validated;
  }
  if (!Array.isArray(value.packPlacements)) {
    return failure("invalid_authorization", "authorization.packPlacements must be an array");
  }
  const seen = new Set<string>();
  const packPlacements: AssetApplicationPackPlacement[] = [];
  for (let index = 0; index < value.packPlacements.length; index += 1) {
    const raw = value.packPlacements[index];
    if (!isRecord(raw)) {
      return failure("invalid_pack_placement", `authorization.packPlacements[${index}] must be a JSON object`);
    }
    const placementUnknown = unknownFields(raw, new Set(["packId", "placement"]), `authorization.packPlacements[${index}]`);
    if (placementUnknown !== null) return failure("invalid_pack_placement", placementUnknown.detail);
    const packId = validatePackId(raw.packId, `authorization.packPlacements[${index}].packId`);
    if (typeof packId !== "string") return packId;
    if (seen.has(packId)) {
      return failure("duplicate_pack_placement", `authorization contains duplicate placement for Pack ${packId}`);
    }
    seen.add(packId);
    const placement = validatePlacement(raw.placement, `authorization.packPlacements[${index}].placement`);
    if (isAuthorizationFailure(placement)) return placement;
    packPlacements.push(Object.freeze({ packId, placement }));
  }

  return Object.freeze({
    ok: true,
    authorization: Object.freeze({
      schemaVersion: 1,
      decision: value.decision,
      proposalSha256: value.proposalSha256,
      reviewerId,
      decidedAt,
      referenceId,
      packPlacements: Object.freeze(packPlacements),
      ...(notes === undefined ? {} : { notes }),
    }),
  });
}

export function serializeAssetRegistrationApplicationAuthorization(
  authorization: AssetRegistrationApplicationAuthorization,
): Buffer {
  return Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`, "utf8");
}

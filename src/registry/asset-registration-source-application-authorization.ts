export const ASSET_REGISTRATION_SOURCE_APPLICATION_AUTHORIZATION_MAX_LENGTHS = Object.freeze({
  reviewerId: 64,
  decidedAt: 40,
  referenceId: 96,
  notes: 500,
});

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u;
const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

export interface AssetRegistrationSourceApplicationAuthorization {
  readonly schemaVersion: 1;
  readonly decision: "approved" | "rejected";
  readonly sourceChangeReviewSha256: string;
  readonly sourcePatchSha256: string;
  readonly sourceChangeReceiptSha256: string;
  readonly reviewerId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export type AssetRegistrationSourceApplicationAuthorizationFailureReason =
  | "invalid_application_authorization"
  | "unsupported_schema_version"
  | "application_authorization_rejected";

export interface AssetRegistrationSourceApplicationAuthorizationFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationSourceApplicationAuthorizationFailureReason;
  readonly detail: string;
}

export type AssetRegistrationSourceApplicationAuthorizationResult =
  | { readonly ok: true; readonly authorization: AssetRegistrationSourceApplicationAuthorization }
  | AssetRegistrationSourceApplicationAuthorizationFailure;

function failure(reason: AssetRegistrationSourceApplicationAuthorizationFailureReason, detail: string): AssetRegistrationSourceApplicationAuthorizationFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const [yearText, monthText, dayText] = (match[1] ?? "").split("-");
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function exactString(
  value: unknown,
  field: keyof typeof ASSET_REGISTRATION_SOURCE_APPLICATION_AUTHORIZATION_MAX_LENGTHS,
  multiline: boolean,
): string | AssetRegistrationSourceApplicationAuthorizationFailure {
  if (typeof value !== "string") return failure("invalid_application_authorization", `${field} must be a string`);
  if (value.length === 0 || value.trim().length === 0) return failure("invalid_application_authorization", `${field} must not be empty`);
  if (value.trim() !== value) return failure("invalid_application_authorization", `${field} must not contain outer whitespace`);
  if ((multiline ? MULTILINE_CONTROL : SINGLE_LINE_CONTROL).test(value)) return failure("invalid_application_authorization", `${field} contains forbidden control characters${multiline ? "" : " or newlines"}`);
  if (value.length > ASSET_REGISTRATION_SOURCE_APPLICATION_AUTHORIZATION_MAX_LENGTHS[field]) return failure("invalid_application_authorization", `${field} exceeds maximum length ${ASSET_REGISTRATION_SOURCE_APPLICATION_AUTHORIZATION_MAX_LENGTHS[field]}`);
  return value;
}

export function validateAssetRegistrationSourceApplicationAuthorization(value: unknown): AssetRegistrationSourceApplicationAuthorizationResult {
  if (!isRecord(value)) return failure("invalid_application_authorization", "application authorization must be a JSON object");
  const allowed = new Set(["schemaVersion", "decision", "sourceChangeReviewSha256", "sourcePatchSha256", "sourceChangeReceiptSha256", "reviewerId", "decidedAt", "referenceId", "notes"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return failure("invalid_application_authorization", `application authorization contains unknown fields: ${unknown.join(", ")}`);
  for (const required of ["schemaVersion", "decision", "sourceChangeReviewSha256", "sourcePatchSha256", "sourceChangeReceiptSha256", "reviewerId", "decidedAt", "referenceId"] as const) {
    if (!(required in value)) return failure("invalid_application_authorization", `application authorization is missing ${required}`);
  }
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "application authorization schemaVersion must equal 1");
  if (value.decision !== "approved" && value.decision !== "rejected") return failure("invalid_application_authorization", "application authorization decision must be approved or rejected");
  for (const field of ["sourceChangeReviewSha256", "sourcePatchSha256", "sourceChangeReceiptSha256"] as const) {
    if (typeof value[field] !== "string" || !LOWER_SHA256.test(value[field] as string)) return failure("invalid_application_authorization", `${field} must be a lowercase SHA-256 digest`);
  }
  const reviewerId = exactString(value.reviewerId, "reviewerId", false); if (typeof reviewerId !== "string") return reviewerId;
  const decidedAt = exactString(value.decidedAt, "decidedAt", false); if (typeof decidedAt !== "string") return decidedAt;
  if (!validTimestamp(decidedAt)) return failure("invalid_application_authorization", "decidedAt must be a valid ISO-8601 timestamp with an explicit timezone");
  const referenceId = exactString(value.referenceId, "referenceId", false); if (typeof referenceId !== "string") return referenceId;
  let notes: string | undefined;
  if (value.notes !== undefined) { const checked = exactString(value.notes, "notes", true); if (typeof checked !== "string") return checked; notes = checked; }
  return Object.freeze({
    ok: true,
    authorization: Object.freeze({
      schemaVersion: 1,
      decision: value.decision,
      sourceChangeReviewSha256: value.sourceChangeReviewSha256 as string,
      sourcePatchSha256: value.sourcePatchSha256 as string,
      sourceChangeReceiptSha256: value.sourceChangeReceiptSha256 as string,
      reviewerId,
      decidedAt,
      referenceId,
      ...(notes === undefined ? {} : { notes }),
    }),
  });
}

export function serializeAssetRegistrationSourceApplicationAuthorization(authorization: AssetRegistrationSourceApplicationAuthorization): Buffer {
  return Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`, "utf8");
}

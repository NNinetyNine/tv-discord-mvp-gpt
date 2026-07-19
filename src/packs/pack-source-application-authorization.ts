export const PACK_SOURCE_APPLICATION_AUTHORIZATION_SCHEMA_VERSION = 1 as const;
export const PACK_SOURCE_APPLICATION_AUTHORIZATION_TYPE = "visionx.pack-source-application-authorization" as const;
export const PACK_SOURCE_APPLICATION_AUTHORIZATION_TEXT_LIMITS = Object.freeze({
  authorizerId: 64,
  decidedAt: 40,
  referenceId: 96,
  notes: 500,
});

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u;
const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

export interface PackSourceApplicationAuthorization {
  readonly schemaVersion: 1;
  readonly authorizationType: typeof PACK_SOURCE_APPLICATION_AUTHORIZATION_TYPE;
  readonly decision: "approved" | "rejected";
  readonly packSourceChangeReviewSha256: string;
  readonly packSourceChangeReceiptSha256: string;
  readonly packApplicationPlanSha256: string;
  readonly sourcePatchSha256: string;
  readonly packsBeforeSha256: string;
  readonly packsAfterSha256: string;
  readonly authorizerId: string;
  readonly decidedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export type PackSourceApplicationAuthorizationFailureReason =
  | "invalid_pack_application_authorization"
  | "unsupported_schema_version"
  | "application_authorization_rejected";

export interface PackSourceApplicationAuthorizationFailure {
  readonly ok: false;
  readonly reason: PackSourceApplicationAuthorizationFailureReason;
  readonly detail: string;
}

export type PackSourceApplicationAuthorizationResult =
  | { readonly ok: true; readonly value: PackSourceApplicationAuthorization }
  | PackSourceApplicationAuthorizationFailure;

function failure(reason: PackSourceApplicationAuthorizationFailureReason, detail: string): PackSourceApplicationAuthorizationFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const [yearText, monthText, dayText] = (match[1] ?? "").split("-");
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function text(
  value: unknown,
  field: keyof typeof PACK_SOURCE_APPLICATION_AUTHORIZATION_TEXT_LIMITS,
  multiline = false,
): string | PackSourceApplicationAuthorizationFailure {
  if (typeof value !== "string") return failure("invalid_pack_application_authorization", `${field} must be a string`);
  if (value.length === 0 || value.trim().length === 0 || value.trim() !== value) return failure("invalid_pack_application_authorization", `${field} must be normalized nonempty text`);
  if ((multiline ? MULTILINE_CONTROL : SINGLE_LINE_CONTROL).test(value)) return failure("invalid_pack_application_authorization", `${field} contains forbidden control characters${multiline ? "" : " or newlines"}`);
  if (value.length > PACK_SOURCE_APPLICATION_AUTHORIZATION_TEXT_LIMITS[field]) return failure("invalid_pack_application_authorization", `${field} exceeds maximum length ${PACK_SOURCE_APPLICATION_AUTHORIZATION_TEXT_LIMITS[field]}`);
  return value;
}

export function validatePackSourceApplicationAuthorization(value: unknown): PackSourceApplicationAuthorizationResult {
  if (!isRecord(value)) return failure("invalid_pack_application_authorization", "Pack application authorization must be a JSON object");
  if (value.schemaVersion !== 1) return failure("unsupported_schema_version", "Pack application authorization schemaVersion must equal 1");
  const expected = ["schemaVersion", "authorizationType", "decision", "packSourceChangeReviewSha256", "packSourceChangeReceiptSha256", "packApplicationPlanSha256", "sourcePatchSha256", "packsBeforeSha256", "packsAfterSha256", "authorizerId", "decidedAt", "referenceId", ...(value.notes === undefined ? [] : ["notes"])].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) return failure("invalid_pack_application_authorization", `Pack application authorization fields must be exactly: ${expected.join(", ")}`);
  if (value.authorizationType !== PACK_SOURCE_APPLICATION_AUTHORIZATION_TYPE) return failure("invalid_pack_application_authorization", "Pack application authorization type is invalid");
  if (value.decision !== "approved" && value.decision !== "rejected") return failure("invalid_pack_application_authorization", "Pack application authorization decision must be approved or rejected");
  for (const field of ["packSourceChangeReviewSha256", "packSourceChangeReceiptSha256", "packApplicationPlanSha256", "sourcePatchSha256", "packsBeforeSha256", "packsAfterSha256"] as const) {
    if (typeof value[field] !== "string" || !LOWER_SHA256.test(value[field] as string)) return failure("invalid_pack_application_authorization", `${field} must be a lowercase SHA-256 digest`);
  }
  const authorizerId = text(value.authorizerId, "authorizerId"); if (typeof authorizerId !== "string") return authorizerId;
  const decidedAt = text(value.decidedAt, "decidedAt"); if (typeof decidedAt !== "string") return decidedAt;
  if (!validTimestamp(decidedAt)) return failure("invalid_pack_application_authorization", "decidedAt must be a valid ISO-8601 timestamp with an explicit timezone");
  const referenceId = text(value.referenceId, "referenceId"); if (typeof referenceId !== "string") return referenceId;
  let notes: string | undefined;
  if (value.notes !== undefined) { const checked = text(value.notes, "notes", true); if (typeof checked !== "string") return checked; notes = checked; }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: PACK_SOURCE_APPLICATION_AUTHORIZATION_SCHEMA_VERSION,
      authorizationType: PACK_SOURCE_APPLICATION_AUTHORIZATION_TYPE,
      decision: value.decision,
      packSourceChangeReviewSha256: value.packSourceChangeReviewSha256 as string,
      packSourceChangeReceiptSha256: value.packSourceChangeReceiptSha256 as string,
      packApplicationPlanSha256: value.packApplicationPlanSha256 as string,
      sourcePatchSha256: value.sourcePatchSha256 as string,
      packsBeforeSha256: value.packsBeforeSha256 as string,
      packsAfterSha256: value.packsAfterSha256 as string,
      authorizerId,
      decidedAt,
      referenceId,
      ...(notes === undefined ? {} : { notes }),
    }),
  });
}

export function serializePackSourceApplicationAuthorization(value: PackSourceApplicationAuthorization): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

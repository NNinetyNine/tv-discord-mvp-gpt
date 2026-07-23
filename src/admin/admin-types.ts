export const PACK_DRAFT_SCHEMA_VERSION = 1 as const;
export const PACK_DRAFT_TYPE = "visionx.pack-draft" as const;
export const PACK_DRAFT_ID_MAX_LENGTH = 64 as const;
export const PACK_DRAFT_DISPLAY_NAME_MAX_LENGTH = 120 as const;
export const PACK_DRAFT_DESCRIPTION_MAX_LENGTH = 1000 as const;
export const PACK_DRAFT_MAX_ASSETS = 1000 as const;

const DRAFT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export type AdminErrorCode =
  | "invalid_arguments"
  | "repository_root_invalid"
  | "workspace_root_invalid"
  | "source_path_unsafe"
  | "workspace_path_unsafe"
  | "path_collision"
  | "unreadable_source"
  | "invalid_registry"
  | "invalid_packs"
  | "invalid_channel_configuration"
  | "invalid_pack_draft"
  | "invalid_pack_builder_input"
  | "invalid_asset_logo"
  | "asset_logo_not_found"
  | "pack_builder_preview_not_found"
  | "pack_builder_preview_mismatch"
  | "existing_asset_currency_missing"
  | "tradingview_conflict"
  | "display_conflict"
  | "pack_builder_transaction_failed"
  | "invalid_asset_registration_input"
  | "invalid_asset_registration_proposal"
  | "invalid_asset_registration_planning_authorization"
  | "invalid_asset_registration_application_plan"
  | "invalid_asset_registration_source_change"
  | "invalid_asset_registration_review_decision"
  | "invalid_asset_registration_source_change_review"
  | "invalid_asset_registration_application_authorization"
  | "invalid_asset_registration_source_application_receipt"
  | "asset_registration_not_found"
  | "asset_registration_artifact_not_found"
  | "asset_id_already_exists"
  | "unsupported_schema_version"
  | "draft_id_invalid"
  | "draft_not_found"
  | "draft_already_exists"
  | "draft_revision_conflict"
  | "draft_asset_not_found"
  | "duplicate_draft_asset"
  | "asset_not_found"
  | "pack_not_found"
  | "request_body_too_large"
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_request"
  | "invalid_standalone_render"
  | "standalone_render_failed"
  | "standalone_render_not_found"
  | "standalone_render_artifact_not_found"
  | "invalid_pack_render_preview"
  | "pack_render_preview_not_found"
  | "pack_render_preview_state_conflict"
  | "chart_downloads_root_invalid"
  | "chart_downloads_not_configured"
  | "invalid_pack_capture_session"
  | "pack_capture_session_not_started"
  | "pack_capture_session_state_conflict"
  | "pack_workspace_reset_confirmation_invalid"
  | "pack_workspace_reset_state_conflict"
  | "pack_workspace_analysis_not_found"
  | "invalid_pack_revision"
  | "pack_revision_not_found"
  | "pack_revision_state_conflict"
  | "pack_revision_write_failed"
  | "pack_revision_delete_confirmation_invalid"
  | "invalid_thread_bindings"
  | "discord_operations_unavailable"
  | "thread_adoption_confirmation_invalid"
  | "thread_binding_conflict"
  | "thread_adoption_failed"
  | "thread_binding_write_failed"
  | "thread_forum_inspection_confirmation_invalid"
  | "thread_forum_inspection_failed"
  | "thread_provisioning_confirmation_invalid"
  | "thread_provisioning_logo_not_found"
  | "thread_provisioning_logo_mismatch"
  | "thread_provisioning_failed"
  | "thread_routing_verification_confirmation_invalid"
  | "thread_routing_incomplete"
  | "thread_routing_verification_failed"
  | "thread_routing_state_changed"
  | "origin_rejected"
  | "method_not_allowed"
  | "route_not_found"
  | "temporary_write_failed"
  | "draft_finalize_failed"
  | "draft_delete_failed"
  | "source_reload_failed"
  | "invalid_promotion_request"
  | "invalid_pack_proposal"
  | "invalid_planning_authorization"
  | "invalid_pack_application_plan"
  | "invalid_pack_source_change_receipt"
  | "operation_not_supported"
  | "operation_state_mismatch"
  | "promotion_not_authorized"
  | "planning_authorization_rejected"
  | "draft_hash_mismatch"
  | "proposal_hash_mismatch"
  | "planning_authorization_hash_mismatch"
  | "application_plan_hash_mismatch"
  | "proposal_reconstruction_mismatch"
  | "plan_reconstruction_mismatch"
  | "stale_registry_state"
  | "stale_pack_state"
  | "stale_pack_membership"
  | "stale_registry_fingerprint"
  | "pack_already_exists"
  | "pack_channel_required"
  | "pack_channel_invalid"
  | "pack_channel_not_configured"
  | "pack_channel_change_not_supported"
  | "numeric_channel_id_not_allowed"
  | "source_shape_unsupported"
  | "source_serialization_failed"
  | "source_result_mismatch"
  | "output_already_exists"
  | "finalize_failed"
  | "invalid_review_decision"
  | "invalid_pack_source_change_review"
  | "invalid_pack_application_authorization"
  | "invalid_pack_source_application_receipt"
  | "review_decision_rejected"
  | "source_change_review_rejected"
  | "source_change_review_required"
  | "source_change_review_hash_mismatch"
  | "review_reconstruction_mismatch"
  | "application_authorization_required"
  | "application_authorization_rejected"
  | "application_authorization_hash_mismatch"
  | "application_confirmation_required"
  | "application_confirmation_invalid"
  | "application_not_authorized"
  | "stale_channel_state"
  | "source_change_already_applied"
  | "source_write_failed"
  | "source_write_verification_failed"
  | "application_receipt_finalize_failed"
  | "rollback_failed"
  | "rollback_verification_failed"
  | "application_already_completed"
  | "source_patch_hash_mismatch"
  | "source_change_receipt_hash_mismatch"
  | "input_changed_during_operation"
  | "source_changed_during_operation"
  | "stale_asset_state"
  | "invalid_source_patch"
  | "source_change_not_approved"
  | "source_change_reconstruction_mismatch"
  | "patch_verification_failed"
  | "unreadable_input"
  | "review_decision_hash_mismatch"
  | "internal_error";

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AdminErrorCode,
    message: string,
    status = 400,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.status = status;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }
}

export interface PackDraft {
  readonly schemaVersion: 1;
  readonly draftType: "visionx.pack-draft";
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly assetIds: readonly string[];
  readonly revision: number;
}

export type PackDraftValidationIssueCode =
  | "unsupported_schema_version"
  | "unknown_field"
  | "draft_id_invalid"
  | "display_name_invalid"
  | "description_invalid"
  | "asset_ids_invalid"
  | "duplicate_draft_asset"
  | "draft_asset_not_found"
  | "revision_invalid"
  | "empty_membership";

export interface PackDraftValidationIssue {
  readonly code: PackDraftValidationIssueCode;
  readonly message: string;
  readonly assetId?: string;
}

export interface PackDraftValidationResult {
  readonly schemaVersion: 1;
  readonly draftId: string | null;
  readonly structurallyValid: boolean;
  readonly registryValid: boolean;
  readonly valid: boolean;
  readonly errors: readonly PackDraftValidationIssue[];
  readonly warnings: readonly PackDraftValidationIssue[];
  readonly resolvedAssetCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: PackDraftValidationIssueCode,
  message: string,
  assetId?: string,
): PackDraftValidationIssue {
  return Object.freeze({ code, message, ...(assetId === undefined ? {} : { assetId }) });
}

export function isValidPackDraftId(value: unknown): value is string {
  return typeof value === "string" && DRAFT_ID_PATTERN.test(value);
}

function validBoundedText(value: unknown, max: number, optional: boolean): value is string | undefined {
  if (value === undefined) return optional;
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.trim().length === 0 || value.trim() !== value) return false;
  if (value.length > max || CONTROL_CHARACTER.test(value)) return false;
  return true;
}

export function validatePackDraft(
  value: unknown,
  validAssetIds?: ReadonlySet<string>,
): PackDraftValidationResult {
  const errors: PackDraftValidationIssue[] = [];
  const warnings: PackDraftValidationIssue[] = [];
  let draftId: string | null = null;
  let resolvedAssetCount = 0;

  if (!isRecord(value)) {
    errors.push(issue("asset_ids_invalid", "Pack draft must be a JSON object."));
  } else {
    const allowed = new Set(["schemaVersion", "draftType", "id", "displayName", "description", "assetIds", "revision"]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) errors.push(issue("unknown_field", `Unknown Pack draft field: ${key}.`));
    }
    if (value.schemaVersion !== PACK_DRAFT_SCHEMA_VERSION) {
      errors.push(issue("unsupported_schema_version", "Pack draft schemaVersion must equal 1."));
    }
    if (value.draftType !== PACK_DRAFT_TYPE) {
      errors.push(issue("unknown_field", `Pack draft draftType must equal ${PACK_DRAFT_TYPE}.`));
    }
    if (!isValidPackDraftId(value.id)) {
      errors.push(issue("draft_id_invalid", "Draft id must be a safe lowercase slug of 1 to 64 characters."));
    } else {
      draftId = value.id;
    }
    if (!validBoundedText(value.displayName, PACK_DRAFT_DISPLAY_NAME_MAX_LENGTH, false)) {
      errors.push(issue("display_name_invalid", `displayName must be normalized text of at most ${PACK_DRAFT_DISPLAY_NAME_MAX_LENGTH} characters.`));
    }
    if (!validBoundedText(value.description, PACK_DRAFT_DESCRIPTION_MAX_LENGTH, true)) {
      errors.push(issue("description_invalid", `description must be normalized text of at most ${PACK_DRAFT_DESCRIPTION_MAX_LENGTH} characters when supplied.`));
    }
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
      errors.push(issue("revision_invalid", "revision must be a positive safe integer."));
    }
    if (!Array.isArray(value.assetIds) || value.assetIds.length > PACK_DRAFT_MAX_ASSETS) {
      errors.push(issue("asset_ids_invalid", `assetIds must be an array containing at most ${PACK_DRAFT_MAX_ASSETS} entries.`));
    } else {
      const seen = new Set<string>();
      for (const assetId of value.assetIds) {
        if (typeof assetId !== "string" || !ASSET_ID_PATTERN.test(assetId)) {
          errors.push(issue("asset_ids_invalid", "Every assetIds entry must be a normalized Asset id string."));
          continue;
        }
        if (seen.has(assetId)) {
          errors.push(issue("duplicate_draft_asset", `Asset ${assetId} appears more than once.`, assetId));
          continue;
        }
        seen.add(assetId);
        if (validAssetIds !== undefined && !validAssetIds.has(assetId)) {
          errors.push(issue("draft_asset_not_found", `Asset ${assetId} is not present in the current Registry.`, assetId));
        } else {
          resolvedAssetCount += 1;
        }
      }
      if (value.assetIds.length === 0) {
        warnings.push(issue("empty_membership", "The draft is structurally valid but contains no Assets."));
      }
    }
  }

  const structuralCodes = new Set<PackDraftValidationIssueCode>([
    "unsupported_schema_version", "unknown_field", "draft_id_invalid", "display_name_invalid",
    "description_invalid", "asset_ids_invalid", "duplicate_draft_asset", "revision_invalid",
  ]);
  const structurallyValid = !errors.some((entry) => structuralCodes.has(entry.code));
  const registryValid = !errors.some((entry) => entry.code === "draft_asset_not_found");
  return Object.freeze({
    schemaVersion: 1,
    draftId,
    structurallyValid,
    registryValid,
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    resolvedAssetCount,
  });
}

export function parsePackDraft(value: unknown, validAssetIds?: ReadonlySet<string>): PackDraft {
  const validation = validatePackDraft(value, validAssetIds);
  if (!validation.valid) {
    const first = validation.errors[0];
    const code: AdminErrorCode = first?.code === "draft_id_invalid" ? "draft_id_invalid"
      : first?.code === "duplicate_draft_asset" ? "duplicate_draft_asset"
      : first?.code === "draft_asset_not_found" ? "draft_asset_not_found"
      : first?.code === "unsupported_schema_version" ? "unsupported_schema_version"
      : "invalid_pack_draft";
    throw new AdminError(code, first?.message ?? "Pack draft is invalid.", 400,
      first?.assetId === undefined ? undefined : { assetId: first.assetId });
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    schemaVersion: 1,
    draftType: PACK_DRAFT_TYPE,
    id: record.id as string,
    displayName: record.displayName as string,
    ...(record.description === undefined ? {} : { description: record.description as string }),
    assetIds: Object.freeze([...(record.assetIds as string[])]),
    revision: record.revision as number,
  });
}

export function serializePackDraft(draft: PackDraft): Buffer {
  const canonical = {
    schemaVersion: PACK_DRAFT_SCHEMA_VERSION,
    draftType: PACK_DRAFT_TYPE,
    id: draft.id,
    displayName: draft.displayName,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    assetIds: [...draft.assetIds],
    revision: draft.revision,
  };
  return Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, "utf8");
}

import { describe, expect, it } from "vitest";
import {
  PACK_DRAFT_TYPE,
  parsePackDraft,
  serializePackDraft,
  validatePackDraft,
} from "./admin-types.ts";

const VALID_IDS = new Set(["aapl", "btc", "gold"]);
const draft = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  draftType: PACK_DRAFT_TYPE,
  id: "qa-pack",
  displayName: "QA Pack",
  description: "A deterministic draft.",
  assetIds: ["aapl", "btc"],
  revision: 1,
  ...overrides,
});

describe("Pack draft validation", () => {
  it("accepts a populated canonical draft", () => {
    expect(validatePackDraft(draft(), VALID_IDS)).toMatchObject({ valid: true, resolvedAssetCount: 2 });
  });

  it("accepts an empty draft with an explicit warning", () => {
    const result = validatePackDraft(draft({ assetIds: [] }), VALID_IDS);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((entry) => entry.code)).toEqual(["empty_membership"]);
  });

  it("rejects unknown fields", () => {
    expect(validatePackDraft(draft({ channel: "stocks" }), VALID_IDS).errors[0]?.code).toBe("unknown_field");
  });

  it("rejects unsupported schema versions", () => {
    expect(validatePackDraft(draft({ schemaVersion: 2 }), VALID_IDS).errors[0]?.code).toBe("unsupported_schema_version");
  });

  it.each(["../escape", ".", "Uppercase", "-leading", "with/slash"])("rejects unsafe draft id %s", (id) => {
    expect(validatePackDraft(draft({ id }), VALID_IDS).errors.some((entry) => entry.code === "draft_id_invalid")).toBe(true);
  });

  it("rejects empty display names", () => {
    expect(validatePackDraft(draft({ displayName: " " }), VALID_IDS).errors.some((entry) => entry.code === "display_name_invalid")).toBe(true);
  });

  it("rejects control characters in descriptions", () => {
    expect(validatePackDraft(draft({ description: "bad\nvalue" }), VALID_IDS).errors.some((entry) => entry.code === "description_invalid")).toBe(true);
  });

  it("distinguishes duplicate membership", () => {
    expect(validatePackDraft(draft({ assetIds: ["aapl", "aapl"] }), VALID_IDS).errors[0]?.code).toBe("duplicate_draft_asset");
  });

  it("distinguishes stale Registry references", () => {
    const result = validatePackDraft(draft({ assetIds: ["missing"] }), VALID_IDS);
    expect(result.structurallyValid).toBe(true);
    expect(result.registryValid).toBe(false);
    expect(result.errors[0]?.code).toBe("draft_asset_not_found");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid revision %s", (revision) => {
    expect(validatePackDraft(draft({ revision }), VALID_IDS).errors.some((entry) => entry.code === "revision_invalid")).toBe(true);
  });

  it("serializes with fixed ordering, indentation, and final newline", () => {
    const parsed = parsePackDraft(draft(), VALID_IDS);
    const text = serializePackDraft(parsed).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"schemaVersion"')).toBeLessThan(text.indexOf('"draftType"'));
    expect(text.indexOf('"assetIds"')).toBeLessThan(text.indexOf('"revision"'));
    expect(JSON.parse(text)).toEqual(draft());
  });

  it("omits an absent description deterministically", () => {
    const { description: _description, ...value } = draft();
    expect(serializePackDraft(parsePackDraft(value, VALID_IDS)).toString("utf8")).not.toContain('"description"');
  });
});

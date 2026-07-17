import {
  calculateChartPublicationLayout,
  CHART_PUBLICATION_BRANDING,
  CHART_PUBLICATION_DIMENSIONS,
  CHART_PUBLICATION_LAYOUT_IDENTIFIER,
  CHART_PUBLICATION_OUTPUT_WIDTH,
  CHART_PUBLICATION_RENDERER_IDENTIFIER,
  CHART_PUBLICATION_RENDERER_VERSION,
  CHART_PUBLICATION_TEMPLATE_IDENTIFIER,
  CHART_PUBLICATION_TEMPLATE_VERSION,
  validateChartPublicationMetadata,
  type ChartPublicationMetadata,
} from "../rendering/chart-publication-template.ts";
import {
  CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION,
  type ChartPublicationReceipt,
} from "../rendering/render-chart-publication.ts";
import {
  CHART_FRAME_COORDINATE_CONVENTION,
  CHART_FRAME_DETECTOR_IDENTIFIER,
  CHART_FRAME_DETECTOR_VERSION,
} from "../validation/detect-chart-frame.ts";

export const PUBLICATION_REVIEW_SCHEMA_VERSION = 1 as const;
export const PUBLICATION_REVIEW_TYPE = "visionx.chart-publication.visual-review" as const;
export const PUBLICATION_REVIEW_INPUT_SCHEMA_VERSION = 1 as const;

export const PUBLICATION_REVIEW_MAX_LENGTHS = Object.freeze({
  reviewerId: 64,
  reviewedAt: 40,
  referenceId: 96,
  notes: 500,
});

export type PublicationReviewDecision = "approved" | "rejected";

export interface PublicationReviewMetadata {
  readonly schemaVersion: typeof PUBLICATION_REVIEW_INPUT_SCHEMA_VERSION;
  readonly decision: PublicationReviewDecision;
  readonly reviewerId: string;
  readonly reviewedAt: string;
  readonly referenceId: string;
  readonly notes?: string;
}

export interface PublicationReviewValidationFailure {
  readonly ok: false;
  readonly detail: string;
}

export interface PublicationReviewValidationSuccess {
  readonly ok: true;
  readonly review: PublicationReviewMetadata;
}

export type PublicationReviewValidationResult =
  | PublicationReviewValidationFailure
  | PublicationReviewValidationSuccess;

export interface RenderReceiptValidationFailure {
  readonly ok: false;
  readonly detail: string;
}

export interface RenderReceiptValidationSuccess {
  readonly ok: true;
  readonly receipt: ChartPublicationReceipt;
}

export type RenderReceiptValidationResult =
  | RenderReceiptValidationFailure
  | RenderReceiptValidationSuccess;

export interface PublicationReviewReceipt {
  readonly schemaVersion: typeof PUBLICATION_REVIEW_SCHEMA_VERSION;
  readonly reviewType: typeof PUBLICATION_REVIEW_TYPE;
  readonly publicationApproved: boolean;
  readonly technicalValidation: {
    readonly ok: true;
    readonly publicationSha256: string;
    readonly renderReceiptSha256: string;
    readonly sourceReverified: boolean;
  };
  readonly renderer: {
    readonly id: typeof CHART_PUBLICATION_RENDERER_IDENTIFIER;
    readonly version: typeof CHART_PUBLICATION_RENDERER_VERSION;
  };
  readonly template: {
    readonly id: typeof CHART_PUBLICATION_TEMPLATE_IDENTIFIER;
    readonly version: typeof CHART_PUBLICATION_TEMPLATE_VERSION;
    readonly layoutId: typeof CHART_PUBLICATION_LAYOUT_IDENTIFIER;
    readonly width: number;
    readonly height: number;
  };
  readonly source: {
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly format: "png";
  };
  readonly publication: {
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly format: "png";
  };
  readonly renderReceipt: {
    readonly sha256: string;
    readonly schemaVersion: typeof CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION;
  };
  readonly detection: {
    readonly detectorId: typeof CHART_FRAME_DETECTOR_IDENTIFIER;
    readonly detectorVersion: typeof CHART_FRAME_DETECTOR_VERSION;
    readonly coordinateConvention: typeof CHART_FRAME_COORDINATE_CONVENTION;
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
    readonly height: number;
    readonly candidateCount: 1;
  };
  readonly layout: {
    readonly layoutId: typeof CHART_PUBLICATION_LAYOUT_IDENTIFIER;
    readonly visibleFooterAttribution: false;
  };
  readonly branding: {
    readonly headerEmblemSha256: string;
    readonly footerEmblemSha256: string;
    readonly wordmarkSha256: string;
    readonly watermarkSha256: string;
    readonly watermarkOpacity: number;
  };
  readonly publicationMetadata: ChartPublicationMetadata;
  readonly review: PublicationReviewMetadata;
}

const REVIEW_FIELDS = new Set(["schemaVersion", "decision", "reviewerId", "reviewedAt", "referenceId", "notes"]);
const CONTROL_CHARACTER_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u;
const CONTROL_CHARACTER_OR_NEWLINE = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const ISO_TIMESTAMP_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function failReview(detail: string): PublicationReviewValidationFailure {
  return Object.freeze({ ok: false, detail });
}

function failReceipt(detail: string): RenderReceiptValidationFailure {
  return Object.freeze({ ok: false, detail });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  context: string,
): string | null {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) return `${context} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`;
  const missing = allowed.filter((key) => !(key in record));
  if (missing.length > 0) return `${context} is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`;
  return null;
}

function exactFieldsWithOptional(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  context: string,
): string | null {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return `${context} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`;
  const missing = required.filter((key) => !(key in record));
  if (missing.length > 0) return `${context} is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`;
  return null;
}

function freezeReview(review: PublicationReviewMetadata): PublicationReviewMetadata {
  return Object.freeze({ ...review });
}

function validTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8] ?? "";
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4, 6));
    if (zoneHours > 23 || zoneMinutes > 59) return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    Number.isFinite(Date.parse(value))
  );
}

function validateReviewString(
  record: Readonly<Record<string, unknown>>,
  field: "reviewerId" | "reviewedAt" | "referenceId" | "notes",
  allowNewline: boolean,
  required: boolean,
): string | PublicationReviewValidationFailure | undefined {
  const value = record[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") return failReview(`review field ${field} must be a string`);
  if (value.trim().length === 0) return failReview(`review field ${field} must not be empty or whitespace-only`);
  const invalid = allowNewline ? CONTROL_CHARACTER_EXCEPT_NEWLINE : CONTROL_CHARACTER_OR_NEWLINE;
  if (invalid.test(value)) return failReview(`review field ${field} contains unsupported control characters`);
  if (!allowNewline && /[\r\n]/u.test(value)) return failReview(`review field ${field} must not contain embedded newlines`);
  if (value.length > PUBLICATION_REVIEW_MAX_LENGTHS[field]) {
    return failReview(`review field ${field} exceeds maximum length ${PUBLICATION_REVIEW_MAX_LENGTHS[field]}`);
  }
  return value;
}

export function validatePublicationReviewMetadata(value: unknown): PublicationReviewValidationResult {
  if (!isRecord(value)) return failReview("review metadata must be a JSON object");
  const unknown = Object.keys(value).filter((field) => !REVIEW_FIELDS.has(field));
  if (unknown.length > 0) return failReview(`review metadata contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  if (value.schemaVersion !== PUBLICATION_REVIEW_INPUT_SCHEMA_VERSION) {
    return failReview(`review schemaVersion must equal ${PUBLICATION_REVIEW_INPUT_SCHEMA_VERSION}`);
  }
  if (value.decision !== "approved" && value.decision !== "rejected") {
    return failReview("review decision must be approved or rejected");
  }
  const reviewerId = validateReviewString(value, "reviewerId", false, true);
  if (typeof reviewerId !== "string") return reviewerId ?? failReview("review field reviewerId is required");
  const reviewedAt = validateReviewString(value, "reviewedAt", false, true);
  if (typeof reviewedAt !== "string") return reviewedAt ?? failReview("review field reviewedAt is required");
  if (!validTimestamp(reviewedAt)) return failReview("review field reviewedAt must be a valid ISO timestamp with an explicit timezone");
  const referenceId = validateReviewString(value, "referenceId", false, true);
  if (typeof referenceId !== "string") return referenceId ?? failReview("review field referenceId is required");
  const notes = validateReviewString(value, "notes", true, false);
  if (notes !== undefined && typeof notes !== "string") return notes;
  return Object.freeze({
    ok: true,
    review: freezeReview({
      schemaVersion: PUBLICATION_REVIEW_INPUT_SCHEMA_VERSION,
      decision: value.decision,
      reviewerId,
      reviewedAt,
      referenceId,
      ...(notes === undefined ? {} : { notes }),
    }),
  });
}

function expectRecord(value: unknown, context: string): Readonly<Record<string, unknown>> | RenderReceiptValidationFailure {
  return isRecord(value) ? value : failReceipt(`${context} must be an object`);
}

function expectInteger(value: unknown, context: string, minimum = 0): number | RenderReceiptValidationFailure {
  return Number.isInteger(value) && Number(value) >= minimum
    ? Number(value)
    : failReceipt(`${context} must be an integer >= ${minimum}`);
}

function expectNumber(value: unknown, context: string): number | RenderReceiptValidationFailure {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : failReceipt(`${context} must be a finite number`);
}

function expectString(value: unknown, context: string): string | RenderReceiptValidationFailure {
  return typeof value === "string" && value.length > 0
    ? value
    : failReceipt(`${context} must be a nonempty string`);
}

function expectSha(value: unknown, context: string): string | RenderReceiptValidationFailure {
  return typeof value === "string" && SHA256.test(value)
    ? value
    : failReceipt(`${context} must be a lowercase SHA-256 digest`);
}

function isReceiptFailure(value: unknown): value is RenderReceiptValidationFailure {
  return isRecord(value) && value.ok === false && typeof value.detail === "string";
}

function validatePlacementObject(
  value: unknown,
  fields: readonly string[],
  context: string,
): Readonly<Record<string, unknown>> | RenderReceiptValidationFailure {
  const record = expectRecord(value, context);
  if (isReceiptFailure(record)) return record;
  const fieldError = exactFields(record, fields, context);
  if (fieldError !== null) return failReceipt(fieldError);
  for (const field of fields) {
    const checked = expectInteger(record[field], `${context}.${field}`);
    if (isReceiptFailure(checked)) return checked;
  }
  return record;
}

/** Strictly validate renderer receipt version 2 as untrusted JSON. */
export function validateChartPublicationRenderReceipt(value: unknown): RenderReceiptValidationResult {
  if (!isRecord(value)) return failReceipt("render receipt must be a JSON object");
  const topFields = ["schemaVersion", "renderer", "template", "layout", "source", "detection", "placement", "branding", "metadata", "output"] as const;
  const topError = exactFields(value, topFields, "render receipt");
  if (topError !== null) return failReceipt(topError);
  if (value.schemaVersion !== CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION) return failReceipt(`render receipt schemaVersion must equal ${CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION}`);

  const renderer = expectRecord(value.renderer, "render receipt renderer");
  if (isReceiptFailure(renderer)) return renderer;
  const rendererError = exactFields(renderer, ["id", "version"], "render receipt renderer");
  if (rendererError !== null) return failReceipt(rendererError);
  if (renderer.id !== CHART_PUBLICATION_RENDERER_IDENTIFIER) return failReceipt("unsupported renderer id");
  if (renderer.version !== CHART_PUBLICATION_RENDERER_VERSION) return failReceipt("unsupported renderer version");

  const template = expectRecord(value.template, "render receipt template");
  if (isReceiptFailure(template)) return template;
  const templateError = exactFields(template, ["id", "version", "layoutId", "width", "height"], "render receipt template");
  if (templateError !== null) return failReceipt(templateError);
  if (template.id !== CHART_PUBLICATION_TEMPLATE_IDENTIFIER) return failReceipt("unsupported template id");
  if (template.version !== CHART_PUBLICATION_TEMPLATE_VERSION) return failReceipt("unsupported template version");
  if (template.layoutId !== CHART_PUBLICATION_LAYOUT_IDENTIFIER) return failReceipt("unsupported template layoutId");
  const templateWidth = expectInteger(template.width, "render receipt template.width", 1);
  if (isReceiptFailure(templateWidth)) return templateWidth;
  const templateHeight = expectInteger(template.height, "render receipt template.height", 1);
  if (isReceiptFailure(templateHeight)) return templateHeight;

  const layout = expectRecord(value.layout, "render receipt layout");
  if (isReceiptFailure(layout)) return layout;
  const layoutError = exactFields(layout, ["outerBorderThickness", "headerHeight", "headerDividerThickness", "chartGutters", "footerDividerThickness", "footerHeight", "visibleFooterAttribution"], "render receipt layout");
  if (layoutError !== null) return failReceipt(layoutError);
  for (const field of ["outerBorderThickness", "headerHeight", "headerDividerThickness", "footerDividerThickness", "footerHeight"] as const) {
    const checked = expectInteger(layout[field], `render receipt layout.${field}`, 0);
    if (isReceiptFailure(checked)) return checked;
  }
  if (layout.visibleFooterAttribution !== false) return failReceipt("render receipt layout.visibleFooterAttribution must be false");
  const gutters = expectRecord(layout.chartGutters, "render receipt layout.chartGutters");
  if (isReceiptFailure(gutters)) return gutters;
  const guttersError = exactFields(gutters, ["left", "right", "top", "bottom"], "render receipt layout.chartGutters");
  if (guttersError !== null) return failReceipt(guttersError);
  for (const field of ["left", "right", "top", "bottom"] as const) {
    const checked = expectInteger(gutters[field], `render receipt layout.chartGutters.${field}`, 0);
    if (isReceiptFailure(checked)) return checked;
  }

  const source = expectRecord(value.source, "render receipt source");
  if (isReceiptFailure(source)) return source;
  const sourceError = exactFields(source, ["sha256", "width", "height", "format"], "render receipt source");
  if (sourceError !== null) return failReceipt(sourceError);
  const sourceSha = expectSha(source.sha256, "render receipt source.sha256");
  if (isReceiptFailure(sourceSha)) return sourceSha;
  const sourceWidth = expectInteger(source.width, "render receipt source.width", 1);
  if (isReceiptFailure(sourceWidth)) return sourceWidth;
  const sourceHeight = expectInteger(source.height, "render receipt source.height", 1);
  if (isReceiptFailure(sourceHeight)) return sourceHeight;
  if (source.format !== "png") return failReceipt("render receipt source.format must be png");

  const detection = expectRecord(value.detection, "render receipt detection");
  if (isReceiptFailure(detection)) return detection;
  const detectionError = exactFields(detection, ["detectorId", "detectorVersion", "coordinateConvention", "left", "top", "right", "bottom", "width", "height", "candidateCount"], "render receipt detection");
  if (detectionError !== null) return failReceipt(detectionError);
  if (detection.detectorId !== CHART_FRAME_DETECTOR_IDENTIFIER) return failReceipt("unsupported detector id");
  if (detection.detectorVersion !== CHART_FRAME_DETECTOR_VERSION) return failReceipt("unsupported detector version");
  if (detection.coordinateConvention !== CHART_FRAME_COORDINATE_CONVENTION) return failReceipt("unsupported detector coordinate convention");
  if (detection.candidateCount !== 1) return failReceipt("render receipt detection.candidateCount must equal 1");
  const left = expectInteger(detection.left, "render receipt detection.left", 0);
  if (isReceiptFailure(left)) return left;
  const top = expectInteger(detection.top, "render receipt detection.top", 0);
  if (isReceiptFailure(top)) return top;
  const right = expectInteger(detection.right, "render receipt detection.right", 0);
  if (isReceiptFailure(right)) return right;
  const bottom = expectInteger(detection.bottom, "render receipt detection.bottom", 0);
  if (isReceiptFailure(bottom)) return bottom;
  const detectedWidth = expectInteger(detection.width, "render receipt detection.width", 1);
  if (isReceiptFailure(detectedWidth)) return detectedWidth;
  const detectedHeight = expectInteger(detection.height, "render receipt detection.height", 1);
  if (isReceiptFailure(detectedHeight)) return detectedHeight;
  if (right < left || bottom < top || right >= sourceWidth || bottom >= sourceHeight) return failReceipt("render receipt detection bounds are incoherent or outside source dimensions");
  if (right - left + 1 !== detectedWidth || bottom - top + 1 !== detectedHeight) return failReceipt("render receipt detection dimensions do not match inclusive bounds");

  const placement = expectRecord(value.placement, "render receipt placement");
  if (isReceiptFailure(placement)) return placement;
  const placementError = exactFields(placement, ["viewportLeft", "viewportTop", "viewportWidth", "viewportHeight", "renderedLeft", "renderedTop", "renderedWidth", "renderedHeight", "fit"], "render receipt placement");
  if (placementError !== null) return failReceipt(placementError);
  for (const field of ["viewportLeft", "viewportTop", "viewportWidth", "viewportHeight", "renderedLeft", "renderedTop", "renderedWidth", "renderedHeight"] as const) {
    const minimum = field.endsWith("Width") || field.endsWith("Height") ? 1 : 0;
    const checked = expectInteger(placement[field], `render receipt placement.${field}`, minimum);
    if (isReceiptFailure(checked)) return checked;
  }
  if (placement.fit !== "contain") return failReceipt("render receipt placement.fit must be contain");

  const branding = expectRecord(value.branding, "render receipt branding");
  if (isReceiptFailure(branding)) return branding;
  const brandingError = exactFields(branding, ["emblem", "wordmark", "watermark"], "render receipt branding");
  if (brandingError !== null) return failReceipt(brandingError);
  const emblem = expectRecord(branding.emblem, "render receipt branding.emblem");
  if (isReceiptFailure(emblem)) return emblem;
  const emblemError = exactFields(emblem, ["assetSha256", "header", "footer"], "render receipt branding.emblem");
  if (emblemError !== null) return failReceipt(emblemError);
  const emblemSha = expectSha(emblem.assetSha256, "render receipt branding.emblem.assetSha256");
  if (isReceiptFailure(emblemSha)) return emblemSha;
  const headerPlacement = validatePlacementObject(emblem.header, ["left", "top", "width", "height"], "render receipt branding.emblem.header");
  if (isReceiptFailure(headerPlacement)) return headerPlacement;
  const footerPlacement = validatePlacementObject(emblem.footer, ["left", "top", "width", "height"], "render receipt branding.emblem.footer");
  if (isReceiptFailure(footerPlacement)) return footerPlacement;

  const wordmark = expectRecord(branding.wordmark, "render receipt branding.wordmark");
  if (isReceiptFailure(wordmark)) return wordmark;
  const wordmarkError = exactFields(wordmark, ["assetSha256", "left", "top", "width", "height"], "render receipt branding.wordmark");
  if (wordmarkError !== null) return failReceipt(wordmarkError);
  const wordmarkSha = expectSha(wordmark.assetSha256, "render receipt branding.wordmark.assetSha256");
  if (isReceiptFailure(wordmarkSha)) return wordmarkSha;
  for (const field of ["left", "top", "width", "height"] as const) {
    const checked = expectInteger(wordmark[field], `render receipt branding.wordmark.${field}`, field === "width" || field === "height" ? 1 : 0);
    if (isReceiptFailure(checked)) return checked;
  }

  const watermark = expectRecord(branding.watermark, "render receipt branding.watermark");
  if (isReceiptFailure(watermark)) return watermark;
  const watermarkError = exactFields(watermark, ["assetSha256", "left", "top", "width", "height", "opacity"], "render receipt branding.watermark");
  if (watermarkError !== null) return failReceipt(watermarkError);
  const watermarkSha = expectSha(watermark.assetSha256, "render receipt branding.watermark.assetSha256");
  if (isReceiptFailure(watermarkSha)) return watermarkSha;
  for (const field of ["left", "top", "width", "height"] as const) {
    const checked = expectInteger(watermark[field], `render receipt branding.watermark.${field}`, field === "width" || field === "height" ? 1 : 0);
    if (isReceiptFailure(checked)) return checked;
  }
  const opacity = expectNumber(watermark.opacity, "render receipt branding.watermark.opacity");
  if (isReceiptFailure(opacity)) return opacity;
  if (opacity !== CHART_PUBLICATION_BRANDING.watermarkOpacity) return failReceipt(`render receipt watermark opacity must equal ${CHART_PUBLICATION_BRANDING.watermarkOpacity}`);

  const metadataRecord = expectRecord(value.metadata, "render receipt metadata");
  if (isReceiptFailure(metadataRecord)) return metadataRecord;
  const metadataResult = validateReceiptMetadata(metadataRecord);
  if (isReceiptFailure(metadataResult)) return metadataResult;

  const output = expectRecord(value.output, "render receipt output");
  if (isReceiptFailure(output)) return output;
  const outputError = exactFields(output, ["sha256", "width", "height", "format"], "render receipt output");
  if (outputError !== null) return failReceipt(outputError);
  const outputSha = expectSha(output.sha256, "render receipt output.sha256");
  if (isReceiptFailure(outputSha)) return outputSha;
  const outputWidth = expectInteger(output.width, "render receipt output.width", 1);
  if (isReceiptFailure(outputWidth)) return outputWidth;
  const outputHeight = expectInteger(output.height, "render receipt output.height", 1);
  if (isReceiptFailure(outputHeight)) return outputHeight;
  if (output.format !== "png") return failReceipt("render receipt output.format must be png");
  if (outputWidth !== templateWidth || outputHeight !== templateHeight) return failReceipt("render receipt output dimensions must equal template dimensions");

  const expectedLayout = calculateChartPublicationLayout(detectedWidth, detectedHeight);
  if (templateWidth !== CHART_PUBLICATION_OUTPUT_WIDTH || templateHeight !== expectedLayout.outputHeight) {
    return failReceipt("render receipt template dimensions do not match renderer version 2 width-driven layout");
  }
  if (
    layout.outerBorderThickness !== CHART_PUBLICATION_DIMENSIONS.outerBorder ||
    layout.headerHeight !== CHART_PUBLICATION_DIMENSIONS.headerHeight ||
    layout.headerDividerThickness !== CHART_PUBLICATION_DIMENSIONS.headerDivider ||
    layout.footerDividerThickness !== CHART_PUBLICATION_DIMENSIONS.footerDivider ||
    layout.footerHeight !== CHART_PUBLICATION_DIMENSIONS.footerHeight ||
    gutters.left !== CHART_PUBLICATION_DIMENSIONS.chartGutterLeft ||
    gutters.right !== CHART_PUBLICATION_DIMENSIONS.chartGutterRight ||
    gutters.top !== CHART_PUBLICATION_DIMENSIONS.chartGutterTop ||
    gutters.bottom !== CHART_PUBLICATION_DIMENSIONS.chartGutterBottom
  ) {
    return failReceipt("render receipt layout constants do not match renderer version 2 policy");
  }
  for (const field of ["viewportLeft", "viewportTop", "viewportWidth", "viewportHeight", "renderedLeft", "renderedTop", "renderedWidth", "renderedHeight"] as const) {
    if (placement[field] !== expectedLayout.placement[field]) return failReceipt(`render receipt placement.${field} does not match calculated layout`);
  }
  if (
    !sameRectangle(headerPlacement, expectedLayout.headerEmblem) ||
    !sameRectangle(footerPlacement, expectedLayout.footerEmblem) ||
    !sameRectangle(wordmark, expectedLayout.footerWordmark) ||
    !sameRectangle(watermark, expectedLayout.watermark)
  ) {
    return failReceipt("render receipt branding placements do not match calculated renderer layout");
  }

  return Object.freeze({ ok: true, receipt: value as unknown as ChartPublicationReceipt });
}

function validateReceiptMetadata(record: Readonly<Record<string, unknown>>): ChartPublicationMetadata | RenderReceiptValidationFailure {
  const validation = validateChartPublicationMetadata(record);
  return validation.ok ? validation.metadata : failReceipt(`render receipt ${validation.detail}`);
}

function sameRectangle(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<{ left: number; top: number; width: number; height: number }>,
): boolean {
  return actual.left === expected.left && actual.top === expected.top &&
    actual.width === expected.width && actual.height === expected.height;
}

function freezeReceipt(receipt: PublicationReviewReceipt): PublicationReviewReceipt {
  return Object.freeze({
    ...receipt,
    technicalValidation: Object.freeze({ ...receipt.technicalValidation }),
    renderer: Object.freeze({ ...receipt.renderer }),
    template: Object.freeze({ ...receipt.template }),
    source: Object.freeze({ ...receipt.source }),
    publication: Object.freeze({ ...receipt.publication }),
    renderReceipt: Object.freeze({ ...receipt.renderReceipt }),
    detection: Object.freeze({ ...receipt.detection }),
    layout: Object.freeze({ ...receipt.layout }),
    branding: Object.freeze({ ...receipt.branding }),
    publicationMetadata: Object.freeze({ ...receipt.publicationMetadata }),
    review: freezeReview(receipt.review),
  });
}

export interface BuildPublicationReviewReceiptInput {
  readonly publicationSha256: string;
  readonly renderReceiptSha256: string;
  readonly sourceReverified: boolean;
  readonly renderReceipt: ChartPublicationReceipt;
  readonly review: PublicationReviewMetadata;
}

export function buildPublicationReviewReceipt(
  input: BuildPublicationReviewReceiptInput,
): PublicationReviewReceipt {
  const render = input.renderReceipt;
  return freezeReceipt({
    schemaVersion: PUBLICATION_REVIEW_SCHEMA_VERSION,
    reviewType: PUBLICATION_REVIEW_TYPE,
    publicationApproved: input.review.decision === "approved",
    technicalValidation: {
      ok: true,
      publicationSha256: input.publicationSha256,
      renderReceiptSha256: input.renderReceiptSha256,
      sourceReverified: input.sourceReverified,
    },
    renderer: {
      id: CHART_PUBLICATION_RENDERER_IDENTIFIER,
      version: CHART_PUBLICATION_RENDERER_VERSION,
    },
    template: {
      id: CHART_PUBLICATION_TEMPLATE_IDENTIFIER,
      version: CHART_PUBLICATION_TEMPLATE_VERSION,
      layoutId: CHART_PUBLICATION_LAYOUT_IDENTIFIER,
      width: render.template.width,
      height: render.template.height,
    },
    source: { ...render.source },
    publication: {
      sha256: input.publicationSha256,
      width: render.output.width,
      height: render.output.height,
      format: "png",
    },
    renderReceipt: {
      sha256: input.renderReceiptSha256,
      schemaVersion: CHART_PUBLICATION_RECEIPT_SCHEMA_VERSION,
    },
    detection: {
      detectorId: CHART_FRAME_DETECTOR_IDENTIFIER,
      detectorVersion: CHART_FRAME_DETECTOR_VERSION,
      coordinateConvention: CHART_FRAME_COORDINATE_CONVENTION,
      left: render.detection.left,
      top: render.detection.top,
      right: render.detection.right,
      bottom: render.detection.bottom,
      width: render.detection.width,
      height: render.detection.height,
      candidateCount: 1,
    },
    layout: {
      layoutId: CHART_PUBLICATION_LAYOUT_IDENTIFIER,
      visibleFooterAttribution: false,
    },
    branding: {
      headerEmblemSha256: render.branding.emblem.assetSha256,
      footerEmblemSha256: render.branding.emblem.assetSha256,
      wordmarkSha256: render.branding.wordmark.assetSha256,
      watermarkSha256: render.branding.watermark.assetSha256,
      watermarkOpacity: render.branding.watermark.opacity,
    },
    publicationMetadata: { ...render.metadata },
    review: input.review,
  });
}

export function serializePublicationReviewReceipt(receipt: PublicationReviewReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

/**
 * Deterministic presentation facts for one VisionX chart-publication derivative.
 *
 * These values describe renderer layout and branding only. They are not
 * TradingView acceptance thresholds, frame-detection policy, legal guidance,
 * or application publication state.
 */

export const CHART_PUBLICATION_RENDERER_IDENTIFIER = "visionx.chart-publication" as const;
export const CHART_PUBLICATION_RENDERER_VERSION = 2 as const;
export const CHART_PUBLICATION_TEMPLATE_IDENTIFIER = "visionx.discord-chart" as const;
export const CHART_PUBLICATION_TEMPLATE_VERSION = 2 as const;
export const CHART_PUBLICATION_LAYOUT_IDENTIFIER = "chart_width_driven" as const;

export const CHART_PUBLICATION_OUTPUT_WIDTH = 2048 as const;

export const CHART_PUBLICATION_DIMENSIONS = Object.freeze({
  outerBorder: 1,
  headerHeight: 39,
  headerDivider: 1,
  chartGutterLeft: 4,
  chartGutterRight: 4,
  chartGutterTop: 4,
  chartGutterBottom: 4,
  footerDivider: 1,
  footerHeight: 33,
});

export const CHART_PUBLICATION_COLORS = Object.freeze({
  headerBackground: "#1B1B18",
  footerBackground: "#1B1B18",
  viewportGutter: "#151513",
  goldRule: "#3F371E",
  secondaryText: "#7F7F7E",
  titleText: "#E2E2E1",
});

export const CHART_PUBLICATION_FONT = Object.freeze({
  family: "DejaVu Sans, Arial, Helvetica, sans-serif",
  headerTitleSize: 14,
  headerTitleWeight: 700,
  headerTitleLetterSpacing: 0.5,
  headerSecondarySize: 10,
  headerSecondaryWeight: 600,
  footerSize: 10,
  footerWeight: 600,
  footerLetterSpacing: 0.35,
});

export const CHART_PUBLICATION_TEXT_LAYOUT = Object.freeze({
  left: 42,
  right: 2031,
  headerBaselineOffset: 25,
  footerLeft: 16,
  footerBaselineOffset: 22,
});

export const CHART_PUBLICATION_BRANDING = Object.freeze({
  emblem: Object.freeze({
    filename: "visionx-emblem.png",
    sha256: "3cdaa646018123c0d125641734bb14eace512d23e0ead1b56680cdb3c8bb3dba",
    sourceWidth: 615,
    sourceHeight: 592,
  }),
  wordmark: Object.freeze({
    filename: "visionx-wordmark.png",
    sha256: "93f5afe45fc1fc41b2ce9cc88070df01301a2fa37a6161c3f0eb0a572f1b9ba9",
    sourceWidth: 221,
    sourceHeight: 51,
  }),
  headerEmblem: Object.freeze({ left: 16, width: 15, height: 14 }),
  footerEmblem: Object.freeze({ width: 15, height: 14 }),
  footerWordmark: Object.freeze({ width: 58, height: 13 }),
  footerRightPadding: 15,
  footerAssetGap: 9,
  watermarkWidthRatio: 0.32,
  watermarkMaxHeightRatio: 0.58,
  watermarkOpacity: 0.035,
});

export const CHART_PUBLICATION_METADATA_MAX_LENGTHS = Object.freeze({
  title: 48,
  symbol: 24,
  timeframe: 10,
  market: 20,
  currency: 8,
  dataSource: 24,
  dataAsOf: 10,
  chartAttribution: 56,
  headerRightText: 36,
});

export interface ChartPublicationMetadata {
  readonly title: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly market: string;
  readonly currency?: string;
  readonly dataSource: string;
  readonly dataAsOf: string;
  readonly chartAttribution: string;
  readonly headerRightText?: string;
}

export interface MetadataValidationFailure {
  readonly ok: false;
  readonly detail: string;
}

export interface MetadataValidationSuccess {
  readonly ok: true;
  readonly metadata: ChartPublicationMetadata;
}

export type MetadataValidationResult = MetadataValidationSuccess | MetadataValidationFailure;

export interface RectanglePlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ChartPlacement {
  readonly viewportLeft: number;
  readonly viewportTop: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly renderedLeft: number;
  readonly renderedTop: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly fit: "contain";
}

export interface ChartPublicationLayout {
  readonly id: typeof CHART_PUBLICATION_LAYOUT_IDENTIFIER;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly outerBorderThickness: number;
  readonly header: RectanglePlacement;
  readonly headerDivider: RectanglePlacement;
  readonly viewport: RectanglePlacement;
  readonly chartGutters: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly placement: ChartPlacement;
  readonly footerDivider: RectanglePlacement;
  readonly footer: RectanglePlacement;
  readonly headerEmblem: RectanglePlacement;
  readonly footerEmblem: RectanglePlacement;
  readonly footerWordmark: RectanglePlacement;
  readonly watermark: RectanglePlacement & { readonly opacity: number };
}

const REQUIRED_METADATA_FIELDS = Object.freeze([
  "title",
  "symbol",
  "timeframe",
  "market",
  "dataSource",
  "dataAsOf",
  "chartAttribution",
] as const);
const OPTIONAL_METADATA_FIELDS = Object.freeze(["currency", "headerRightText"] as const);
const ALLOWED_METADATA_FIELDS = new Set<string>([
  ...REQUIRED_METADATA_FIELDS,
  ...OPTIONAL_METADATA_FIELDS,
]);
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function freezeMetadata(metadata: ChartPublicationMetadata): ChartPublicationMetadata {
  return Object.freeze(metadata);
}

function freezeRectangle(rectangle: RectanglePlacement): RectanglePlacement {
  return Object.freeze(rectangle);
}

function failMetadata(detail: string): MetadataValidationFailure {
  return Object.freeze({ ok: false, detail });
}

function validCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateStringField(
  record: Readonly<Record<string, unknown>>,
  field: keyof typeof CHART_PUBLICATION_METADATA_MAX_LENGTHS,
  required: boolean,
): string | MetadataValidationFailure | undefined {
  const value = record[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    return failMetadata(`metadata field ${field} must be a string`);
  }
  if (value.trim().length === 0) {
    return failMetadata(`metadata field ${field} must not be empty or whitespace-only`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    return failMetadata(`metadata field ${field} must not contain control characters or newlines`);
  }
  const maximum = CHART_PUBLICATION_METADATA_MAX_LENGTHS[field];
  if (value.length > maximum) {
    return failMetadata(`metadata field ${field} exceeds maximum length ${maximum}`);
  }
  return value;
}

export function validateChartPublicationMetadata(value: unknown): MetadataValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failMetadata("metadata must be a JSON object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(record).filter((field) => !ALLOWED_METADATA_FIELDS.has(field));
  if (unknown.length > 0) {
    return failMetadata(`metadata contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }

  const title = validateStringField(record, "title", true);
  if (typeof title !== "string") return title ?? failMetadata("metadata field title is required");
  const symbol = validateStringField(record, "symbol", true);
  if (typeof symbol !== "string") return symbol ?? failMetadata("metadata field symbol is required");
  const timeframe = validateStringField(record, "timeframe", true);
  if (typeof timeframe !== "string") return timeframe ?? failMetadata("metadata field timeframe is required");
  const market = validateStringField(record, "market", true);
  if (typeof market !== "string") return market ?? failMetadata("metadata field market is required");
  const currency = validateStringField(record, "currency", false);
  if (currency !== undefined && typeof currency !== "string") return currency;
  const dataSource = validateStringField(record, "dataSource", true);
  if (typeof dataSource !== "string") return dataSource ?? failMetadata("metadata field dataSource is required");
  const dataAsOf = validateStringField(record, "dataAsOf", true);
  if (typeof dataAsOf !== "string") return dataAsOf ?? failMetadata("metadata field dataAsOf is required");
  if (!validCalendarDate(dataAsOf)) {
    return failMetadata("metadata field dataAsOf must be a valid YYYY-MM-DD calendar date");
  }
  const chartAttribution = validateStringField(record, "chartAttribution", true);
  if (typeof chartAttribution !== "string") {
    return chartAttribution ?? failMetadata("metadata field chartAttribution is required");
  }
  const headerRightText = validateStringField(record, "headerRightText", false);
  if (headerRightText !== undefined && typeof headerRightText !== "string") return headerRightText;

  const metadata: ChartPublicationMetadata = {
    title,
    symbol,
    timeframe,
    market,
    dataSource,
    dataAsOf,
    chartAttribution,
    ...(currency === undefined ? {} : { currency }),
    ...(headerRightText === undefined ? {} : { headerRightText }),
  };
  return Object.freeze({ ok: true, metadata: freezeMetadata(metadata) });
}

export function formatPublicationDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/**
 * Width-driven layout. The complete detected chart is scaled from one width
 * factor only; the rounded height is derived from the source aspect ratio.
 */
export function calculateChartPublicationLayout(
  sourceWidth: number,
  sourceHeight: number,
): ChartPublicationLayout {
  positiveInteger(sourceWidth, "source width");
  positiveInteger(sourceHeight, "source height");

  const dimensions = CHART_PUBLICATION_DIMENSIONS;
  const innerWidth = CHART_PUBLICATION_OUTPUT_WIDTH - (dimensions.outerBorder * 2);
  const renderedWidth = innerWidth - dimensions.chartGutterLeft - dimensions.chartGutterRight;
  const renderedHeight = Math.max(1, Math.round((sourceHeight * renderedWidth) / sourceWidth));
  const viewportHeight = dimensions.chartGutterTop + renderedHeight + dimensions.chartGutterBottom;
  const headerTop = dimensions.outerBorder;
  const headerDividerTop = headerTop + dimensions.headerHeight;
  const viewportTop = headerDividerTop + dimensions.headerDivider;
  const footerDividerTop = viewportTop + viewportHeight;
  const footerTop = footerDividerTop + dimensions.footerDivider;
  const outputHeight = footerTop + dimensions.footerHeight + dimensions.outerBorder;
  const viewportLeft = dimensions.outerBorder;
  const renderedLeft = viewportLeft + dimensions.chartGutterLeft;
  const renderedTop = viewportTop + dimensions.chartGutterTop;

  const watermarkWidthFromChart = Math.max(
    1,
    Math.round(renderedWidth * CHART_PUBLICATION_BRANDING.watermarkWidthRatio),
  );
  const watermarkWidthFromHeight = Math.max(
    1,
    Math.floor(
      renderedHeight *
      CHART_PUBLICATION_BRANDING.watermarkMaxHeightRatio *
      (CHART_PUBLICATION_BRANDING.emblem.sourceWidth / CHART_PUBLICATION_BRANDING.emblem.sourceHeight),
    ),
  );
  const watermarkWidth = Math.min(watermarkWidthFromChart, watermarkWidthFromHeight);
  const watermarkHeight = Math.max(
    1,
    Math.round(
      watermarkWidth *
      (CHART_PUBLICATION_BRANDING.emblem.sourceHeight / CHART_PUBLICATION_BRANDING.emblem.sourceWidth),
    ),
  );

  const headerEmblemTop = headerTop + Math.floor(
    (dimensions.headerHeight - CHART_PUBLICATION_BRANDING.headerEmblem.height) / 2,
  );
  const footerEmblemTop = footerTop + Math.floor(
    (dimensions.footerHeight - CHART_PUBLICATION_BRANDING.footerEmblem.height) / 2,
  );
  const footerWordmarkTop = footerTop + Math.floor(
    (dimensions.footerHeight - CHART_PUBLICATION_BRANDING.footerWordmark.height) / 2,
  );
  const footerWordmarkLeft =
    CHART_PUBLICATION_OUTPUT_WIDTH -
    dimensions.outerBorder -
    CHART_PUBLICATION_BRANDING.footerRightPadding -
    CHART_PUBLICATION_BRANDING.footerWordmark.width;
  const footerEmblemLeft =
    footerWordmarkLeft -
    CHART_PUBLICATION_BRANDING.footerAssetGap -
    CHART_PUBLICATION_BRANDING.footerEmblem.width;

  const placement: ChartPlacement = Object.freeze({
    viewportLeft,
    viewportTop,
    viewportWidth: innerWidth,
    viewportHeight,
    renderedLeft,
    renderedTop,
    renderedWidth,
    renderedHeight,
    fit: "contain",
  });

  return Object.freeze({
    id: CHART_PUBLICATION_LAYOUT_IDENTIFIER,
    outputWidth: CHART_PUBLICATION_OUTPUT_WIDTH,
    outputHeight,
    outerBorderThickness: dimensions.outerBorder,
    header: freezeRectangle({ left: dimensions.outerBorder, top: headerTop, width: innerWidth, height: dimensions.headerHeight }),
    headerDivider: freezeRectangle({ left: dimensions.outerBorder, top: headerDividerTop, width: innerWidth, height: dimensions.headerDivider }),
    viewport: freezeRectangle({ left: viewportLeft, top: viewportTop, width: innerWidth, height: viewportHeight }),
    chartGutters: Object.freeze({
      left: dimensions.chartGutterLeft,
      right: dimensions.chartGutterRight,
      top: dimensions.chartGutterTop,
      bottom: dimensions.chartGutterBottom,
    }),
    placement,
    footerDivider: freezeRectangle({ left: dimensions.outerBorder, top: footerDividerTop, width: innerWidth, height: dimensions.footerDivider }),
    footer: freezeRectangle({ left: dimensions.outerBorder, top: footerTop, width: innerWidth, height: dimensions.footerHeight }),
    headerEmblem: freezeRectangle({
      left: CHART_PUBLICATION_BRANDING.headerEmblem.left,
      top: headerEmblemTop,
      width: CHART_PUBLICATION_BRANDING.headerEmblem.width,
      height: CHART_PUBLICATION_BRANDING.headerEmblem.height,
    }),
    footerEmblem: freezeRectangle({
      left: footerEmblemLeft,
      top: footerEmblemTop,
      width: CHART_PUBLICATION_BRANDING.footerEmblem.width,
      height: CHART_PUBLICATION_BRANDING.footerEmblem.height,
    }),
    footerWordmark: freezeRectangle({
      left: footerWordmarkLeft,
      top: footerWordmarkTop,
      width: CHART_PUBLICATION_BRANDING.footerWordmark.width,
      height: CHART_PUBLICATION_BRANDING.footerWordmark.height,
    }),
    watermark: Object.freeze({
      left: renderedLeft + Math.floor((renderedWidth - watermarkWidth) / 2),
      top: renderedTop + Math.floor((renderedHeight - watermarkHeight) / 2),
      width: watermarkWidth,
      height: watermarkHeight,
      opacity: CHART_PUBLICATION_BRANDING.watermarkOpacity,
    }),
  });
}

export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function displayValue(value: string): string {
  return value.trim();
}

export function visibleChartPublicationFooter(metadata: ChartPublicationMetadata): string {
  return `SOURCE: ${displayValue(metadata.dataSource).toUpperCase()} · DATA AS OF: ${formatPublicationDate(metadata.dataAsOf)}`;
}

export function buildChartPublicationOverlaySvg(
  metadata: ChartPublicationMetadata,
  layout: ChartPublicationLayout,
): string {
  const header = `${displayValue(metadata.title)} · ${displayValue(metadata.timeframe)} · ${displayValue(metadata.market)}`;
  const footer = visibleChartPublicationFooter(metadata);
  const rightValue = metadata.currency ?? metadata.headerRightText;
  const right = rightValue === undefined
    ? ""
    : `<text x="${CHART_PUBLICATION_TEXT_LAYOUT.right}" y="${layout.header.top + CHART_PUBLICATION_TEXT_LAYOUT.headerBaselineOffset}" text-anchor="end" class="header-right">${escapeXmlText(displayValue(rightValue))}</text>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.outputWidth}" height="${layout.outputHeight}" viewBox="0 0 ${layout.outputWidth} ${layout.outputHeight}">`,
    `<style>`,
    `.header{font-family:${CHART_PUBLICATION_FONT.family};font-size:${CHART_PUBLICATION_FONT.headerTitleSize}px;font-weight:${CHART_PUBLICATION_FONT.headerTitleWeight};fill:${CHART_PUBLICATION_COLORS.titleText};letter-spacing:${CHART_PUBLICATION_FONT.headerTitleLetterSpacing}px}`,
    `.header-right{font-family:${CHART_PUBLICATION_FONT.family};font-size:${CHART_PUBLICATION_FONT.headerSecondarySize}px;font-weight:${CHART_PUBLICATION_FONT.headerSecondaryWeight};fill:${CHART_PUBLICATION_COLORS.secondaryText}}`,
    `.footer{font-family:${CHART_PUBLICATION_FONT.family};font-size:${CHART_PUBLICATION_FONT.footerSize}px;font-weight:${CHART_PUBLICATION_FONT.footerWeight};fill:${CHART_PUBLICATION_COLORS.secondaryText};letter-spacing:${CHART_PUBLICATION_FONT.footerLetterSpacing}px}`,
    `</style>`,
    `<text x="${CHART_PUBLICATION_TEXT_LAYOUT.left}" y="${layout.header.top + CHART_PUBLICATION_TEXT_LAYOUT.headerBaselineOffset}" class="header">${escapeXmlText(header)}</text>`,
    right,
    `<text x="${CHART_PUBLICATION_TEXT_LAYOUT.footerLeft}" y="${layout.footer.top + CHART_PUBLICATION_TEXT_LAYOUT.footerBaselineOffset}" class="footer">${escapeXmlText(footer)}</text>`,
    `</svg>`,
  ].join("");
}

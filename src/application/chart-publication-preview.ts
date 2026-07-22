import { basename } from "node:path";

import type { Pack } from "../packs/packs.ts";
import type { Registry } from "../registry/registry.ts";
import type { Resolver } from "../resolver/index.ts";
import type { ChartPublicationMetadata } from "../rendering/chart-publication-template.ts";
import { chartPublicationMetadataForAsset } from "./chart-publication-metadata.ts";

export const CHART_PUBLICATION_PREVIEW_ATTRIBUTION = "Chart source: TradingView" as const;
export const STANDARD_PACK_CHART_TIMEFRAME = "1D" as const;
export const ETF_PACK_CHART_TIMEFRAME = "4D" as const;

const IDENTIFIER = /^[a-z0-9][a-z0-9_-]*$/u;
const TRADINGVIEW_EXPORT = /^(?<symbol>.+)_(?<date>\d{4}-\d{2}-\d{2})_(?<time>\d{2}-\d{2}-\d{2})\.png$/iu;

/**
 * Timeframes accepted by Registry-backed chart rendering. The list is shared
 * by the standalone UI/CLI and Pack policy so unsupported or misspelled values
 * fail before the deterministic renderer is invoked.
 */
export const SUPPORTED_CHART_PUBLICATION_TIMEFRAMES = Object.freeze([
  "1S",
  "5S",
  "10S",
  "15S",
  "30S",
  "45S",
  "1M",
  "2M",
  "3M",
  "5M",
  "10M",
  "15M",
  "20M",
  "30M",
  "45M",
  "1H",
  "2H",
  "3H",
  "4H",
  "6H",
  "8H",
  "12H",
  "1D",
  "2D",
  "3D",
  "4D",
  "5D",
  "6D",
  "1W",
  "2W",
  "3W",
  "4W",
  "1MO",
  "2MO",
  "3MO",
  "6MO",
  "12MO",
] as const);

export type ChartPublicationTimeframe =
  (typeof SUPPORTED_CHART_PUBLICATION_TIMEFRAMES)[number];

const SUPPORTED_TIMEFRAMES = new Set<string>(SUPPORTED_CHART_PUBLICATION_TIMEFRAMES);

export type ChartPublicationRenderingContext = "pack" | "standalone";

export interface StandaloneChartPublicationPreviewRequest {
  readonly context: "standalone";
  readonly assetId: string;
  readonly timeframe: ChartPublicationTimeframe;
}

export interface PackChartPublicationPreviewRequest {
  readonly context: "pack";
  readonly assetId: string;
  readonly packId: string;
}

export type ChartPublicationPreviewRequest =
  | StandaloneChartPublicationPreviewRequest
  | PackChartPublicationPreviewRequest;

export type ChartPublicationPreviewPreparationResult =
  | {
      readonly ok: true;
      readonly context: ChartPublicationRenderingContext;
      readonly sourceBasename: string;
      readonly assetId: string;
      readonly packId?: string;
      readonly timeframe: ChartPublicationTimeframe;
      readonly dataAsOf: string;
      readonly metadata: ChartPublicationMetadata;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_request"
        | "unparseable_filename"
        | "unknown_symbol"
        | "missing_export_timestamp"
        | "invalid_export_timestamp"
        | "request_asset_mismatch"
        | "pack_definitions_required"
        | "unknown_pack"
        | "asset_not_in_pack"
        | "invalid_asset_metadata";
      readonly detail: string;
    };

function failure(
  reason: Exclude<ChartPublicationPreviewPreparationResult, { readonly ok: true }>["reason"],
  detail: string,
): ChartPublicationPreviewPreparationResult {
  return Object.freeze({ ok: false, reason, detail });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateIdentifier(value: unknown, field: string): string | { readonly detail: string } {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    return Object.freeze({ detail: `${field} must be a lowercase identifier` });
  }
  return value;
}

export function validateChartPublicationTimeframe(
  value: unknown,
):
  | { readonly ok: true; readonly timeframe: ChartPublicationTimeframe }
  | { readonly ok: false; readonly detail: string } {
  if (typeof value !== "string" || !SUPPORTED_TIMEFRAMES.has(value)) {
    return Object.freeze({
      ok: false,
      detail: `timeframe must be one of: ${SUPPORTED_CHART_PUBLICATION_TIMEFRAMES.join(", ")}`,
    });
  }
  return Object.freeze({ ok: true, timeframe: value as ChartPublicationTimeframe });
}

export function validateChartPublicationPreviewRequest(
  value: unknown,
):
  | { readonly ok: true; readonly request: ChartPublicationPreviewRequest }
  | { readonly ok: false; readonly detail: string } {
  if (!isRecord(value)) {
    return Object.freeze({ ok: false, detail: "preview request must be an object" });
  }
  if (value.context !== "standalone" && value.context !== "pack") {
    return Object.freeze({ ok: false, detail: "preview request context must be standalone or pack" });
  }

  const assetId = validateIdentifier(value.assetId, "preview request assetId");
  if (typeof assetId !== "string") return Object.freeze({ ok: false, detail: assetId.detail });

  if (value.context === "standalone") {
    const allowed = new Set(["context", "assetId", "timeframe"]);
    const unknown = Object.keys(value).filter((field) => !allowed.has(field));
    if (unknown.length > 0) {
      return Object.freeze({
        ok: false,
        detail: `standalone preview request contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
      });
    }
    const timeframe = validateChartPublicationTimeframe(value.timeframe);
    if (!timeframe.ok) return timeframe;
    return Object.freeze({
      ok: true,
      request: Object.freeze({ context: "standalone", assetId, timeframe: timeframe.timeframe }),
    });
  }

  const allowed = new Set(["context", "assetId", "packId"]);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    return Object.freeze({
      ok: false,
      detail: `pack preview request contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    });
  }
  const packId = validateIdentifier(value.packId, "preview request packId");
  if (typeof packId !== "string") return Object.freeze({ ok: false, detail: packId.detail });
  return Object.freeze({
    ok: true,
    request: Object.freeze({ context: "pack", assetId, packId }),
  });
}

export function defaultChartPublicationTimeframeForPack(
  pack: Pick<Pack, "id">,
): ChartPublicationTimeframe {
  return pack.id === "etfs" ? ETF_PACK_CHART_TIMEFRAME : STANDARD_PACK_CHART_TIMEFRAME;
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
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

function validClockStamp(value: string): boolean {
  const match = /^(\d{2})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  return hour <= 23 && minute <= 59 && second <= 59;
}

export function deriveTradingViewExportDate(
  filename: string,
):
  | { readonly ok: true; readonly dataAsOf: string }
  | {
      readonly ok: false;
      readonly reason: "missing_export_timestamp" | "invalid_export_timestamp";
      readonly detail: string;
    } {
  const sourceBasename = basename(filename);
  const match = TRADINGVIEW_EXPORT.exec(sourceBasename);
  if (match?.groups === undefined) {
    return Object.freeze({
      ok: false,
      reason: "missing_export_timestamp",
      detail: "input filename must use TradingView export form SYMBOL_YYYY-MM-DD_HH-MM-SS.png",
    });
  }
  const date = match.groups.date;
  const time = match.groups.time;
  if (date === undefined || time === undefined || !validCalendarDate(date) || !validClockStamp(time)) {
    return Object.freeze({
      ok: false,
      reason: "invalid_export_timestamp",
      detail: `input filename contains an invalid TradingView export timestamp: ${sourceBasename}`,
    });
  }
  return Object.freeze({ ok: true, dataAsOf: date });
}

/**
 * Prepare one Registry-backed local render. Stable Asset fields come from the
 * Registry, export date comes from the source filename, and visible SOURCE is
 * the canonical market. Standalone requests provide a validated timeframe;
 * Pack requests derive it from Pack policy after membership is proven.
 */
export function prepareChartPublicationPreview(
  registry: Registry,
  resolver: Resolver,
  inputPath: string,
  requestValue: unknown,
  packs?: readonly Pack[],
): ChartPublicationPreviewPreparationResult {
  const validatedRequest = validateChartPublicationPreviewRequest(requestValue);
  if (!validatedRequest.ok) return failure("invalid_request", validatedRequest.detail);
  const request = validatedRequest.request;

  const sourceBasename = basename(inputPath);
  const resolved = resolver.resolve(sourceBasename);
  if (!resolved.ok) {
    if (resolved.reason === "unparseable_filename") {
      return failure("unparseable_filename", `could not extract an Asset token from ${sourceBasename}`);
    }
    return failure("unknown_symbol", `filename symbol ${resolved.symbol} is not in the Registry filename namespace`);
  }
  if (resolved.asset.id !== request.assetId) {
    return failure(
      "request_asset_mismatch",
      `preview request is for Asset ${request.assetId}, but ${sourceBasename} resolves to ${resolved.asset.id}`,
    );
  }

  let timeframe: ChartPublicationTimeframe;
  let packId: string | undefined;
  if (request.context === "pack") {
    if (packs === undefined) {
      return failure("pack_definitions_required", "pack rendering requires validated Pack definitions");
    }
    const pack = packs.find((candidate) => candidate.id === request.packId);
    if (pack === undefined) {
      return failure("unknown_pack", `Pack ${request.packId} was not found`);
    }
    if (!pack.assets.includes(request.assetId)) {
      return failure(
        "asset_not_in_pack",
        `Asset ${request.assetId} does not belong to Pack ${request.packId}`,
      );
    }
    timeframe = defaultChartPublicationTimeframeForPack(pack);
    packId = pack.id;
  } else {
    timeframe = request.timeframe;
  }

  const exportDate = deriveTradingViewExportDate(sourceBasename);
  if (!exportDate.ok) return failure(exportDate.reason, exportDate.detail);

  const canonical = registry.all().find((asset) => asset.id === resolved.asset.id);
  if (canonical === undefined) {
    return failure(
      "invalid_asset_metadata",
      `resolved Asset ${resolved.asset.id} does not belong to the supplied Registry`,
    );
  }
  const separator = canonical.tradingView.indexOf(":");
  if (separator <= 0) {
    return failure(
      "invalid_asset_metadata",
      `Asset ${canonical.id} does not have a qualified canonical TradingView identity`,
    );
  }
  const market = canonical.tradingView.slice(0, separator);
  const metadata = chartPublicationMetadataForAsset(canonical, {
    timeframe,
    dataSource: market,
    dataAsOf: exportDate.dataAsOf,
    chartAttribution: CHART_PUBLICATION_PREVIEW_ATTRIBUTION,
  });
  if (!metadata.ok) {
    return failure("invalid_asset_metadata", `${metadata.reason}: ${metadata.detail}`);
  }

  return Object.freeze({
    ok: true,
    context: request.context,
    sourceBasename,
    assetId: resolved.asset.id,
    ...(packId === undefined ? {} : { packId }),
    timeframe,
    dataAsOf: exportDate.dataAsOf,
    metadata: metadata.metadata,
  });
}

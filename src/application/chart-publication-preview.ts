import { basename } from "node:path";

import type { Registry } from "../registry/registry.ts";
import type { Resolver } from "../resolver/index.ts";
import type { ChartPublicationMetadata } from "../rendering/chart-publication-template.ts";
import { chartPublicationMetadataForAsset } from "./chart-publication-metadata.ts";

export const CHART_PUBLICATION_PREVIEW_PROFILE_SCHEMA_VERSION = 1 as const;
export const CHART_PUBLICATION_PREVIEW_ATTRIBUTION = "Chart source: TradingView" as const;

const PROFILE_FIELDS = new Set(["schemaVersion", "assetId", "timeframe"]);
const ASSET_ID = /^[a-z0-9][a-z0-9_-]*$/u;
const TRADINGVIEW_EXPORT = /^(?<symbol>.+)_(?<date>\d{4}-\d{2}-\d{2})_(?<time>\d{2}-\d{2}-\d{2})\.png$/iu;

/**
 * Timeframes accepted by the local preview workflow. The profile is a
 * controlled fact, not a free-form prompt, so unsupported or misspelled
 * values fail before rendering.
 */
export const SUPPORTED_CHART_PUBLICATION_PREVIEW_TIMEFRAMES = Object.freeze([
  "1S",
  "5S",
  "10S",
  "15S",
  "30S",
  "1M",
  "2M",
  "3M",
  "5M",
  "10M",
  "15M",
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
  "1W",
  "1MO",
  "3MO",
  "6MO",
  "12MO",
] as const);

export type ChartPublicationPreviewTimeframe =
  (typeof SUPPORTED_CHART_PUBLICATION_PREVIEW_TIMEFRAMES)[number];

const SUPPORTED_TIMEFRAMES = new Set<string>(
  SUPPORTED_CHART_PUBLICATION_PREVIEW_TIMEFRAMES,
);

export interface ChartPublicationPreviewProfile {
  readonly schemaVersion: typeof CHART_PUBLICATION_PREVIEW_PROFILE_SCHEMA_VERSION;
  readonly assetId: string;
  readonly timeframe: ChartPublicationPreviewTimeframe;
}

export type ChartPublicationPreviewPreparationResult =
  | {
      readonly ok: true;
      readonly sourceBasename: string;
      readonly assetId: string;
      readonly dataAsOf: string;
      readonly metadata: ChartPublicationMetadata;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_profile"
        | "unparseable_filename"
        | "unknown_symbol"
        | "missing_export_timestamp"
        | "invalid_export_timestamp"
        | "profile_asset_mismatch"
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

export function validateChartPublicationPreviewProfile(
  value: unknown,
):
  | { readonly ok: true; readonly profile: ChartPublicationPreviewProfile }
  | { readonly ok: false; readonly detail: string } {
  if (!isRecord(value)) {
    return Object.freeze({ ok: false, detail: "preview profile must be a JSON object" });
  }
  const unknown = Object.keys(value).filter((field) => !PROFILE_FIELDS.has(field));
  if (unknown.length > 0) {
    return Object.freeze({
      ok: false,
      detail: `preview profile contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    });
  }
  if (value.schemaVersion !== CHART_PUBLICATION_PREVIEW_PROFILE_SCHEMA_VERSION) {
    return Object.freeze({
      ok: false,
      detail: `preview profile schemaVersion must be ${CHART_PUBLICATION_PREVIEW_PROFILE_SCHEMA_VERSION}`,
    });
  }
  if (typeof value.assetId !== "string" || !ASSET_ID.test(value.assetId)) {
    return Object.freeze({
      ok: false,
      detail: "preview profile assetId must be a lowercase Registry asset id",
    });
  }
  if (typeof value.timeframe !== "string" || !SUPPORTED_TIMEFRAMES.has(value.timeframe)) {
    return Object.freeze({
      ok: false,
      detail: `preview profile timeframe must be one of: ${SUPPORTED_CHART_PUBLICATION_PREVIEW_TIMEFRAMES.join(", ")}`,
    });
  }
  return Object.freeze({
    ok: true,
    profile: Object.freeze({
      schemaVersion: CHART_PUBLICATION_PREVIEW_PROFILE_SCHEMA_VERSION,
      assetId: value.assetId,
      timeframe: value.timeframe as ChartPublicationPreviewTimeframe,
    }),
  });
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
 * Prepare one local-only publication preview from governed identity and
 * controlled render facts. Stable Asset fields come from Registry; the export
 * date comes from the source filename; visible SOURCE is the canonical market;
 * and TradingView remains receipt attribution.
 */
export function prepareChartPublicationPreview(
  registry: Registry,
  resolver: Resolver,
  inputPath: string,
  profileValue: unknown,
): ChartPublicationPreviewPreparationResult {
  const profile = validateChartPublicationPreviewProfile(profileValue);
  if (!profile.ok) return failure("invalid_profile", profile.detail);

  const sourceBasename = basename(inputPath);
  const resolved = resolver.resolve(sourceBasename);
  if (!resolved.ok) {
    if (resolved.reason === "unparseable_filename") {
      return failure("unparseable_filename", `could not extract an Asset token from ${sourceBasename}`);
    }
    return failure("unknown_symbol", `filename symbol ${resolved.symbol} is not in the Registry filename namespace`);
  }
  if (resolved.asset.id !== profile.profile.assetId) {
    return failure(
      "profile_asset_mismatch",
      `preview profile is for Asset ${profile.profile.assetId}, but ${sourceBasename} resolves to ${resolved.asset.id}`,
    );
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
    timeframe: profile.profile.timeframe,
    dataSource: market,
    dataAsOf: exportDate.dataAsOf,
    chartAttribution: CHART_PUBLICATION_PREVIEW_ATTRIBUTION,
  });
  if (!metadata.ok) {
    return failure("invalid_asset_metadata", `${metadata.reason}: ${metadata.detail}`);
  }

  return Object.freeze({
    ok: true,
    sourceBasename,
    assetId: resolved.asset.id,
    dataAsOf: exportDate.dataAsOf,
    metadata: metadata.metadata,
  });
}

import type { Asset } from "../types.ts";
import {
  validateChartPublicationMetadata,
  type ChartPublicationMetadata,
} from "../rendering/chart-publication-template.ts";
import {
  isQualifiedTradingViewSymbol,
  validatePublicationCurrency,
} from "../registry/asset-market-identity.ts";

export interface ChartRenderFacts {
  readonly timeframe: string;
  readonly dataSource: string;
  readonly dataAsOf: string;
  readonly chartAttribution: string;
  readonly headerRightText?: string;
}

export type ChartPublicationMetadataFromAssetResult =
  | { readonly ok: true; readonly metadata: ChartPublicationMetadata }
  | {
      readonly ok: false;
      readonly reason:
        | "unqualified_tradingview_symbol"
        | "missing_asset_currency"
        | "invalid_asset_currency"
        | "invalid_render_metadata";
      readonly detail: string;
    };

function failure(
  reason: Exclude<ChartPublicationMetadataFromAssetResult, { readonly ok: true }>["reason"],
  detail: string,
): ChartPublicationMetadataFromAssetResult {
  return Object.freeze({ ok: false, reason, detail });
}

/**
 * Construct first-party chart-publication metadata from one canonical Asset.
 * Asset-owned facts cannot be supplied or overridden by the caller.
 */
export function chartPublicationMetadataForAsset(
  asset: Asset,
  facts: ChartRenderFacts,
): ChartPublicationMetadataFromAssetResult {
  if (!isQualifiedTradingViewSymbol(asset.tradingView)) {
    return failure(
      "unqualified_tradingview_symbol",
      `Asset ${asset.id} must have a qualified canonical TradingView token before rendering.`,
    );
  }
  const [market, symbol] = asset.tradingView.split(":");
  if (market === undefined || symbol === undefined || market.length === 0 || symbol.length === 0) {
    return failure("unqualified_tradingview_symbol", `Asset ${asset.id} has an invalid qualified TradingView token.`);
  }
  if (asset.currency === undefined) {
    return failure("missing_asset_currency", `Asset ${asset.id} does not have canonical currency metadata.`);
  }
  const currency = validatePublicationCurrency(asset.currency);
  if (!currency.ok) {
    return failure("invalid_asset_currency", `Asset ${asset.id} currency is invalid: ${currency.detail}`);
  }

  const candidate = {
    title: asset.display.toUpperCase(),
    symbol,
    timeframe: facts.timeframe,
    market,
    currency: currency.currency,
    dataSource: facts.dataSource,
    dataAsOf: facts.dataAsOf,
    chartAttribution: facts.chartAttribution,
    ...(facts.headerRightText === undefined ? {} : { headerRightText: facts.headerRightText }),
  };
  const validated = validateChartPublicationMetadata(candidate);
  if (!validated.ok) return failure("invalid_render_metadata", validated.detail);
  return Object.freeze({ ok: true, metadata: validated.metadata });
}

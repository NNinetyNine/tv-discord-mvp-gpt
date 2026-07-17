import type { ChartPublicationMetadata } from "../rendering/chart-publication-template.ts";
import type { ProposedAssetMarketIdentity } from "../registry/asset-market-identity.ts";

export type ProposedAssetPublicationMetadataPreview = Readonly<
  Pick<ChartPublicationMetadata, "title" | "symbol" | "market" | "currency">
>;

/**
 * Resolve only the stable, Asset-owned portion of chart-publication metadata.
 * Timeframe, data source/date, and attribution remain explicit per-render facts.
 */
export function previewChartPublicationMetadataForProposedAsset(
  asset: ProposedAssetMarketIdentity,
): ProposedAssetPublicationMetadataPreview {
  return Object.freeze({
    title: asset.displayName.toUpperCase(),
    symbol: asset.symbol,
    market: asset.market,
    currency: asset.currency,
  });
}

import type { Asset } from "../types.ts";
import type { Pack } from "../packs/packs.ts";
import {
  ASSET_MARKET_IDENTITY_MAX_LENGTHS,
  ASSET_MARKET_MIN_LENGTH,
  isQualifiedTradingViewSymbol,
  validatePublicationCurrency,
} from "./asset-market-identity.ts";

const AUDIT_MARKET_PATTERN = /^[A-Z0-9]+$/u;
const AUDIT_SYMBOL_PATTERN = /^[A-Z0-9._!-]+$/u;

export type MarketIdentityAuditIssue =
  | "unqualified_market_symbol"
  | "missing_publication_currency"
  | "invalid_publication_currency"
  | "market_symbol_mismatch"
  | "unknown_pack_asset"
  | "duplicate_pack_asset";

export interface AuditableAsset extends Asset {}

export interface AuditablePack {
  readonly id: string;
  readonly assets: readonly unknown[];
}

export interface AssetMarketIdentityAuditEntry {
  readonly assetId: string;
  readonly displayName: string;
  readonly currentTradingView: string;
  readonly packIds: readonly string[];
  readonly marketIdentityStatus: "complete" | "requires_curator_decision";
  readonly currencyStatus: "valid" | "missing" | "invalid";
  readonly issues: readonly MarketIdentityAuditIssue[];
  readonly market?: string;
  readonly tradingViewSymbol?: string;
  readonly currency?: string;
}

export interface AssetMarketIdentityAuditGap {
  readonly issue: MarketIdentityAuditIssue;
  readonly assetId: string;
  readonly packId?: string;
}

export interface AssetMarketIdentityAudit {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly registryAssetCount: number;
  readonly packCount: number;
  readonly packMembershipCount: number;
  readonly assets: readonly AssetMarketIdentityAuditEntry[];
  readonly gaps: readonly AssetMarketIdentityAuditGap[];
}

function issueOrder(issue: MarketIdentityAuditIssue): number {
  return [
    "unqualified_market_symbol",
    "missing_publication_currency",
    "invalid_publication_currency",
    "market_symbol_mismatch",
    "unknown_pack_asset",
    "duplicate_pack_asset",
  ].indexOf(issue);
}

function freezeEntry(entry: AssetMarketIdentityAuditEntry): AssetMarketIdentityAuditEntry {
  return Object.freeze({ ...entry, packIds: Object.freeze([...entry.packIds]), issues: Object.freeze([...entry.issues]) });
}

export function auditAssetMarketIdentity(
  assets: readonly AuditableAsset[],
  packs: readonly AuditablePack[],
): AssetMarketIdentityAudit {
  const byId = new Map(assets.map((asset) => [asset.id, asset] as const));
  const membership = new Map<string, string[]>();
  const gaps: AssetMarketIdentityAuditGap[] = [];
  let membershipCount = 0;

  for (const pack of packs) {
    const seen = new Set<string>();
    for (const rawAssetId of pack.assets) {
      membershipCount += 1;
      if (typeof rawAssetId !== "string") {
        gaps.push(Object.freeze({ issue: "unknown_pack_asset", assetId: String(rawAssetId), packId: pack.id }));
        continue;
      }
      if (seen.has(rawAssetId)) {
        gaps.push(Object.freeze({ issue: "duplicate_pack_asset", assetId: rawAssetId, packId: pack.id }));
      }
      seen.add(rawAssetId);
      if (!byId.has(rawAssetId)) {
        gaps.push(Object.freeze({ issue: "unknown_pack_asset", assetId: rawAssetId, packId: pack.id }));
        continue;
      }
      const current = membership.get(rawAssetId) ?? [];
      current.push(pack.id);
      membership.set(rawAssetId, current);
    }
  }

  const entries = [...assets]
    .sort((a, b) => a.id.localeCompare(b.id, "en"))
    .map((asset): AssetMarketIdentityAuditEntry => {
      const issues: MarketIdentityAuditIssue[] = [];
      const qualified = isQualifiedTradingViewSymbol(asset.tradingView) ? asset.tradingView : undefined;
      let market: string | undefined;
      if (qualified === undefined) {
        issues.push("unqualified_market_symbol");
      } else {
        const [prefix, instrument] = qualified.split(":");
        const qualifiedIsValid = prefix !== undefined && instrument !== undefined &&
          prefix.length >= ASSET_MARKET_MIN_LENGTH &&
          prefix.length <= ASSET_MARKET_IDENTITY_MAX_LENGTHS.market &&
          qualified.length <= ASSET_MARKET_IDENTITY_MAX_LENGTHS.tradingViewSymbol &&
          AUDIT_MARKET_PATTERN.test(prefix) && AUDIT_SYMBOL_PATTERN.test(instrument);
        if (!qualifiedIsValid) {
          issues.push("unqualified_market_symbol");
        } else {
          market = prefix;
        }
      }

      let currencyStatus: AssetMarketIdentityAuditEntry["currencyStatus"] = "missing";
      let currency: string | undefined;
      if (asset.currency === undefined || asset.currency === null || asset.currency === "") {
        issues.push("missing_publication_currency");
      } else {
        const validated = validatePublicationCurrency(asset.currency);
        if (!validated.ok) {
          currencyStatus = "invalid";
          issues.push("invalid_publication_currency");
        } else {
          currencyStatus = "valid";
          currency = validated.currency;
        }
      }
      issues.sort((a, b) => issueOrder(a) - issueOrder(b));
      for (const issue of issues) gaps.push(Object.freeze({ issue, assetId: asset.id }));
      return freezeEntry({
        assetId: asset.id,
        displayName: asset.display,
        currentTradingView: asset.tradingView,
        packIds: (membership.get(asset.id) ?? []).sort((a, b) => a.localeCompare(b, "en")),
        marketIdentityStatus: issues.includes("unqualified_market_symbol") || issues.includes("market_symbol_mismatch")
          ? "requires_curator_decision"
          : "complete",
        currencyStatus,
        issues,
        ...(market === undefined ? {} : { market }),
        ...(qualified === undefined ? {} : { tradingViewSymbol: qualified }),
        ...(currency === undefined ? {} : { currency }),
      });
    });

  gaps.sort((a, b) =>
    a.assetId.localeCompare(b.assetId, "en") ||
    (a.packId ?? "").localeCompare(b.packId ?? "", "en") ||
    issueOrder(a.issue) - issueOrder(b.issue),
  );

  return Object.freeze({
    schemaVersion: 1,
    ok: gaps.length === 0,
    registryAssetCount: assets.length,
    packCount: packs.length,
    packMembershipCount: membershipCount,
    assets: Object.freeze(entries),
    gaps: Object.freeze(gaps),
  });
}

export function packsForAudit(packs: readonly Pack[]): readonly AuditablePack[] {
  return Object.freeze(packs.map((pack) => Object.freeze({ id: pack.id, assets: Object.freeze([...pack.assets]) })));
}

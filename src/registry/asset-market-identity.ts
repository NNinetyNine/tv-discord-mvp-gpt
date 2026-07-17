/**
 * Strict, curator-supplied market identity for a future canonical Asset.
 *
 * This module validates explicit facts only. It never derives a venue or
 * currency from an id, ticker suffix, filename, chart image, or network source.
 */

export const ASSET_MARKET_IDENTITY_MAX_LENGTHS = Object.freeze({
  assetId: 64,
  displayName: 96,
  symbol: 32,
  market: 16,
  tradingViewSymbol: 64,
  currency: 8,
});

export const ASSET_CURRENCY_MIN_LENGTH = 2 as const;
export const ASSET_MARKET_MIN_LENGTH = 2 as const;

const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const SYMBOL_PATTERN = /^[A-Z0-9._!-]+$/u;
const MARKET_PATTERN = /^[A-Z0-9]+$/u;
const CURRENCY_PATTERN = /^[A-Z0-9]{2,8}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface ProposedAssetMarketIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly symbol: string;
  readonly market: string;
  readonly tradingViewSymbol: string;
  readonly currency: string;
}

export type AssetMarketIdentityFailureReason =
  | "invalid_asset_id"
  | "invalid_display_name"
  | "invalid_symbol"
  | "invalid_market"
  | "invalid_tradingview_symbol"
  | "market_symbol_mismatch"
  | "missing_currency"
  | "invalid_currency";

export interface AssetMarketIdentityFailure {
  readonly ok: false;
  readonly reason: AssetMarketIdentityFailureReason;
  readonly detail: string;
}

export interface AssetMarketIdentitySuccess {
  readonly ok: true;
  readonly asset: ProposedAssetMarketIdentity;
}

export type AssetMarketIdentityResult = AssetMarketIdentitySuccess | AssetMarketIdentityFailure;

function failure(reason: AssetMarketIdentityFailureReason, detail: string): AssetMarketIdentityFailure {
  return Object.freeze({ ok: false, reason, detail });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExactString(
  value: unknown,
  field: string,
  maximum: number,
): string | string[] {
  if (typeof value !== "string") return [`${field} must be a string`];
  if (value.length === 0) return [`${field} must not be empty`];
  if (value.trim() !== value) return [`${field} must already be normalized without outer whitespace`];
  if (CONTROL_CHARACTER.test(value)) return [`${field} must not contain control characters or newlines`];
  if (value.length > maximum) return [`${field} exceeds maximum length ${maximum}`];
  return value;
}

export function isQualifiedTradingViewSymbol(value: string): boolean {
  const first = value.indexOf(":");
  return first > 0 && first === value.lastIndexOf(":") && first < value.length - 1;
}

export function validatePublicationCurrency(value: unknown):
  | { readonly ok: true; readonly currency: string }
  | AssetMarketIdentityFailure {
  if (value === undefined || value === null || value === "") {
    return failure("missing_currency", "currency is required");
  }
  if (typeof value !== "string") {
    return failure("invalid_currency", "currency must be a string");
  }
  if (!CURRENCY_PATTERN.test(value)) {
    return failure(
      "invalid_currency",
      `currency must match ^[A-Z0-9]{${ASSET_CURRENCY_MIN_LENGTH},${ASSET_MARKET_IDENTITY_MAX_LENGTHS.currency}}$`,
    );
  }
  return Object.freeze({ ok: true, currency: value });
}

export function validateProposedAssetMarketIdentity(value: unknown): AssetMarketIdentityResult {
  if (!isRecord(value)) {
    return failure("invalid_asset_id", "asset must be a JSON object");
  }
  const allowed = new Set(["id", "displayName", "symbol", "market", "tradingViewSymbol", "currency"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return failure("invalid_asset_id", `asset contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }

  const idValue = validateExactString(value.id, "asset.id", ASSET_MARKET_IDENTITY_MAX_LENGTHS.assetId);
  if (Array.isArray(idValue) || !ASSET_ID_PATTERN.test(idValue)) {
    return failure("invalid_asset_id", Array.isArray(idValue) ? idValue[0] ?? "invalid asset id" : "asset.id must use lowercase ASCII letters, digits, underscore, or hyphen");
  }

  const displayNameValue = validateExactString(value.displayName, "asset.displayName", ASSET_MARKET_IDENTITY_MAX_LENGTHS.displayName);
  if (Array.isArray(displayNameValue)) {
    return failure("invalid_display_name", displayNameValue[0] ?? "invalid display name");
  }

  const symbolValue = validateExactString(value.symbol, "asset.symbol", ASSET_MARKET_IDENTITY_MAX_LENGTHS.symbol);
  if (Array.isArray(symbolValue) || !SYMBOL_PATTERN.test(symbolValue)) {
    return failure("invalid_symbol", Array.isArray(symbolValue) ? symbolValue[0] ?? "invalid symbol" : "asset.symbol must be normalized uppercase ASCII letters, digits, period, underscore, hyphen, or exclamation mark");
  }

  const marketValue = validateExactString(value.market, "asset.market", ASSET_MARKET_IDENTITY_MAX_LENGTHS.market);
  if (
    Array.isArray(marketValue) ||
    marketValue.length < ASSET_MARKET_MIN_LENGTH ||
    !MARKET_PATTERN.test(marketValue)
  ) {
    return failure("invalid_market", Array.isArray(marketValue) ? marketValue[0] ?? "invalid market" : `asset.market must use ${ASSET_MARKET_MIN_LENGTH}-${ASSET_MARKET_IDENTITY_MAX_LENGTHS.market} uppercase ASCII letters or digits`);
  }

  const tradingViewValue = validateExactString(value.tradingViewSymbol, "asset.tradingViewSymbol", ASSET_MARKET_IDENTITY_MAX_LENGTHS.tradingViewSymbol);
  if (Array.isArray(tradingViewValue) || !isQualifiedTradingViewSymbol(tradingViewValue)) {
    return failure("invalid_tradingview_symbol", Array.isArray(tradingViewValue) ? tradingViewValue[0] ?? "invalid TradingView symbol" : "asset.tradingViewSymbol must contain exactly one explicit market prefix and colon separator");
  }
  const [prefix, instrument] = tradingViewValue.split(":");
  if (prefix === undefined || instrument === undefined || !MARKET_PATTERN.test(prefix) || !SYMBOL_PATTERN.test(instrument)) {
    return failure("invalid_tradingview_symbol", "asset.tradingViewSymbol components must be normalized uppercase supported tokens");
  }
  if (prefix !== marketValue) {
    return failure("market_symbol_mismatch", `asset.tradingViewSymbol prefix ${prefix} does not match asset.market ${marketValue}`);
  }
  if (instrument !== symbolValue) {
    return failure("invalid_tradingview_symbol", `asset.tradingViewSymbol instrument ${instrument} does not match asset.symbol ${symbolValue}`);
  }

  const currency = validatePublicationCurrency(value.currency);
  if (!currency.ok) return currency;

  return Object.freeze({
    ok: true,
    asset: Object.freeze({
      id: idValue,
      displayName: displayNameValue,
      symbol: symbolValue,
      market: marketValue,
      tradingViewSymbol: tradingViewValue,
      currency: currency.currency,
    }),
  });
}

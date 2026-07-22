/**
 * PRIVATE to the resolver. Normalize a filename symbol token into the form the
 * registry matches against.
 *
 * This is FORMATTING normalization ONLY — case and surrounding whitespace. These
 * transforms are identity-preserving for every input: they change a symbol's
 * representation but never which asset it denotes.
 *
 * Anything semantic — quote-currency suffixes, futures markers, separator
 * styles, or punctuation differences — is NOT handled here. The Registry owns
 * filename identity: a qualified canonical TradingView value contributes its
 * instrument segment (`CRYPTO:BTCUSD` -> `BTCUSD`), while temporary historical
 * mappings remain explicit `tradingViewAliases`. Both are validated in one
 * collision-checked filename namespace.
 *
 * (The earlier provisional rule that kept only the segment after the last
 * underscore was semantic translation and has been removed: it mis-resolved
 * genuine underscore-bearing symbols such as "NOVO_B" — reducing them to "B" —
 * which is exactly the kind of identity-changing transform that belongs in data,
 * not code.)
 */
export function normalizeSymbol(token: string): string {
  return token.trim().toUpperCase();
}
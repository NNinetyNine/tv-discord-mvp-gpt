/**
 * PRIVATE to the resolver. Normalize a filename symbol token into the form the
 * registry matches against.
 *
 * This is FORMATTING normalization ONLY — case and surrounding whitespace. These
 * transforms are identity-preserving for every input: they change a symbol's
 * representation but never which asset it denotes.
 *
 * Anything semantic — exchange prefixes, quote-currency suffixes, futures
 * markers, separator styles, punctuation differences — is NOT handled here. Such
 * mappings are declared registry DATA (`tradingViewAliases`) and matched by the
 * registry's combined-namespace lookup, not by translating symbols in code. This
 * keeps the resolver a pure lookup and makes every "this export name means that
 * asset" decision an explicit, validated, collision-checked piece of data.
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
/**
 * PRIVATE to the resolver. Extract the leading symbol token from a TradingView
 * snapshot filename, e.g.:
 *   "AAPL_2026-06-25_00-39-37.png"   -> "AAPL"
 *   "BTCUSD_2026-06-25_01-18-55.png" -> "BTCUSD"
 *
 * Strips a trailing `_<YYYY-MM-DD>_<HH-MM-SS>.<ext>` stamp; whatever leads is
 * the symbol token. Returns null if no plausible token remains.
 */
const STAMP = /_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.[A-Za-z0-9]+$/;

export function extractToken(filename: string): string | null {
  if (typeof filename !== "string") return null;
  const trimmed = filename.trim();
  if (trimmed.length === 0) return null;

  let token = trimmed;
  if (STAMP.test(token)) {
    token = token.replace(STAMP, "");
  } else {
    token = token.replace(/\.[A-Za-z0-9]+$/, ""); // drop a trailing extension
    const dateIdx = token.search(/_\d{4}-\d{2}-\d{2}/);
    if (dateIdx > 0) token = token.slice(0, dateIdx);
  }

  token = token.trim();
  return token.length === 0 ? null : token;
}
import type { Registry } from "../registry/registry.ts";
import type { ResolveResult } from "../types.ts";
import { extractToken } from "./internal/extract.ts";
import { normalizeSymbol } from "./internal/normalize.ts";

/**
 * Resolver — the ONLY public API for turning a TradingView snapshot filename
 * into an internal Asset. Extraction and normalization are private internals;
 * no other module imports them. Never throws for normal lookup failures —
 * returns a discriminated ResolveResult and lets the caller decide.
 *
 * Construct with a Registry so the resolver is testable in isolation.
 */
export interface Resolver {
  resolve(filename: string): ResolveResult;
}

export function createResolver(registry: Registry): Resolver {
  return {
    resolve(filename: string): ResolveResult {
      const token = extractToken(filename);
      if (token === null) {
        return { ok: false, reason: "unparseable_filename", filename };
      }

      const symbol = normalizeSymbol(token);
      const asset = registry.lookupByTradingView(symbol);
      if (asset === null) {
        return { ok: false, reason: "unknown_symbol", symbol };
      }

      return { ok: true, asset };
    },
  };
}
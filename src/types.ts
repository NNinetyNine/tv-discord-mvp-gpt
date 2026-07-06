/**
 * Shared types. This file pins the seam between capture, validation, and
 * publishing. Nothing here imports Playwright, Discord, or Sharp — the
 * pipeline depends only on these shapes, so each stage can be swapped
 * independently later (e.g. snapshot -> screenshot -> self-hosted renderer)
 * by changing one implementation file, not the pipeline.
 */
/** One configured ticker -> layout -> destination mapping. */
export interface Ticker {
  /** Display symbol, e.g. "AAPL". */
  readonly symbol: string;
  /** TradingView layout URL to open (used from Day 3). */
  readonly tvLayoutUrl: string;
  /** Destination Discord channel ID (used from Day 2). */
  readonly discordChannelId: string;
  /** Expected capture width in px (validated from Day 5). */
  readonly expectedWidth: number;
  /** Expected capture height in px (validated from Day 5). */
  readonly expectedHeight: number;
}
/** Result of a successful capture: a real image on disk. */
export interface CaptureResult {
  /** Absolute or project-relative path to the captured PNG. */
  readonly imagePath: string;
  /** ISO-8601 timestamp of when the image was captured. */
  readonly capturedAt: string;
  /**
   * TradingView's native download filename,
   * e.g. "AAPL_2026-06-25_00-39-37.png".
   * Preserved verbatim — no parsing/normalization/lookup happens here.
   */
  readonly suggestedFilename: string;
}
/**
 * The swappable capture seam. Day 1 ships a stub that returns a fixture.
 * Day 4 ships snapshot/screenshot implementations of this same interface.
 */
export interface Capturer {
  capture(ticker: Ticker): Promise<CaptureResult>;
}
/**
 * Per-check validation outcomes. Each key is present only if its check ran;
 * `dimensions` is absent when the validator's policy disables the dimension
 * check (expectedDimensions === null). Named optional booleans (rather than
 * Record<string, boolean>) give compile-time protection against key typos and
 * honestly model that a check may not have run.
 */
export interface ValidationChecks {
  exists?: boolean;
  size?: boolean;
  readable?: boolean;
  dimensions?: boolean;
  notBlank?: boolean;
}
/** Outcome of validation. Fail-closed: anything not clearly ok is not ok. */
export interface ValidationResult {
  readonly ok: boolean;
  /** Per-check pass/fail map for observability. */
  readonly checks: Readonly<ValidationChecks>;
  /** Human-readable reason when ok === false. */
  readonly reason?: string;
}
/** The single outcome recorded per ticker per run. */
export type Outcome =
  | "published"
  | "skipped_validation"
  | "error_capture"
  | "error_publish";
/** Function shape for the validation stage (swappable like Capturer). */
export type Validator = (
  imagePath: string,
  ticker: Ticker,
) => ValidationResult | Promise<ValidationResult>;
/** Function shape for the publish stage (swappable like Capturer). */
export type Publisher = (
  imagePath: string,
  channelId: string,
) => Promise<void>;
/**
 * Internal asset — the currency the app uses downstream of the resolver.
 * Keyed in config by stable internal `id`; `tradingView` is what filenames
 * resolve against. Added in Phase 1B; nothing in the running pipeline
 * consumes these yet.
 */
export interface Asset {
  /** Stable internal identifier, e.g. "aapl". */
  readonly id: string;
  /** Canonical TradingView filename token used for resolution, e.g. "AAPL". */
  readonly tradingView: string;
  /**
   * Alternate TradingView symbols that also denote this asset (e.g. "BTCUSD"
   * for canonical "BTC"). Mechanism-independent — these are TradingView's names
   * for the asset, whether carried by a filename export or a future browser/CDP
   * source. Optional; assets with no alternates omit it. buildRegistry validates
   * the combined {tradingView} ∪ tradingViewAliases namespace for collisions.
   */
  readonly tradingViewAliases?: readonly string[];
  /** Human-readable display name. */
  readonly display: string;
  /** Logical destination channel, e.g. "stocks". */
  readonly channel: string;
}
/** Outcome of resolving a TradingView snapshot filename to an Asset. */
export type ResolveResult =
  | {
      readonly ok: true;
      readonly asset: Asset;
    }
  | {
      readonly ok: false;
      readonly reason: "unknown_symbol";
      readonly symbol: string;
    }
  | {
      readonly ok: false;
      readonly reason: "unparseable_filename";
      readonly filename: string;
    };
# VisionX Config — Asset Registry & Channels

This directory holds the production data that will drive asset resolution and
Discord routing. **It is data only.** No TypeScript reads these files yet, so
the running application is unchanged until the Registry/Resolver code is added
in a later phase.

## registry.json

The asset registry, keyed by a stable internal `id` (e.g. `btc`). Internal IDs
are intended to stay stable even if a TradingView symbol changes later. Each
entry has:

- `tradingView` — the symbol as extracted from our Discord cashtags
- `display` — human-readable name
- `channel` — the single grouping/routing field (see channels.json)

`channel` is used both to group assets (crypto, stocks, indices, commodities,
etfs) and to route them to Discord. Entries are grouped by channel for easier
review.

## channels.json

Maps each channel name to its Discord channel ID. IDs are intentionally left
empty (`""`) for now and will be filled in a later phase.

## Not yet reconciled

The `tradingView` values are the symbols **exactly as extracted from Discord**.
They have NOT been reconciled against the real filenames TradingView produces
when a chart snapshot is downloaded, and may differ — for example a Discord
`BTC` cashtag may download as `BTCUSD`, and symbols containing `_`, `.`, or `!`
(e.g. `NOVO_B`, `BRK.B`, `HG1!`) may be sanitized differently. Filename
reconciliation is a **later phase**; until then, treat `tradingView` as
provisional.

## Known exclusions

Three items from the source screenshots are intentionally **excluded** to keep
the data valid, pending a decision:

- `DAX` — appears in both Indices and ETFs (same symbol, two groups)
- `XLK` — appears twice in ETFs with different names
- `TOTAL3` — shown without a normal ticker

These are not in registry.json and were not silently assigned to one group.
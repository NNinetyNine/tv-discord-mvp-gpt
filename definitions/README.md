# VisionX Definitions — The Operator's Universe

This directory is the permanent home of the domain-definition files
(Constitution §2.2.1, §8.8 ruling): `registry.json` and `packs.json` —
operator-owned, long-lived, editable data, recovered via version control.
It is data only. Installation configuration (including `channels.json`)
lives in `config/`.

## registry.json

The asset registry, keyed by a stable internal `id` (e.g. `btc`). Internal IDs
are intended to stay stable even if a TradingView symbol changes later. Each
entry has:

- `tradingView` — the symbol as extracted from our Discord cashtags
- `display` — human-readable name
- `channel` — the single grouping field (see `config/channels.json`)

Entries are grouped by channel for easier review.

## packs.json

The ordered pack definitions (array order is the publishing/workflow order).

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
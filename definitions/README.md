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

- `tradingView` — the canonical TradingView identity, preferably qualified as `MARKET:INSTRUMENT`
- `display` — human-readable name
- `currency` — optional canonical chart currency. Historical Assets may omit it; every Asset created through the task-oriented Pack builder must provide it explicitly. Currency is never inferred or defaulted.
- `channel` — the single grouping field (see `config/channels.json`)

Entries are grouped by channel for easier review. New entries are appended without reserializing historical entries. When present, the deterministic field order is `tradingView`, `tradingViewAliases`, `display`, `currency`, `channel`.

## packs.json

The ordered pack definitions (array order is the publishing/workflow order).

## Reconciliation state

Qualified canonical identities resolve downloaded filenames through their
instrument segment (`CRYPTO:BTCUSD` resolves `BTCUSD_...png`). The Registry
rejects duplicate instrument tokens so two markets cannot silently claim the
same export filename. Historical `tradingViewAliases` remain temporary
compatibility data for Assets that have not yet been reconciled; new workflows
should supply the exact qualified TradingView ticker instead of creating aliases.

## Known exclusions

Three items from the source screenshots are intentionally **excluded** to keep
the data valid, pending a decision:

- `DAX` — appears in both Indices and ETFs (same symbol, two groups)
- `XLK` — appears twice in ETFs with different names
- `TOTAL3` — shown without a normal ticker

These are not in registry.json and were not silently assigned to one group.
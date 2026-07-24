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

Entries are grouped by channel for easier review. New entries are appended without reserializing historical entries. The operator-facing field order is `tradingView`, `display`, `currency`, `channel`. Legacy `tradingViewAliases` may remain in historical source only while internal compatibility dependencies are audited; routine Administration cannot add them.

## packs.json

The ordered pack definitions (array order is the publishing/workflow order).

## Reconciliation state

Qualified canonical identities resolve downloaded filenames through their
instrument segment (`CRYPTO:BTCUSD` resolves `BTCUSD_...png`). The Registry
rejects duplicate instrument tokens so two markets cannot silently claim the
same export filename. Historical `tradingViewAliases` remain internal compatibility data only where older
sources still require them. Operator workflows, search guidance, and CSV import use
the exact qualified TradingView identity and do not create aliases.
The Crypto Pack was fully reconciled in Step 528; its qualified identities,
currencies, filename tokens, and alias dispositions are recorded in
`docs/CRYPTO_PACK_RECONCILIATION.md`.

## Reconciled source ambiguities

Historical duplicate source rows are represented once: `DAX` is assigned to
Indices and `XLK` is assigned to ETFs. `TOTAL3` is included in Crypto with the
qualified `CRYPTOCAP:TOTAL3` identity. No duplicate row is silently retained.

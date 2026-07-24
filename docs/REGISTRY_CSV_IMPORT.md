# Governed Registry CSV Import

Status: Step 545 canonical-identity contract.

The Registry CSV importer is an additions-only, review-before-write workflow. It
exists for controlled bulk registration; it is not a shortcut around canonical
validation and it does not update existing Assets.

## CSV contract

The file must be UTF-8 CSV and may contain at most 1,000 Asset rows. Required
headers are:

```text
id,display_name,tradingview_symbol,currency,channel
```

The only optional header is:

```text
pack_ids
```

`tradingview_symbol` must be one qualified `MARKET:SYMBOL` identity. Alias
columns are not accepted and are never silently imported. Pack IDs use `|` as
the list separator. The current Workspace model requires global Pack
disjointness, so an imported Asset may name no Pack or one Pack.

Example:

```csv
id,display_name,tradingview_symbol,currency,channel,pack_ids
aapl,Apple Inc.,NASDAQ:AAPL,USD,stocks,stocks
```

## Review and validation

Selecting a file does not change source. **Review CSV** parses the complete file
and reports all detected blockers, including:

- missing, unknown, blank, or duplicate headers and column-count errors;
- missing required values and malformed stable IDs;
- duplicate IDs or display names in the file or current Registry;
- unqualified TradingView identities and canonical filename-token collisions;
- invalid currency or unknown channel values;
- unknown or duplicate Pack references; and
- candidate Registry or Pack definitions rejected by the canonical loaders.

The Apply control remains disabled while any issue exists. Invalid files remain
reviewable and never create a partial import.

## Atomic application

A valid preview is bound to the exact Registry, Packs, and channel source hashes.
Application requires the explicit phrase `APPLY REGISTRY CSV IMPORT`.

The Registry and Packs candidates are validated again, written to same-directory
temporary files, and replaced as one rollback-protected source transaction.
Administration serializes this transaction with governed Asset registration,
Asset retirement, Pack creation, and Pack promotion. A source change after review
invalidates the preview.

CSV import does not create logos, capture charts, render, stage, publish, create a
Release, modify thread bindings, or contact Discord.

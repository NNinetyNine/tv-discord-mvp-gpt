# Governed Registry CSV Import

Status: Step 538 administration workflow.

The Registry CSV importer is an additions-only, review-before-write workflow. It
exists for initial ticker onboarding and controlled bulk registration; it is not
a shortcut around canonical validation and it does not update existing Assets.

## CSV contract

The file must be UTF-8 CSV and may contain at most 1,000 Asset rows. Required
headers are:

```text
id,display_name,tradingview_symbol,currency,channel
```

Optional headers are:

```text
aliases,pack_ids
```

Aliases and Pack IDs use `|` as the list separator. The current Workspace model
requires global Pack disjointness, so an imported Asset may name no Pack or one
Pack. A future architecture change must migrate that invariant before the CSV
contract can safely permit multiple Pack memberships.

Example:

```csv
id,display_name,tradingview_symbol,currency,channel,aliases,pack_ids
aapl,Apple Inc.,NASDAQ:AAPL,USD,stocks,APPLE|APPLE_INC,stocks
```

## Review and validation

Selecting a file does not change source. **Review CSV** parses the complete file
and reports all detected blockers, including:

- missing or unknown headers and column-count errors;
- missing required values and malformed stable IDs;
- duplicate IDs or display names in the file or current Registry;
- canonical TradingView and filename-token collisions;
- invalid currency or unknown channel values;
- duplicate aliases;
- unknown or duplicate Pack references; and
- candidate Registry or Pack definitions rejected by the canonical loaders.

The Apply control remains disabled while any issue exists. Invalid files remain
reviewable in the UI and never create a partial import.

## Atomic application

A valid preview is bound to the exact Registry, Packs, and channel source hashes.
Application requires the explicit phrase `APPLY REGISTRY CSV IMPORT`.

The Registry and Packs candidates are validated again, written to same-directory
temporary files, and replaced as one rollback-protected source transaction.
Administration serializes this transaction with governed Asset registration,
Asset retirement, Pack creation, and Pack promotion so two local source writers
cannot overwrite each other. If replacement or post-write validation fails, the
prior canonical files are restored and verified. A source change after review
invalidates the preview.

CSV import does not create logos, capture charts, render, stage, publish, create a
Release, modify thread bindings, or contact Discord.

## Pack filters

Registry Pack pills use canonical Pack membership, combine with text search, and
return to all Assets through the **All Assets** pill. They are a discovery filter;
they do not change membership.

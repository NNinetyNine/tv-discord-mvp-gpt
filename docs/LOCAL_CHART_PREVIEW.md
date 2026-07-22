# Local chart-publication preview

`npm run preview-chart` is a non-publishing command. It renders one local
VisionX chart-publication PNG and receipt without staging, releasing, opening a
browser, contacting Discord, or using the network.

The command does not accept caller-authored publication metadata. Instead it:

- resolves the Asset from the TradingView export filename;
- verifies that the selected Asset matches the filename;
- reads display, qualified TradingView identity, market, symbol, and currency
  from the canonical Registry;
- derives `dataAsOf` from the strict TradingView filename timestamp;
- uses the canonical market as the visible `SOURCE` value; and
- records TradingView as chart attribution in the receipt.

The input basename must use `SYMBOL_YYYY-MM-DD_HH-MM-SS.png`. Output and receipt
paths are no-overwrite destinations.

## Standalone rendering

Standalone rendering requires only a Registry Asset. Pack membership is not
consulted, so an Asset may be rendered before it is assigned to a Pack. The
operator supplies one validated timeframe directly; no per-ticker or
per-timeframe profile file is required.

```bash
npm run preview-chart -- \
  --context standalone \
  --asset btc \
  --timeframe 1H \
  --input "$HOME/Downloads/BTCUSD_2026-07-22_18-58-01.png" \
  --output "$HOME/Downloads/btc.preview.png" \
  --receipt "$HOME/Downloads/btc.preview.receipt.json"
```

Standalone output remains local. It does not change Pack workspace state,
create a Release, look up a Discord thread, or publish anything.

## Pack rendering

Pack rendering proves that the selected Asset belongs to the selected Pack and
then derives the timeframe from Pack policy:

- ordinary Packs default to `1D`;
- the `etfs` Pack defaults to `4D`.

The caller cannot override the Pack timeframe through this command. The result
includes its Pack context so a later milestone can admit an accepted render to
Pack staging without changing the deterministic render contract.

### Pack capture and staging

The application composition root exposes `capturePackChartFromFile(...)` as
the canonical Pack artifact path. It prepares the Pack-context render, validates
the rendered PNG, copies that PNG (never the raw TradingView export) into the
asset-keyed staging slot used by `publishPack()`, and only then records the
Workspace capture/revision. The raw export and the no-overwrite rendered PNG and
receipt remain intact. Standalone renders do not call this service and therefore
cannot change staging, Workspace state, Releases, thread bindings, or Discord.

```bash
npm run preview-chart -- \
  --context pack \
  --pack crypto \
  --asset btc \
  --input "$HOME/Downloads/BTCUSD_2026-07-22_18-58-01.png" \
  --output "$HOME/Downloads/btc.pack-preview.png" \
  --receipt "$HOME/Downloads/btc.pack-preview.receipt.json"
```

The low-level `render-chart-publication.ts` command remains available for tests
that already possess complete metadata, but it should not be used as the
operator-facing Registry-backed workflow.

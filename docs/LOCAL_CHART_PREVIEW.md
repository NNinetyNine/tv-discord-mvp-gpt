# Local chart-publication preview

`npm run preview-chart` is a non-publishing developer command. It renders one
local VisionX chart-publication PNG and receipt without staging, releasing,
opening a browser, contacting Discord, or using the network.

The command does not accept caller-authored publication metadata. Instead it:

- resolves the Asset from the TradingView export filename;
- reads display, qualified TradingView identity, market, symbol, and currency
  from the canonical Registry;
- derives `dataAsOf` from the strict TradingView filename timestamp;
- uses the canonical market as the visible `SOURCE` value;
- records TradingView as chart attribution in the receipt; and
- requires a strict Asset/timeframe profile, failing when timeframe evidence is
  absent, unsupported, or belongs to a different Asset.

A profile is deliberately small and strict:

```json
{
  "schemaVersion": 1,
  "assetId": "btc",
  "timeframe": "1H"
}
```

Example:

```bash
npm run preview-chart -- \
  --input "$HOME/Downloads/BTCUSD_2026-07-22_18-58-01.png" \
  --profile "$HOME/Downloads/btc-1h.preview-profile.json" \
  --output "$HOME/Downloads/btc.preview.png" \
  --receipt "$HOME/Downloads/btc.preview.receipt.json"
```

The input basename must use `SYMBOL_YYYY-MM-DD_HH-MM-SS.png`. Output and receipt
paths are no-overwrite destinations. The low-level
`render-chart-publication.ts` command remains available for tests that already
possess complete metadata, but it should not be used as the operator-facing
Registry-backed preview workflow.

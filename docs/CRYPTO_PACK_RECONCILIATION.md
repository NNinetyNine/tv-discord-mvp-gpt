# Crypto Pack identity reconciliation

Step 528 reconciles every Crypto Pack member against one explicit canonical
TradingView identity and one curator-approved publication currency. The
operator approved this complete map on 2026-07-22. Currency values are recorded
decisions; VisionX does not infer them from symbol suffixes, filenames, chart
pixels, or network names.

The Pack policy timeframe remains `1D`. Timeframe is independent of market
identity and currency, and standalone rendering may still use any validated
renderer-supported timeframe.

| Asset | Canonical TradingView identity | Currency | Export filename token | Legacy alias disposition |
|---|---|---|---|---|
| `akt` | `CRYPTO:AKTUSD` | `USD` | `AKTUSD` | `AKTUSD` removed as redundant |
| `zec` | `CRYPTO:ZECUSD` | `USD` | `ZECUSD` | `ZECUSD` removed as redundant |
| `pepe` | `CRYPTO:PEPEUSD` | `USD` | `PEPEUSD` | `PEPEUSD` removed as redundant |
| `doge` | `CRYPTO:DOGEUSD` | `USD` | `DOGEUSD` | `DOGEUSD` removed as redundant |
| `fet` | `CRYPTO:FETUSD` | `USD` | `FETUSD` | `FETUSD` removed as redundant |
| `xlm` | `CRYPTO:XLMUSD` | `USD` | `XLMUSD` | `XLMUSD` removed as redundant |
| `xrp` | `CRYPTO:XRPUSD` | `USD` | `XRPUSD` | `XRPUSD` removed as redundant |
| `sui` | `CRYPTO:SUIUSD` | `USD` | `SUIUSD` | `SUIUSD` removed as redundant |
| `tao` | `BITGET:TAOUSDT` | `USDT` | `TAOUSDT` | `TAOUSDT` removed as redundant |
| `trx` | `CRYPTO:TRXUSD` | `USD` | `TRXUSD` | `TRXUSD` removed as redundant |
| `link` | `CRYPTO:LINKUSD` | `USD` | `LINKUSD` | `LINKUSD` removed as redundant |
| `sol` | `CRYPTO:SOLUSD` | `USD` | `SOLUSD` | `SOLUSD` removed as redundant |
| `hype` | `CRYPTO:HYPEHUSD` | `USD` | `HYPEHUSD` | `HYPEHUSD` removed as redundant |
| `eth` | `CRYPTO:ETHUSD` | `USD` | `ETHUSD` | `ETHUSD` removed as redundant |
| `btc` | `CRYPTO:BTCUSD` | `USD` | `BTCUSD` | Already reconciled; no alias |
| `total3` | `CRYPTOCAP:TOTAL3` | `USD` | `TOTAL3` | No historical alias |

Qualified identities contribute their instrument segment to the filename
namespace, so each removed alias would have duplicated the exact filename token
already supplied by the new canonical identity. Registry loading validates the
entire canonical and filename namespaces and fails on any collision.

TradingView evidence for the exceptional provider identities:

- `BITGET:TAOUSDT`: <https://www.tradingview.com/symbols/TAOUSDT/>
- `CRYPTO:HYPEHUSD`: <https://www.tradingview.com/symbols/HYPEHUSD/technicals/>
- `CRYPTOCAP:TOTAL3`: <https://www.tradingview.com/support/solutions/43000550480-where-do-i-find-crypto-market-capitalization-and-dominance/>

The remaining non-Crypto Assets retain their prior audit state and require
separate Pack-by-Pack curator decisions.

# TradingView indicators

## QE Ultra 7.1 (`qe-ultra.pine`)

Quarterly / yearly earnings table, NSE-style price bands, earnings markers, and SMAs — matching the QE Ultra Inputs surface.

### Install on TradingView

1. Open any chart → **Pine Editor**
2. New blank indicator → paste contents of `qe-ultra.pine`
3. **Save** → **Add to chart**
4. Gear icon → **Inputs** to toggle tables, FQ/FY, columns, circuit %, colors, SMAs

### What it shows

| Feature | Source |
| --- | --- |
| EPS / PAT, Sales (₹ Cr), OPM%, YoY, QoQ, P/E | `request.financial` (FQ or FY) |
| Header ROE | FY `RETURN_ON_EQUITY` |
| Upper / lower circuit | Previous daily close ± **Circuit %** input |
| Earnings markers | When EPS/PAT series changes |
| SMAs | 5 / 10 / 20 / 40 / 50 / 100 / 200 |

### Notes

- Fundamentals coverage varies by symbol (NSE names are uneven on TradingView).
- Set **Circuit %** to the stock’s actual band (2 / 5 / 10 / 20).
- Raise **Number of rows** (e.g. 8–16) for a denser history; YoY still uses hidden history when fewer rows are shown.
- Estimation table is best-effort — TV rarely has rich analyst estimates for NSE.

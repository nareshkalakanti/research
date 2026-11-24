# TechnoFunda Price Action Screen: research notes

Saved 2026-11-24. Worked out from screenshots of ridewinners.com and an old
Excel export. The site's official formulas could not be accessed, so anything
marked "inferred" may be wrong or out of date.

## What the product does

- **Latest:** stocks passing the screen on the selected day.
- **2WK / Trend:** a grid showing which days each stock passed.
- **Market Pulse:** rolls the daily passes up by sector.
- **Business Rank (`/rank`):** a separate feature from the price screen.
- **Optional filters, not the pass rule:** Sector, ADX 14, RSI 14, Weighted RPI,
  Market Cap, Community Rank, Stage.

Screen description on the site: "Finding next price volume action using
price-volume spurts across stocks and sectors".

## Column formulas (confirmed from the Excel export)

```
% change  = Latest price / Past price - 1
            ASTEC 1M: 1125.95 / 1005.2 - 1 = 12.01%
5D volume = 5-day average
2W volume = 10-day average
2 weeks   = 10 trading days
```

The newer 2WK view (13 Jul to 27 Jul) shows 11 dots, and Trending Days reaches
11. It counts both end dates, so it covers 11 trading days. The dots run oldest
on the left to newest on the right.

## Daily screen rules (inferred)

From 28 stocks on one day, so thresholds are approximate.

| Screen | Likely rule | Evidence |
|---|---|---|
| S1 | Passes both S3 and S4 | Exactly AURIONPRO, DCW, CHEMBOND |
| S2 | 1-month return >= 10%, plus an unknown condition | All 23 S2 stocks pass. NRB, ORIENTCEM, TARMAT, DCW, CHEMBOND are above 10% without S2 |
| S3 | Day up >= ~4.7%, volume >= ~2x 5-day average, 3-month return >= ~19% | Fits all 6 S3 stocks, and no other visible stock meets all three |
| S4 | Day up >= ~8% | Lowest S4 is 8.18%, highest non-S4 is 7.91% |

```
Green day     = S1 OR S2 OR S3 OR S4
Trending Days = green days in the last 10 trading days
Current streak = consecutive green days ending on the latest day
```

S2 probably creates most long green streaks, because a 1-month return can stay
above 10% for many days. S3 and S4 catch fresh breakouts.

Worked example, NRB Bearing (S3 only):

```
Day     +7.91%                          passes S3, just misses S4
Volume  2,710,802 / 1,356,950 = 2.0x    passes
3M      +32.93%                         passes
```

## Market Pulse

```
Pulse = green stock-days / (companies x trading days) x 100
```

Financials MFI, 1 week: 5 + 2 + 1 + 1 + 1 = 10 green days out of 5 x 5 = 25,
which is **40 Pulse**. This matches the site.

"Companies" may count only stocks that appeared that week. For our own version,
divide by all stocks in the sector and require a minimum sector size.

## RPI

```
RPI(N) = (Stock today / Stock N days ago)
         / (Index today / Index N days ago) x 100
```

This is the likely definition, not confirmed. Weighted RPI blends several
periods, including something longer than 3 months.

Findings from another research pass (2026-11-24). Not independently checked:

- **Benchmark:** Nifty 50. The export has a "Nifty50 Close" column.
- **Periods:** RPI for 2 weeks, 3 months, 6 months and 1 year.
- **Extra column:** "2Wk SMA of 6M RPI", a 2-week simple moving average of the
  6-month RPI. It may be a separate signal, not an input to Weighted RPI.
- **Weights:** unknown. Any weights we pick would be made up, so we shouldn't
  call it their Weighted RPI.
- ANDHRSUGAR (W.RPI 106.93, above its 2W 102.32 and 3M 86.80) fits this: the 6M
  and/or 1Y RPI must be higher.
- To find the weights: take one day of an export with all four RPIs and the
  Weighted RPI for 10+ stocks, then solve for weights that reproduce it.

**Weighted RPI above 100 is not the green-day rule.** On 20 Apr 2023, Marksans
(125.60), Cadila (114.33), Dr Reddy's (108.88) and Syngene (104.28) were above
100 but not green, assuming the RPI shown is for that date.

## Rockets (inferred)

- **52wk High:** probably a recent new price high, not "near the high".
  SMLISUZU had it 5.7% below its high, Tata Motors did not at 3.6% below.
- **52wk High W.RPI:** meaning unclear. Shardacrop had it 41% below its price
  high with RPI under 100, so it may mean relative strength is improving.

## Reading the trend

- Date order varies: the 2020 sheet has the oldest day on the left, the 2023
  view has the newest on the left. Confirm the July view by hovering over a dot.
- Same Trending Days can mean different things. On 20 Apr 2023, Aurobindo and
  Cadila both had 6, but Aurobindo's current streak was 6 and Cadila's was 0.

## Still unknown

- S2's missing condition
- Exact thresholds and whether they have changed since the 2020 export
- Weighted RPI weights (benchmark and periods now likely known, see RPI)
- What Stage means and whether it affects the screen

## Public sources (checked 2026-11-24)

The screen's author (Vivek Mashrani) calls the exact rules proprietary. Public
pages give the method, not the thresholds.

- [Screening strategies using price-volume action](https://vivekmashrani.com/screening-strategies-using-price-volume-action/):
  example rule "today's price up > 4% vs the average of the last few
  days/weeks, and the same for volume". Data comes from the NSE/BSE bhavcopy:
  close, volume and number of trades, averaged weekly or monthly. Stocks are
  mapped to sector, sub-sector and 52-week high. Named screen types: breakout
  from a long consolidation, breakout to new highs, volume shakeout, and
  sector trend.
- [ValuePickr thread](https://forum.valuepickr.com/t/price-volume-action-for-screening-and-early-warning-indication-strategy/37256),
  Jun 2020:
  - A reader guessed "price > 4% and volume > 3x the weekly or monthly
    average". The author replied that it was "similar, but there is more to
    it".
  - The first level uses no indicators. ADX, RSI, moving averages, Parabolic
    SAR, Donchian channels and volume profile are used later, for ranking.
  - A 0/1 flag marks a recurring trend, meaning the stock passes on many days
    rather than one or two. This matches Trending Days.
  - The pipeline: price-volume early warning, then a technical filter, then
    fundamentals, then position sizing and exits.
  - Filters by market cap (small, mid or large, using the mutual-fund
    definitions).
  - Another member's version: turnover = price x volume, ranked by 1-week
    turnover as a % of 12-month turnover.
- [Sector analysis formula](https://vivekmashrani.com/sector-analysis-formula-3-secrets-you-must-know/)
  and [Bamboo Investing](https://vivekmashrani.com/bamboo-investing-rise-of-phoenix-in-stock-markets/):
  general ideas only, no rules.
- No public source defines S1–S4, Market Pulse, RPI or Stage. Not yet watched:
  the [process video](https://youtu.be/umkUDnHjXM4).

## Built in our app (2026-11-24)

- **Price Action** tab, next to Trend: Latest, 2WK (11 trading days) and Custom
  dates (up to 66 trading days, quick ranges 1W–3M).
- Rules are in `PA_RULES` in `src/lib/price-action-rules.ts`. Values: S4 day ≥ 8%;
  S3 day ≥ 4.7%, volume ≥ 1.95x the previous 5-day average (NRB passed at
  1.998x), 3M ≥ 19%; S2 1M ≥ 10% only; S1 = S3 and S4.
- Our own choices where the source is silent: the 5-day average excludes the
  day itself; 1M/3M are calendar months back to the last close on or before;
  the trading calendar comes from Nifty 500.
- Daily volume is now stored in the rotation price cache (12 bytes per bar).
  Older series refetch once to pick it up.
- Market cap class: top 100 by market cap = Large, 101–250 = Mid, the rest =
  Small.
- Rockets (`PA_ROCKETS`): 52wk High = a 52-week closing high in the last 10
  trading days. W.RPI = Weighted RPI vs Nifty 50 (2W, 3M, 6M, 1Y in trading
  days, **equal weights as a placeholder**) at a 52-week high in the last 10
  trading days.
- Yahoo sometimes leaves the latest close blank; the cache fills it from Yahoo's
  meta price, and series missing the newest session retry every 30 min.
- Not built: Market Pulse, Community Rank.
- Backtest before relying on it.
- The RS High badge with a Circuit warning was considered and **dropped** on
  2026-11-23.

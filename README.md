# Research

Next.js app for India equities research — **Watching** company browser and **Theme Scanner**.

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Demo login:** any email · password `demo`

## Data

| File | Purpose |
|------|---------|
| `data/themes.json` | Source theme patterns (Lotusdew 2026 playbook) |
| `data/theme_keywords.json` | Normalized themes (`id`, `name`, `blog_theme`, `display_pattern`, `keywords`) |
| `data/company_about.db` | Company about / website / Yahoo sector text |
| `data/classifications.db` | NSE sector / sub-sector taxonomy (from stocks-ai listings) |
| `data/governance.db` | Governance enrichment (sparse sector fallback) |
| `data/metrics.db` | Runtime cache of Yahoo price / mcap (created by **Fill missing from web**) |

## Theme Scanner

- Multiselect themes, **grouped by `blog_theme`**
- Custom keywords: pipe-separated OR (`acsr \| copper`), `+` for AND within a clause
- Matches against company about / products / sector text
- **Matched keywords are highlighted** in About previews and the expanded About panel
- Row links: **Web** · **SC** (Screener) · **TV** (TradingView)

## Metrics (price / mcap)

Solid pipeline:

1. **Seed** from sibling `stocks-ai/data/stocks_ai.db` (local)
2. **Yahoo** `.NS` → `.BO` + quoteSummary for leftovers
3. Cache in `data/metrics.db`

```bash
npm run fill-metrics
# or with a CSV of tickers:
npx tsx scripts/fill-metrics.ts ~/Downloads/missing-metrics-NSE-2026-08-06.csv
```

On **Missing data**: Download CSV · Fill page · Fill all missing.

Coverage after seed: ~2958/2959 names (VISDEM SME has no Yahoo listing yet).

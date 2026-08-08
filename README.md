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

All `data/*.db` files are **committed** (SQLite `-wal`/`-shm` sidecars are gitignored). After `git clone` + `npm install` + `npm run dev` you should not need to scrape or download data for a first run.

| File | Purpose |
|------|---------|
| `data/themes.json` | Source theme patterns |
| `data/theme_keywords.json` | Normalized themes (`id`, `name`, `blog_theme`, `display_pattern`, `keywords`) |
| `data/company_about.db` | Company about / website / sector text |
| `data/classifications.db` | NSE sector / sub-sector taxonomy |
| `data/governance.db` | Board seats / directors (Governance map) |
| `data/metrics.db` | Yahoo price / mcap cache |
| `data/signals.db` | BB / TQ weekly breakout signals |

Optional refresh on a machine:

```bash
npm run fill-metrics
```

On **Missing data**: Download CSV · Fill page · Fill all missing.

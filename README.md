# Research

India equities research app (themes, BB/TQ scan, governance map).

## Setup

```bash
git clone https://github.com/nareshkalakanti/research.git
cd research
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

All research data lives in `data/` and is committed (SQLite DBs, themes, notes, screenshots). Clone on a new machine and you keep holdings, governance, superstars, notes, and paper trades — no scrape required.

**Demo login:** any email · password `demo`

## SQLite health

Corrupt DBs (common after copying mid-write or cloud sync) auto-recover on open: drop bad WAL, then `sqlite3 .recover` if needed.

```bash
npm run db:verify      # check all data/*.db
npm run db:fix-all    # repair any corrupt files
npm run db:prepare-sync  # checkpoint WAL before copying the repo
```

`npm run dev` runs `db:prepare-dev` first (auto-fix). Keep `data/` out of iCloud/Dropbox.

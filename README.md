# Research

India equities research app (Next.js). Runs locally at [http://localhost:3000](http://localhost:3000) — **demo login:** any email, password `demo`.

Code lives in git. **Databases (`data/*.db`) do not** — they are backed up to Cloudflare R2 and restored from there.

## Set up a new machine

You need Node, `git`, `curl` and `sqlite3` (macOS has the last two). [Ollama](https://ollama.com) is optional, for the LLM features.

1. **Clone and install**

   ```bash
   git clone https://github.com/nareshkalakanti/research.git
   cd research
   npm install
   ```

2. **Create `.env.local`** — copy it from your other machine (AirDrop / password manager, never git), or start from the template and fill in the secrets:

   ```bash
   cp .env.example .env.local
   ```

3. **Name this machine** (skip only on your *main* machine). Add to `.env.local`:

   ```bash
   R2_MACHINE=laptop        # any short name, unique per machine
   ```

   Without it, this machine's backups overwrite the main machine's. See [More than one machine](#more-than-one-machine).

4. **Get the databases from R2**

   ```bash
   npm run db:restore
   ```

   A machine with no backups of its own yet pulls the main machine's.

5. **Run**

   ```bash
   npm run dev:bg      # app in the background + hourly DB backup (recommended)
   # or: npm run dev   # foreground, no automatic backup
   ```

6. Optional, for LLM features: `ollama pull qwen2.5:3b-instruct` and `ollama pull glm-ocr`.

## What to do for data on a new machine

`git pull` / `git clone` bring **code only**. Live research state is in `data/*.db` (gitignored) and moves through **Cloudflare R2**.

| Do this | Why |
|---|---|
| Copy `.env.local` (with R2 keys) | Without it, `db:restore` / backup cannot run |
| Set `R2_MACHINE=<short-name>` if this is not the main machine | Stops this laptop from overwriting the main machine’s backups |
| `npm run dev:stop` then `npm run db:restore` | Pulls every DB from the newest R2 backup (or the main machine’s if this one has none yet) |
| `npm run dev:bg` | App + hourly backup so this machine starts writing its own snapshots |
| On the *source* machine first: `npm run db:backup` (or leave `dev:bg` running) | Restore only sees what was already uploaded |

**After restore you should have** (among others) the DBs tabs need:

- `metrics.db` — market caps, prices helpers, Tickertape ratios / div-yield cache  
- `classifications.db` — sector / industry / sub_sector fallback  
- `governance.db` — board seats, company network / Board column links  
- `rotation_bars.db` (or whatever feeds 12M returns) — Micro Monopolies pocket returns  
- `company_about.db` — hydrated from `data/seeds/company_about.db` in git if missing  

**Do not** copy `*.db-wal` / `*.db-shm` between machines. Prefer R2 restore over AirDrop of live DB files.

To pull only some files from another named machine (after that machine has backed up):

```bash
npm run dev:stop
FROM=<other-machine> npm run db:restore -- metrics.db governance.db classifications.db
npm run dev:bg
```

Use `FROM=main` for the main machine. Leave out the DB names to restore everything.

## `.env.local`

[`.env.example`](.env.example) is the template and lists every setting with comments. Never commit `.env.local`.

| Setting | Needed for |
|---|---|
| `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `R2_ENDPOINT` | Database backup / restore (required) |
| `R2_MACHINE` | Every machine except the main one |
| `R2_BUCKET` | Only if not `research-db-backup` |
| `LLM_PROVIDER`, `LLM_MODEL*`, `QIANFAN_OCR_*` | Concall / OCR / Napkin LLM features (default: local Ollama) |
| `SCREENER_SESSIONID` | Fund watchlists from Screener people pages (your logged-in Screener cookie) |
| `FIRECRAWL_API_KEY` | Optional: scanned PDF/DOCX parsing |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Optional: cloud LLMs (`LLM_PROVIDER=openai\|anthropic`) |

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev:bg` | Start the app in the background + hourly backup (`logs/dev.log`, `logs/db-backup.log`) |
| `npm run dev:stop` | Stop both |
| `npm run dev:restart` | Stop, clear `.next`, start again |
| `npm run dev:logs` | Follow the app log |
| `git pull` | Get the latest code (databases are untouched) |

## Databases

Backups use SQLite's online backup (safe while the app runs), must pass `quick_check` before upload, and are gzipped (~40 MB total). Only changed databases are uploaded, within Cloudflare's free tier.

| Command | What it does |
|---|---|
| `npm run db:backup` | Back up now |
| `npm run db:restore` | Restore every DB from the newest backup — **stop the app first** (`npm run dev:stop`) |
| `npm run db:restore -- governance.db` | Restore one DB |
| `DAY=2026-11-19 npm run db:restore` | Restore from a daily backup (14 days kept) |

A restore first moves the current files to `data/.pre-restore/<time>/`, so it can be undone. If a database is found corrupt at startup, `npm run db:fix` (and the app's `metrics.db` recovery) pull the newest backup automatically.

`data/seeds/company_about.db` is the one database kept in git; `npm run dev` copies it to `data/company_about.db` when missing.

### More than one machine

R2 keeps one folder per machine:

| Machine | `.env.local` | Backs up to | `db:restore` reads |
|---|---|---|---|
| Main | no `R2_MACHINE` | `latest/`, `daily/` | its own backups |
| Others | `R2_MACHINE=<name>` | `<name>/latest/`, `<name>/daily/` | its own, or the main machine's until it has some |

Pick a source explicitly with `FROM=main npm run db:restore` or `FROM=laptop npm run db:restore`. Only one machine should run without `R2_MACHINE`.

#### Bringing picks and fund data to another machine

`git pull` brings code only; databases move through R2. Picks (`picks_tracker.db`) and followed fund pages with their stake history (`fund_watchlists.db`) do not merge between machines, so edit them on one machine and pull them on the other:

```bash
git pull
npm run dev:stop
FROM=a3426-21014 npm run db:restore -- picks_tracker.db fund_watchlists.db
npm run dev:bg
```

Set `FROM` to the `R2_MACHINE` of the machine you last edited on (`a3426-21014` here, `main` for the main machine). The machine you edited on must have backed up since (hourly with `npm run dev:bg`, or `npm run db:backup` now). Leave out the database names to restore every database.

### Clones from before 2026-11-20

The git history was rewritten on 2026-11-20 to take the databases out. On an older clone: stop the app, copy `data/` somewhere safe, then

```bash
git fetch origin
git reset --hard origin/main
npm run db:restore
```

## BoardRoom / DIN intake

Background scan, separate from the app (resumes by skipping PDFs already screened):

```bash
npm run scan:boardroom-bg                              # daily (--days 2 --limit 40)
npm run scan:boardroom-bg -- --days 7 --limit 80       # catch up a week
npm run scan:boardroom-bg -- --days 30 --limit 200     # catch up a month
npm run scan:boardroom-bg -- --pending-only --limit 80 # drain the queue

npm run push:boardroom-gov                 # push extracted DINs into governance.db (additive)
npm run push:boardroom-gov -- --limit 200
```

Then refresh **Dashboard → Business groups / People**: new joins show as teal nodes (click **New join** in the legend). Lookback: `GOV_RECENT_JOIN_DAYS` (default 30).

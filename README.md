# Research

India equities research app.

## Setup

```bash
git clone https://github.com/nareshkalakanti/research.git
cd research
cp .env.example .env.local   # or paste the block below into .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Demo login:** any email · password `demo`

## BoardRoom / DIN intake

Background scan (separate from `next dev`; resumes by skipping already-screened PDFs):

```bash
# Daily (default --days 2 --limit 40)
npm run scan:boardroom-bg

# Catch up a week / month, then drain the queue
npm run scan:boardroom-bg -- --days 7 --limit 80
npm run scan:boardroom-bg -- --days 30 --limit 200
npm run scan:boardroom-bg -- --pending-only --limit 80

# Re-push extracted DINs into governance.db (additive)
npm run push:boardroom-gov
npm run push:boardroom-gov -- --limit 200
```

Then refresh **Dashboard → Business groups / People** — new joins show as teal nodes (click **New join** in the legend). Lookback days: `GOV_RECENT_JOIN_DAYS` (default 30).

## `.env.local` (copy to other machines)

Create `.env.local` in the repo root. **Do not commit this file.**

```bash
# --- LLM (local Ollama — default, no API cost) ---
LLM_PROVIDER=ollama
LLM_MODEL=qwen2.5:3b-instruct
LLM_MODEL_OCR=glm-ocr
LLM_MODEL_HIGHLIGHTS=qwen2.5:3b-instruct
LLM_MODEL_QUANT=qwen2.5:3b-instruct
LLM_MODEL_UNIFIED=qwen2.5:3b-instruct
LLM_MODEL_TRANSCRIPT_FACTS=qwen2.5:3b-instruct
LLM_MODEL_RESULT_QUALITY=qwen2.5:3b-instruct
LLM_MODEL_MGMT_SENTIMENT=qwen2.5:3b-instruct
LLM_MODEL_CODE=qwen2.5:3b-instruct
# OLLAMA_BASE_URL=http://127.0.0.1:11434

# Pull models once:
#   ollama pull qwen2.5:3b-instruct
#   ollama pull glm-ocr

# --- Vision OCR (Ollama OpenAI-compatible) ---
QIANFAN_OCR_BASE_URL=http://127.0.0.1:11434/v1
QIANFAN_OCR_MODEL=glm-ocr

# --- Concall / OrderBook / MarketIQ ---
CONCALL_UNIFIED_LLM=1
CONCALL_OCR_MAX_PAGES=40
# CONCALL_PPT_OCR=0
ORDERBOOK_OCR=0
ORDERBOOK_OCR_MAX_PAGES=4
# MARKETIQ_OCR=0
# MARKETIQ_OCR_MAX_PAGES=12

# --- Firecrawl (optional — scanned PDF/DOCX parse) ---
FIRECRAWL_API_KEY=
# FIRECRAWL_API_URL=https://api.firecrawl.dev
# FIRECRAWL_MAX_PAGES=80
# FIRECRAWL_PDF_MODE=auto

# --- Cloud LLMs (optional; set LLM_PROVIDER=openai|anthropic) ---
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=

# --- Optional ---
# PORT=3000
# BRAND=Research
``` 

### Databases: backed up to Cloudflare R2, not git

`data/*.db` are **not committed** (they made the repo ~750 MB and hit GitHub's file limits). They live on this machine and are backed up to a Cloudflare R2 bucket:

| Command | What it does |
|---|---|
| `npm run dev:bg` | App in the background **+ an hourly backup** of every `data/*.db` (`logs/db-backup.log`) |
| `npm run db:backup` | Back up now |
| `npm run db:restore` | Stop the app first (`npm run dev:stop`), then restore all DBs from the newest backup |
| `npm run db:restore -- governance.db` | Restore one DB |
| `DAY=2026-11-19 npm run db:restore` | Restore from a daily backup (14 days kept) |

Backups use SQLite's online backup (safe while the app runs), pass `quick_check` before upload, and are gzipped (~40 MB total). A restore moves the current files to `data/.pre-restore/<time>/` first. If a DB is found corrupt at startup, `db:fix` / `metrics.db` recovery pull the newest backup automatically.

R2 settings in `.env.local` (never commit): `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, optional `R2_BUCKET` (default `research-db-backup`).

**New machine:** clone, add `.env.local`, `npm install`, `npm run db:restore`, `npm run dev:bg`.

`data/seeds/company_about.db` stays in git; `npm run dev` copies it to `data/company_about.db` if missing.

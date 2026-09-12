# Research

India equities research app (themes, BB/TQ scan, governance map).

## Setup

```bash
git clone https://github.com/nareshkalakanti/research.git
cd research
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

All research data lives in `data/` and is committed (SQLite DBs, notes). Clone on a new machine and you keep holdings, governance, notes, and scans — no scrape required.

**Demo login:** any email · password `demo`

## Environment (`.env.local`)

Copy [`.env.example`](.env.example) to `.env.local`. **Do not commit `.env.local`** — it holds API keys.

```bash
# LLM — cheapest default: local Ollama 3B (no API cost)
LLM_PROVIDER=ollama
LLM_MODEL=qwen2.5:3b-instruct
LLM_MODEL_OCR=qwen2.5vl:3b
# OLLAMA_BASE_URL=http://127.0.0.1:11434

# Cloud LLMs (optional; only when LLM_PROVIDER=openai|anthropic)
# Prefer gpt-4o-mini / claude-haiku if you must use cloud
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=

# Firecrawl — PDF/DOCX parse for concalls and investor materials
# https://docs.firecrawl.dev/features/parse
FIRECRAWL_API_KEY=
# FIRECRAWL_API_URL=https://api.firecrawl.dev
# FIRECRAWL_MAX_PAGES=80
# FIRECRAWL_PDF_MODE=auto   # auto | fast | ocr

# OrderBook OCR (optional; default off for bulk scan)
# ORDERBOOK_OCR=0
# ORDERBOOK_OCR_MAX_PAGES=4
# QIANFAN_OCR_BASE_URL=http://127.0.0.1:11434/v1
# QIANFAN_OCR_MODEL=glm-ocr

# Optional
# BRAND=Research
# PORT=3000
```

`LLM_PROVIDER` can be `ollama`, `openai`, `anthropic`, `auto`, `claude_code`, or `none`. Default is **ollama** with **3B** models. Pull: `ollama pull qwen2.5:3b-instruct` and `ollama pull qwen2.5vl:3b`. Concall dual Extract is lexical-first (no LLM). `auto` prefers Ollama before paid APIs.

With `FIRECRAWL_API_KEY`, Strategy concall **Documents** / **Get highlights** use Firecrawl AnyDoc (OCR for scanned PDFs). Without a key, local `pdf-parse` is used (text PDFs only).

**Concall** tab (`?tab=concall`): post-concall price drift (to CMP, ~500) plus corporate tone/DIN when extracted. Legacy `?tab=corporate` redirects here.

**Scan → Brutal**: age ≥25 (Groww `founded_year`) + Screener annual ROCE &gt;15% every year (~12 FY) + median YoY sales ≥12% + median YoY EPS &gt;12%. Use **Scan Brutal** then the **Brutal** chip.

**Scan → Superstar**: pulls latest Trendlyne superstar holdings into `data/superstar_holdings.db` (UI **Scan Superstar**, or `npm run scan:superstar`).

**Research** tab (`?tab=research`): **1 · Buyback**, **2 · Order book**, **3 · Concall** — all collapsed by default; expand one at a time.

## IQ data: 3–6 months first, then analyse

Run these in a **separate terminal** (not inside `next dev`) so the UI stays responsive.

### Step 1 — Pull announcement stubs (metadata only)

Saves ticker / title / PDF URL / date into SQLite as **pending**. No PDF download, OCR, or LLM.

| Lane | DB |
|------|-----|
| MarketIQ | `data/marketiq.db` |
| OrderBookIQ | `data/orderbookiq.db` |
| BoardRoomIQ | `data/boardroomiq.db` |

```bash
# ~3 months (90 days) — all three lanes
npm run backfill:announced:3m

# ~6 months (180 days) — all three lanes
npm run backfill:announced:6m

# One lane only
npm run backfill:announced -- --days 180 --lane marketiq
npm run backfill:announced -- --days 180 --lane orderbook
npm run backfill:announced -- --days 180 --lane boardroom

# Custom chunk / pause
npm run backfill:announced -- --days 180 --chunk 5 --pause-ms 400
```

**Resume:** if the backfill stops mid-way, run the **same command again**. It continues from `logs/announced-backfill.ckpt.json`. Use `--fresh` to ignore the checkpoint and start over (dupes are still skipped in DB).

```bash
npm run backfill:announced:6m          # resume OK
npm run backfill:announced -- --days 180 --fresh
```

### Step 2 — Analyse PDFs in the background

Skips URLs already scored / PASS / FAIL. Re-run after a crash to continue.

```bash
# All three lanes (pending stubs only)
npm run scan:iq-bg -- --limit 40

# Per lane
npm run scan:marketiq-bg -- --pending-only --limit 40
npm run scan:orderbook-bg -- --pending-only --limit 30 --mode lexical
npm run scan:boardroom-bg -- --pending-only --limit 40

# Discover recent days + analyse (also merges DB pending → resume-safe)
npm run scan:marketiq-bg -- --days 7 --limit 40
npm run scan:orderbook-bg -- --days 7 --limit 30 --mode lexical
npm run scan:boardroom-bg -- --days 7 --limit 40

# OrderBook with OCR
npm run scan:orderbook-bg -- --pending-only --limit 30 --ocr
```

Logs: `logs/marketiq-scan-YYYYMMDD.jsonl`, `logs/orderbook-scan-YYYYMMDD.jsonl`, `logs/boardroom-scan-YYYYMMDD.jsonl`.

UI **Refresh** / **Scan & Analyse** still work for short lookbacks; use these scripts for multi-month loads.

### Starter goals (enough to begin investing use)

You do **not** need every pending PDF analysed. Aim for:

| Lane | Starter target | Then |
|------|----------------|------|
| **OrderBookIQ** | ≥ **20 PASS** (or pending queue empty) | Use Orders / OrderBookIQ list |
| **BoardRoomIQ** | ≥ **200** analysed | Use BoardRoom history |
| **MarketIQ** | ≥ **500** analysed | Use MarketIQ history + Watch |

```bash
# Check progress
npm run scan:iq-starter -- --status

# Analyse until starter targets are met (resume-safe)
npm run scan:iq-starter

# One lane only
npm run scan:iq-starter -- --lane boardroom
npm run scan:iq-starter -- --lane marketiq
npm run scan:iq-starter -- --lane orderbook
```

Keep running `scan:iq-starter` (or the per-lane `scan:*-bg` commands) until status shows targets met. After that, optional deeper backfill is nice-to-have, not required to start.

## SQLite health

Corrupt DBs (common after copying mid-write or cloud sync) auto-recover on open: drop bad WAL, then `sqlite3 .recover` if needed.

```bash
npm run db:verify      # check all data/*.db
npm run db:fix-all    # repair any corrupt files
npm run db:prepare-sync  # checkpoint WAL before copying the repo
npm run scan:concall-drift
```

`npm run dev` runs `db:prepare-dev` first (auto-fix). Keep `data/` out of iCloud/Dropbox.

Dedicated save/reuse DBs (created locally; **gitignored** — not shipped between machines):

- `data/marketiq.db` — MarketIQ analysed announcements
- `data/orderbookiq.db` — OrderBookIQ PASS/FAIL screens (Scan skips known PDF URLs)
- `data/boardroomiq.db` — BoardRoomIQ board / director / AGM screens

Scan logs live under `logs/` (also gitignored). Re-run Refresh / `scan:*-bg` on each machine.

### LLM prompts

Edit system prompts in [`prompts/`](prompts/) — Business, Concall drift, call review, and PPT distill. See [`prompts/README.md`](prompts/README.md).

"award of order" OR "Notification of Award" OR "letter of intent" OR "large order" OR "Order for Procurement" OR "Awarding of order" OR "bagged an order"

"transcript" OR "conference call transcript" OR "earnings call transcript" OR "investor presentation" OR "earnings presentation" OR "analyst presentation" OR "investor/analyst call"

"Transcript of" OR "Earnings Presentation" OR "Investor Presentation" OR "Analyst Presentation" OR "conference call" OR "Investor/Analyst Call"

MONARCH("Transcript of" OR "Earnings Presentation" OR "Investor Presentation" OR "Investor/Analyst Call")

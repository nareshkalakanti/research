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

# Optional
# BRAND=Research
# PORT=3000
```

`LLM_PROVIDER` can be `ollama`, `openai`, `anthropic`, `auto`, `claude_code`, or `none`. Default is **ollama** with **3B** models. Pull: `ollama pull qwen2.5:3b-instruct` and `ollama pull qwen2.5vl:3b`. Concall dual Extract is lexical-first (no LLM). `auto` prefers Ollama before paid APIs.

With `FIRECRAWL_API_KEY`, Strategy concall **Documents** / **Get highlights** use Firecrawl AnyDoc (OCR for scanned PDFs). Without a key, local `pdf-parse` is used (text PDFs only).

**Concall** tab (`?tab=concall`): post-concall price drift (to CMP, ~500) plus corporate tone/DIN when extracted. Legacy `?tab=corporate` redirects here.

**Scan → Brutal**: age ≥25 (Groww `founded_year`) + Screener annual ROCE &gt;15% every year (~12 FY) + median YoY sales ≥12% + median YoY EPS &gt;12%. Use **Scan Brutal** then the **Brutal** chip.

**Scan → Superstar**: pulls latest Trendlyne superstar holdings into `data/superstar_holdings.db` (UI **Scan Superstar**, or `npm run scan:superstar`).

**Research** tab (`?tab=research`): **1 · Buyback** (tender PDF screen + pass row), **2 · Order book** (Reg-30 order PDF → awarding / size / execution + order÷sales), and **3 · Concall** (earnings-call transcript PDF → structured JSON via `prompts/concall-research-extract.system.txt`; fixture `data/concall-research-expected-indoborax.json`). Text via `pdf-parse`; thin PDFs use vision OCR when `QIANFAN_OCR_BASE_URL` is set.

## SQLite health

Corrupt DBs (common after copying mid-write or cloud sync) auto-recover on open: drop bad WAL, then `sqlite3 .recover` if needed.

```bash
npm run db:verify      # check all data/*.db
npm run db:fix-all    # repair any corrupt files
npm run db:prepare-sync  # checkpoint WAL before copying the repo
npm run scan:concall-drift
```

`npm run dev` runs `db:prepare-dev` first (auto-fix). Keep `data/` out of iCloud/Dropbox.

Dedicated save/reuse DBs (auto-migrated from legacy names once):

- `data/marketiq.db` — MarketIQ analysed announcements
- `data/orderbookiq.db` — OrderBookIQ PASS/FAIL screens (Scan skips known PDF URLs)

### LLM prompts

Edit system prompts in [`prompts/`](prompts/) — Business, Concall drift, call review, and PPT distill. See [`prompts/README.md`](prompts/README.md).

"award of order" OR "Notification of Award" OR "letter of intent" OR "large order" OR "Order for Procurement" OR "Awarding of order" OR "bagged an order"

"transcript" OR "conference call transcript" OR "earnings call transcript" OR "investor presentation" OR "earnings presentation" OR "analyst presentation" OR "investor/analyst call"

"Transcript of" OR "Earnings Presentation" OR "Investor Presentation" OR "Analyst Presentation" OR "conference call" OR "Investor/Analyst Call"

MONARCH("Transcript of" OR "Earnings Presentation" OR "Investor Presentation" OR "Investor/Analyst Call")
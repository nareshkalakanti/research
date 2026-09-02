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
# LLM — local Ollama is the usual setup
LLM_PROVIDER=ollama
LLM_MODEL=qwen2.5:7b-instruct
# OLLAMA_BASE_URL=http://127.0.0.1:11434

# Cloud LLMs (optional; used when LLM_PROVIDER=openai|anthropic|auto)
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

`LLM_PROVIDER` can be `ollama`, `openai`, `anthropic`, `auto`, `claude_code`, or `none`. With Ollama: `ollama serve` then `ollama pull qwen2.5:7b-instruct`.

With `FIRECRAWL_API_KEY`, Strategy concall **Documents** / **Get highlights** use Firecrawl AnyDoc (OCR for scanned PDFs). Without a key, local `pdf-parse` is used (text PDFs only).

## SQLite health

Corrupt DBs (common after copying mid-write or cloud sync) auto-recover on open: drop bad WAL, then `sqlite3 .recover` if needed.

```bash
npm run db:verify      # check all data/*.db
npm run db:fix-all    # repair any corrupt files
npm run db:prepare-sync  # checkpoint WAL before copying the repo
npm run scan:concall-drift
```

`npm run dev` runs `db:prepare-dev` first (auto-fix). Keep `data/` out of iCloud/Dropbox.

### LLM prompts

Edit system prompts in [`prompts/`](prompts/) — Business, Concall drift, call review, and PPT distill. See [`prompts/README.md`](prompts/README.md).
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

`data/` SQLite DBs are mostly committed so a fresh clone keeps research state. Machine-local scan DBs (`marketiq.db`, `orderbookiq.db`, `boardroomiq.db`) and `logs/` are gitignored — re-run scans on each machine if needed.

---
name: napkin-research
description: >-
  Napkin tab: Yahoo snapshot + Screener 3Y/5Y CAGRs + napkin required-EPS-CAGR math.
  No Qwen, Ollama, PDFs, filings, or embeddings on this path.
---

# Napkin research

Simple Analyse path only. Follow `never-hardcode-data`. No issuer forks.

```
Enter NSE ticker
  → Yahoo Finance (price, mcap, P/E, EPS, revenue, profit, ROE/ROCE)
  → Screener.in annual P&L (3Y/5Y revenue, profit, EPS CAGR)
  → Napkin math (required EPS CAGR from P/E, historical CAGR, growth gap)
  → One result card
```

No Qwen, Ollama, PDFs, filings, document extract, embeddings, or vector DB on Analyse.

Yahoo owns current levels. Screener owns CAGRs when it has 4 points (3Y) or 6 points (5Y). Groww yearly only if Screener 5Y is still missing. Never stitch Yahoo ₹ onto Screener ₹ Cr. Never treat 4 Yahoo years as 5Y.

Required EPS CAGR = `(PE × 0.30)^(1/5) − 1`. Growth gap = historical EPS CAGR − required. Missing = N/A.

Screen (configurable pp, not a buy/sell rule): PASS if gap ≥ `NAPKIN_PASS_GAP_PP` (default 10), HOLD if gap ≥ `NAPKIN_HOLD_MIN_GAP_PP` (default −10), else FAIL. Null hist or required → INSUFFICIENT DATA.

Status: `complete` / `partial` / `insufficient` from whether P/E, required CAGR, current levels, and 3Y/5Y CAGRs exist. Never fabricate.

Files: `NapkinPanel.tsx`, `GET /api/napkin`, `financials.ts`, `engine.ts`, `simple.ts`, `status.ts`.

```
npx tsx test/napkin-engine.test.ts
npx tsx test/financial-data-cagr.test.ts
npx tsx test/napkin-status.test.ts
```

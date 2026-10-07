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
  → Local About (company_about) + quarterly panel (/api/quarters) — read-only context
  → Napkin math (required EPS CAGR from P/E, historical CAGR)
  → Your expected EPS CAGR (chips / custom %)
  → 5-year EPS and implied price if P/E is unchanged
  → One result card (no PASS/FAIL box)
```

No Qwen, Ollama, PDFs, filings, document extract, embeddings, or vector DB on Analyse. About/quarters are stored/local fetch only.

Yahoo owns current levels. Screener owns CAGRs when it has 4 points (3Y) or 6 points (5Y). Groww yearly only if Screener 5Y is still missing. Never stitch Yahoo ₹ onto Screener ₹ Cr. Never treat 4 Yahoo years as 5Y.

Required EPS CAGR = `(PE × 0.30)^(1/5) − 1` (a ratio, then shown as %). At P/E 34.8 that is ~59.9%, not ~27.9% — fifth root of 10.44 is ~1.60, not ~1.28. Growth gap = historical EPS CAGR − required. Missing = N/A.

Expected EPS CAGR is the user’s assumption (presets 10–40% or a custom %). Growth vs required = expected − required. Growth vs historical = expected − historical.

5-year scenario: EPS_N = EPS × (1 + expected)^N; exit P/E = current P/E; implied price = EPS_N × P/E; price CAGR from current vs implied. Warn when expected − historical ≥ `NAPKIN_PASS_GAP_PP` (default 10pp). No PASS/FAIL on the main card.

Max pay today (separate from required CAGR): exit price = EPS × (1 + expected)^5 × exit P/E; max pay today = exit price / (1 + target return)^5. Not the future exit price. Defaults: expected 15%, target return 15%, exit P/E = current P/E.

Status: `complete` / `partial` / `insufficient` from whether P/E, required CAGR, current levels, and 3Y/5Y CAGRs exist. Never fabricate.

Files: `NapkinPanel.tsx`, `GET /api/napkin`, `financials.ts`, `engine.ts`, `simple.ts`, `status.ts`.

```
npx tsx test/napkin-engine.test.ts
npx tsx test/financial-data-cagr.test.ts
npx tsx test/napkin-status.test.ts
```

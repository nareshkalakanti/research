# LLM system prompts

Edit the `.system.txt` files in this folder to tune AI output. Changes apply on the next API call (restart `npm run dev` if a prompt seems stuck).

| File | Used by |
|------|---------|
| `business-brief.system.txt` | **Business** tab — company dossier JSON |
| `llm-about.system.txt` | **Missing data → About** — write About from name/sector/Yahoo (no scrape) |
| `theme-scan-expand.system.txt` | **Theme Scanner** — turn a search into retrieval terms + listed names |
| `theme-scan-judge.system.txt` | **Theme Scanner** — keep/drop retrieved stocks |
| `concall-drift.system.txt` | **Concall** tab — post-earn drift analysis |
| `investor-call-review.system.txt` | **Business** tab — 10-row call/PPT review |
| `investor-material-distill.system.txt` | **Calls** tab — distill imported PPT/PDF/concall text |
| `concall-scanlines.system.txt` | **Research · Concall** dual Extract — 3 StockScans PASS scanlines + light financials |
| `concall-research-extract.system.txt` | **Research · Concall** — structured earnings-call JSON extract |
| `orderbook-extract.system.txt` | **Research · Order book** — optional LLM Reg-30 order/LOI JSON extract (`mode=llm`; lexical fill) |
| `investor-presentation-extract.system.txt` | **Investor Presentation** — structured deck/PPT extract (separate schema; route by doc type) |
| `unified-earnings-extract.system.txt` | Offline / scripts — full Sections A–E schema. **Not** run on dual Extract (token-heavy). |

Materials downloaded on the **Calls** tab (concall transcript, investor PPT, PDF) are fed into Business and Concall prompts automatically when present in `company_about.db`.

**Dual Extract (Transcript + PPT):** text via pdf-parse (PPT vision OCR when `QIANFAN_OCR_*` set). PASS scanlines via LLM prompt `concall-scanlines.system.txt` (`CONCALL_UNIFIED_LLM=0` to skip).

**PDF/DOCX parse:** set `FIRECRAWL_API_KEY` in `.env.local` to use Firecrawl AnyDoc (`/v2/parse`) — OCR for scanned concall PDFs, better tables/layout than local pdf-parse. Concall drift auto-imports materials when you open the **Concall** tab.

Tips:
- Keep `Return ONLY valid JSON` and field names unchanged unless you update the TypeScript normalizers in `src/lib/`.
- Prefer concrete Indian-market examples in rules, not in the JSON schema itself.
- Shorter prompts often work better on local Ollama (7B).

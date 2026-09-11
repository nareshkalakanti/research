---
name: never-hardcode-data
description: >-
  Never hardcode data for anything — no issuer/ticker/UI special cases, no
  one-off DB gold patches, no magic numbers or sample facts as the fix. Use on
  every coding, prompt, extract, Analyze, UI, test, or data-fix task.
---

# never hardcode data

## Rule (verbatim)

**never hardcode data**

**for anything dont hardcode**

## Scope

Applies to **everything** in this repo: extractors, prompts, APIs, UI, SQL/DB
patches, tests, fixtures wiring, configs, and one-off “just fix this row” scripts.

## Forbidden

- Company / ticker / person / fund special-cases in code or prompts
- Pasting the desired output (highlights, scores, names, ₹/bps) into code or DB
  as the fix
- Magic numbers that encode one real-world fact instead of reading inputs
- Prompt few-shots that teach one issuer’s numbers as the answer shape
- `if (ticker === "…")` / `company.includes("…")` behavior forks for “this name”

## Required approach

1. Read from **inputs** (materials text, APIs, DB fields already on the row).
2. Use **generic** patterns, schemas, and transforms.
3. If output is wrong, fix the **general** path; re-run on the case.
4. Capture names/numbers **from the source** after a generic match — do not type them in.

## Allowed

- Shared schemas, enums, labels (`BIGGEST WIN`, column titles)
- Unit/format normalization (Mn → ₹cr, truncate headlines)
- Dedup / validate / reorder without inventing facts
- Test fixtures under `test/` that are explicitly gold samples (not production logic)

## Stop if

You’re about to type a specific real-world fact, ticker, or output sentence into
`src/`, `prompts/`, or a production DB update “just for this one case.”

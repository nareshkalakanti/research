/**
 * Screenshot → industry + names → resolve listings → save rotation sector.
 */
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { bootstrapCompanyTicker } from "./company-ticker-bootstrap";
import { invalidateCompanyCache } from "./db";
import { parseSectorScreenshot, preferBatchIndustry, tidyIndustry } from "./sector-screenshot-parse";
import { resolveListingQuery } from "./sector-rotation-resolve";
import {
  listRotationSectors,
  mergeRotationSectorByLabel,
  type RotationSector,
} from "./sector-rotation";
import { runConcurrent } from "./scrape-pool";

const OCR_PROMPT = `Transcribe this equity table screenshot.
Output JSON only, no markdown. Prefer one object per data row:
{"Name":"<Name column>","Industry":"<Industry column cell>"}
The Industry field MUST be the repeating Industry *column cell* on the rows (same text on most rows).
Do not use a parent group, breadcrumb, sidebar, or filter (a broader heading above the table).
Never set industry to a company name (nothing ending Ltd/Limited). Skip headers, tab bars, and prices.
You may also output {"industry":"<column cell>","names":["..."]} but industry is still the column cell, not a parent heading.`;

const INDUSTRY_OCR = `Read only the Industry column of this stock table (the repeated theme on the right of names, not the company names).
Output that industry text on one line. If the cell is truncated with …, copy the visible words only. No JSON. No company names ending Ltd.`;

export type SectorShotImport = {
  ocr: string;
  industry: string;
  names: string[];
  unresolved: string[];
  sector: RotationSector;
};

export type SectorShotEvent =
  | { t: "ocr" }
  | { t: "parsed"; industry: string; names: string[] }
  | { t: "hit"; query: string; ticker: string; name: string }
  | { t: "dup"; query: string; ticker: string }
  | { t: "miss"; query: string }
  | { t: "save"; label: string; n: number }
  | {
      t: "count";
      extracted: number;
      resolved: number;
      unresolved: number;
      before: number;
      after: number;
    }
  | { t: "done"; industry: string; names: string[]; unresolved: string[]; sector: RotationSector }
  | { t: "error"; error: string };

export async function importSectorFromScreenshot(
  imageDataUrl: string,
  onEvent?: (ev: SectorShotEvent) => void,
  priorIndustry?: string,
): Promise<SectorShotImport> {
  if (!imageDataUrl.startsWith("data:image")) {
    throw new Error("screenshot image required");
  }
  onEvent?.({ t: "ocr" });
  const beat = setInterval(() => onEvent?.({ t: "ocr" }), 12_000);
  let ocr = "";
  try {
    ocr = await ocrImageWithQianfan(imageDataUrl, OCR_PROMPT, 2560, {
      maxEdge: 1152,
      numCtx: 8192,
    });
  } finally {
    clearInterval(beat);
  }
  const parsed = parseSectorScreenshot(ocr);
  let industry = tidyIndustry(parsed.industry) || "";
  const weakColumn =
    !parsed.rowIndustries.length && industry.split(/\s+/).filter(Boolean).length === 1;
  if (industry.length < 2 || weakColumn) {
    onEvent?.({ t: "ocr" });
    const indOcr = await ocrImageWithQianfan(imageDataUrl, INDUSTRY_OCR, 256, {
      maxEdge: 1152,
      numCtx: 8192,
    });
    const fromCol =
      tidyIndustry(parseSectorScreenshot(indOcr).industry) ||
      tidyIndustry(indOcr.split(/\n/)[0] || "") ||
      "";
    if (fromCol.length >= 2) {
      industry = preferBatchIndustry(industry, fromCol);
    }
  }
  industry = preferBatchIndustry(priorIndustry || "", industry);
  if (industry.length < 2) {
    throw new Error(
      `Could not read Industry from the screenshot${ocr.trim() ? `: ${ocr.replace(/\s+/g, " ").slice(0, 280)}` : ""}`,
    );
  }
  if (!parsed.names.length) {
    throw new Error(
      `Could not read company names from the screenshot${ocr.trim() ? `: ${ocr.replace(/\s+/g, " ").slice(0, 280)}` : ""}`,
    );
  }
  onEvent?.({ t: "parsed", industry, names: parsed.names });
  const prior =
    listRotationSectors().find(
      (s) => s.label.toLowerCase() === industry.toLowerCase(),
    )?.members.length ?? 0;
  const unresolved: string[] = [];
  const members: Array<{ ticker: string; name: string; market: string }> = [];
  const have = new Set<string>();
  const hits = await runConcurrent(parsed.names, 6, (q) =>
    resolveListingQuery(q),
  );
  for (let i = 0; i < parsed.names.length; i++) {
    const q = parsed.names[i]!;
    const hit = hits[i];
    if (!hit) {
      unresolved.push(q);
      onEvent?.({ t: "miss", query: q });
      continue;
    }
    const ticker = hit.ticker.toUpperCase();
    if (have.has(ticker)) {
      onEvent?.({ t: "dup", query: q, ticker });
      continue;
    }
    have.add(ticker);
    members.push({ ticker, name: hit.name, market: hit.market });
    onEvent?.({ t: "hit", query: q, ticker, name: hit.name });
  }
  if (!members.length) {
    throw new Error(
      `None of the names resolved: ${parsed.names.slice(0, 8).join(", ")}`,
    );
  }
  const sector = mergeRotationSectorByLabel(industry, members);
  onEvent?.({
    t: "count",
    extracted: parsed.names.length,
    resolved: members.length,
    unresolved: unresolved.length,
    before: prior,
    after: sector.members.length,
  });
  onEvent?.({ t: "save", label: sector.label, n: sector.members.length });
  void Promise.all(
    members.map(async (m) => {
      try {
        await bootstrapCompanyTicker(m.ticker, {
          name: m.name,
          market: m.market,
        });
      } catch (err) {
        console.warn(
          "[sector-shot] about bootstrap skipped:",
          m.ticker,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  ).then(() => invalidateCompanyCache());
  return {
    ocr,
    industry,
    names: parsed.names,
    unresolved,
    sector,
  };
}

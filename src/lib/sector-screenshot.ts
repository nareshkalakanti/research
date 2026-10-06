/**
 * Screenshot → industry + names → resolve listings → save rotation sector.
 */
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { bootstrapCompanyTicker } from "./company-ticker-bootstrap";
import { invalidateCompanyCache } from "./db";
import { parseSectorScreenshot, tidyIndustry } from "./sector-screenshot-parse";
import { resolveListingQuery } from "./sector-rotation-resolve";
import {
  listRotationSectors,
  mergeRotationSectorByLabel,
  type RotationSector,
} from "./sector-rotation";

const OCR_PROMPT = `Transcribe this equity table screenshot.
Output JSON only, no markdown:
{"industry":"<Industry column value>","names":["<Name column company>"]}
Use the Name column for names. Use the Industry *cell* (not the column title).
You may output either one object {"industry":"...","names":["..."]} or one object per row {"Name":"...","Industry":"..."}.
Never set industry to a company name (nothing ending Ltd/Limited). The first Name-column row belongs in names, not industry.
Industry is the Industry column (may be truncated with …). Do not invent names. Skip headers, tab bars, and prices.`;

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
): Promise<SectorShotImport> {
  if (!imageDataUrl.startsWith("data:image")) {
    throw new Error("screenshot image required");
  }
  onEvent?.({ t: "ocr" });
  const ocr = await ocrImageWithQianfan(imageDataUrl, OCR_PROMPT, 4096);
  const parsed = parseSectorScreenshot(ocr);
  let industry = tidyIndustry(parsed.industry) || "";
  if (industry.length < 2) {
    onEvent?.({ t: "ocr" });
    const indOcr = await ocrImageWithQianfan(imageDataUrl, INDUSTRY_OCR, 256);
    industry =
      tidyIndustry(parseSectorScreenshot(indOcr).industry) ||
      tidyIndustry(indOcr.split(/\n/)[0] || "") ||
      "";
  }
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
  for (const q of parsed.names) {
    const hit = await resolveListingQuery(q);
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
    await bootstrapCompanyTicker(ticker, {
      name: hit.name,
      market: hit.market,
    });
  }
  if (!members.length) {
    throw new Error(
      `None of the names resolved: ${parsed.names.slice(0, 8).join(", ")}`,
    );
  }
  invalidateCompanyCache();
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
  return {
    ocr,
    industry,
    names: parsed.names,
    unresolved,
    sector,
  };
}

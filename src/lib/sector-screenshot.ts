/**
 * Screenshot → industry + names → resolve listings → save rotation sector.
 */
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { bootstrapCompanyTicker } from "./company-ticker-bootstrap";
import { invalidateCompanyCache, loadAllCompanies } from "./db";
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
If the Name column is numbered, output every numbered row from 1 through the last visible number. Do not drop the first rows.
You may also output {"industry":"<column cell>","names":["..."]} but industry is still the column cell, not a parent heading. names.length must match the row count.
Do not use {"1":"...","2":"..."} numbered keys.`;

const NAMES_OCR = `List every company in the Name column of this stock table, top to bottom.
One company per line. Keep Ltd/Limited. Include the first row. No JSON, no prices, no industry.`;

function voteLabel(labels: string[]): string {
  const counts = new Map<string, { n: number; label: string }>();
  for (const raw of labels) {
    const t = tidyIndustry(raw);
    if (!t) continue;
    const k = t.toLowerCase();
    const cur = counts.get(k);
    if (cur) cur.n += 1;
    else counts.set(k, { n: 1, label: t });
  }
  let best = "";
  let n = 0;
  for (const v of counts.values()) {
    if (v.n > n) {
      n = v.n;
      best = v.label;
    }
  }
  return n >= 1 ? best : "";
}

/** Industry from About/classifications and existing rotation baskets — not OCR. */
function industryFromResolvedTickers(tickers: string[]): string {
  const want = new Set(tickers.map((t) => t.toUpperCase()));
  const aboutVotes: string[] = [];
  try {
    for (const c of loadAllCompanies()) {
      if (!want.has(c.ticker.toUpperCase())) continue;
      const label = c.sub_sector || c.sector;
      if (label) aboutVotes.push(label);
    }
  } catch {
    /* listings still usable */
  }
  const fromAbout = voteLabel(aboutVotes);
  let overlapLabel = "";
  let overlapN = 0;
  for (const s of listRotationSectors()) {
    const n = s.members.filter((m) => want.has(m.ticker.toUpperCase())).length;
    if (n > overlapN) {
      overlapN = n;
      overlapLabel = s.label;
    }
  }
  if (overlapN >= 2) return overlapLabel;
  return fromAbout || (overlapN === 1 ? overlapLabel : "");
}

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
  let nameOcr = "";
  try {
    const pair = await Promise.all([
      ocrImageWithQianfan(imageDataUrl, OCR_PROMPT, 2560, {
        maxEdge: 1152,
        numCtx: 8192,
      }),
      ocrImageWithQianfan(imageDataUrl, NAMES_OCR, 2048, {
        maxEdge: 1152,
        numCtx: 8192,
      }),
    ]);
    ocr = pair[0];
    nameOcr = pair[1];
  } finally {
    clearInterval(beat);
  }
  const parsed = parseSectorScreenshot(`${ocr}\n${nameOcr}`);
  const names = parsed.names;
  if (!names.length) {
    throw new Error(
      "Could not read company names from the screenshot. Paste a Name-column table (Ltd/Limited rows).",
    );
  }
  let industry = tidyIndustry(parsed.industry) || "";
  industry = preferBatchIndustry(priorIndustry || "", industry);
  onEvent?.({ t: "parsed", industry: industry || "(from listings)", names });
  const unresolved: string[] = [];
  const members: Array<{ ticker: string; name: string; market: string }> = [];
  const have = new Set<string>();
  const hits = await runConcurrent(names, 6, (q) => resolveListingQuery(q));
  for (let i = 0; i < names.length; i++) {
    const q = names[i]!;
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
      `None of the names resolved: ${names.slice(0, 8).join(", ")}`,
    );
  }
  if (industry.length < 2) {
    industry =
      industryFromResolvedTickers(members.map((m) => m.ticker)) || "";
  }
  industry = preferBatchIndustry(priorIndustry || "", industry);
  if (industry.length < 2) {
    throw new Error(
      "Could not read Industry. Paste the first page of the table (Industry column visible), or type the sector name on the right and add these stocks there.",
    );
  }
  const prior =
    listRotationSectors().find(
      (s) => s.label.toLowerCase() === industry.toLowerCase(),
    )?.members.length ?? 0;
  const sector = mergeRotationSectorByLabel(industry, members);
  onEvent?.({
    t: "count",
    extracted: names.length,
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
    names: names,
    unresolved,
    sector,
  };
}

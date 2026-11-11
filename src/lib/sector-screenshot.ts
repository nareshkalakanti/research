/**
 * Screenshot → industry + names → resolve listings → save rotation sector.
 */
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { bootstrapCompanyTicker } from "./company-ticker-bootstrap";
import { invalidateCompanyCache } from "./db";
import {
  parseSectorNameIndustryPairs,
  parseSectorScreenshot,
  preferBatchIndustry,
  tidyIndustry,
} from "./sector-screenshot-parse";
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
Typical Screener columns: Name | Market Capitalization | Industry | Close Price.
Industry is the text column AFTER market cap and BEFORE close price (often hyphenated, e.g. "Infrastructure - Engineering & Construction"). Copy that cell exactly; do not invent Yahoo/NSE sector names.
The Industry field MUST be ONE copy of the repeating Industry *column cell* (same text on most rows). Never concatenate or comma-join every row's Industry cell into one string.
Do not use a parent group, breadcrumb, sidebar, or filter (a broader heading above the table).
Never set industry to a company name (nothing ending Ltd/Limited). Skip headers, tab bars, and prices.
If the Name column is numbered, output every numbered row from 1 through the last visible number. Do not drop the first rows.
You may also output {"industry":"<column cell>","names":["..."]} but industry is still the column cell, not a parent heading. names.length must match the row count.
Do not use {"1":"...","2":"..."} numbered keys.`;

const NAMES_OCR = `List every company in the Name column of this stock table, top to bottom.
One company per line. Keep Ltd/Limited. Include the first row. No JSON, no prices, no industry.`;

const INDUSTRY_OCR = `Read only the Industry column of this Screener stock table.
Reply with that one repeating industry cell label only (copy it exactly, including hyphens).
Examples of shape: Entertainment - Content Providers · Infrastructure - Engineering & Construction.
No JSON, no company names, no market caps, no prices, no markdown.`;

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

/**
 * Only reuse an existing rotation basket when members already sit there.
 * Never invent a label from Yahoo/NSE taxonomy — that drifts from Screener
 * Industry (e.g. "Industrial Machinery" vs "Engineering - Light - General").
 */
function industryFromExistingBaskets(tickers: string[]): string {
  const want = new Set(tickers.map((t) => t.toUpperCase()));
  let overlapLabel = "";
  let overlapN = 0;
  for (const s of listRotationSectors()) {
    const n = s.members.filter((m) => want.has(m.ticker.toUpperCase())).length;
    if (n > overlapN) {
      overlapN = n;
      overlapLabel = s.label;
    }
  }
  // Need a clear majority of the batch already in one basket.
  if (overlapN >= 2 && overlapN * 2 >= want.size) return overlapLabel;
  return "";
}

const INDUSTRY_REQUIRED =
  "Could not read Industry from the table. Paste/copy with the Industry column visible, continue a multi-page batch of the same industry, or type the sector name on the right and add these stocks there.";

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
  | {
      t: "done";
      industry: string;
      names: string[];
      unresolved: string[];
      sector: RotationSector;
      sectors?: RotationSector[];
    }
  | { t: "error"; error: string };

export type SectorTableImport = {
  industry: string;
  names: string[];
  unresolved: string[];
  sector: RotationSector;
  sectors: RotationSector[];
};

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
    // Local OCR only when it also yields Industry — name-only reads used to
    // short-circuit vision and then fail with INDUSTRY_REQUIRED.
    const { tesseractFromDataUrl, localOcrLooksUseful } = await import(
      "./ocr-fast"
    );
    const local = await tesseractFromDataUrl(imageDataUrl);
    if (local && localOcrLooksUseful(local)) {
      const localParsed = parseSectorScreenshot(local);
      if (localParsed.names.length >= 3 && tidyIndustry(localParsed.industry)) {
        ocr = local;
        nameOcr = local;
      }
    }
    if (!ocr) {
      const pair = await Promise.all([
        ocrImageWithQianfan(imageDataUrl, OCR_PROMPT, 2560, {
          maxEdge: 1152,
          numCtx: 8192,
          forceVision: true,
        }),
        ocrImageWithQianfan(imageDataUrl, NAMES_OCR, 2048, {
          maxEdge: 1152,
          numCtx: 8192,
          forceVision: true,
        }),
      ]);
      ocr = pair[0];
      nameOcr = pair[1];
    }
    // Dual vision often returns names but drops Industry — one cheap rescue.
    {
      const early = parseSectorScreenshot(`${ocr}\n${nameOcr}`);
      if (early.names.length >= 3 && !tidyIndustry(early.industry)) {
        try {
          const indOnly = await ocrImageWithQianfan(
            imageDataUrl,
            INDUSTRY_OCR,
            128,
            { maxEdge: 1152, numCtx: 4096, forceVision: true },
          );
          const rescued = tidyIndustry(indOnly.split(/\n/)[0] || indOnly);
          if (rescued) {
            ocr = `${ocr}\nindustry: ${rescued}`;
          }
        } catch {
          /* later error / priorIndustry */
        }
      }
    }
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
  // Screener Industry column first — never Yahoo/NSE taxonomy as a substitute.
  let industry = tidyIndustry(parsed.industry) || "";
  onEvent?.({
    t: "parsed",
    industry: industry || "(resolving…)",
    names,
  });
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
  // Multi-page batch: keep the first page's Screener leaf when this page
  // OCR missed Industry (do this before inventing any other label).
  if (industry.length < 2) {
    industry = tidyIndustry(priorIndustry || "") || "";
  }
  if (industry.length < 2) {
    industry =
      industryFromExistingBaskets(members.map((m) => m.ticker)) || "";
  }
  // Prior only merges multi-page shots of the *same* industry — never a
  // different Capital Goods leaf (Switchgear vs Transformers).
  industry = preferBatchIndustry(priorIndustry || "", industry);
  if (industry.length < 2) {
    throw new Error(INDUSTRY_REQUIRED);
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

/**
 * Paste path (Screener TSV / HTML table): pair each Name with its Industry cell,
 * resolve listings, and merge one rotation basket per distinct industry.
 */
export async function importSectorFromTableText(
  text: string,
  onEvent?: (ev: SectorShotEvent) => void,
): Promise<SectorTableImport> {
  const raw = (text || "").trim();
  if (raw.length < 8) {
    throw new Error("Paste a screener table (Name + Industry columns).");
  }
  const pairs = parseSectorNameIndustryPairs(raw);
  if (!pairs.length) {
    // Fall back to OCR-style aggregate parse for odd clipboard shapes.
    const parsed = parseSectorScreenshot(raw);
    if (!parsed.names.length) {
      throw new Error(
        "Could not read company names. Copy the Name + Industry columns from Screener.",
      );
    }
    const industry = tidyIndustry(parsed.industry) || "";
    onEvent?.({
      t: "parsed",
      industry: industry || "(resolving…)",
      names: parsed.names,
    });
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
    let label = industry;
    if (label.length < 2) {
      label =
        industryFromExistingBaskets(members.map((m) => m.ticker)) || "";
    }
    if (label.length < 2) {
      throw new Error(INDUSTRY_REQUIRED);
    }
    const prior =
      listRotationSectors().find(
        (s) => s.label.toLowerCase() === label.toLowerCase(),
      )?.members.length ?? 0;
    const sector = mergeRotationSectorByLabel(label, members);
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
        } catch {
          /* optional */
        }
      }),
    ).then(() => invalidateCompanyCache());
    return {
      industry: label,
      names: parsed.names,
      unresolved,
      sector,
      sectors: [sector],
    };
  }

  const names = pairs.map((p) => p.name);
  const labeled = pairs.filter((p) => p.industry).length;
  const distinct = new Set(
    pairs.map((p) => (p.industry || "").toLowerCase()).filter(Boolean),
  );
  onEvent?.({
    t: "parsed",
    industry:
      distinct.size > 1
        ? `${distinct.size} industries · ${labeled}/${pairs.length} labeled`
        : pairs.find((p) => p.industry)?.industry || "(resolving…)",
    names,
  });

  const unresolved: string[] = [];
  const hits = await runConcurrent(names, 6, (q) => resolveListingQuery(q));
  type Resolved = {
    query: string;
    industry: string | null;
    ticker: string;
    name: string;
    market: string;
  };
  const resolved: Resolved[] = [];
  const have = new Set<string>();
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    const hit = hits[i];
    if (!hit) {
      unresolved.push(p.name);
      onEvent?.({ t: "miss", query: p.name });
      continue;
    }
    const ticker = hit.ticker.toUpperCase();
    if (have.has(ticker)) {
      onEvent?.({ t: "dup", query: p.name, ticker });
      continue;
    }
    have.add(ticker);
    resolved.push({
      query: p.name,
      industry: p.industry,
      ticker,
      name: hit.name,
      market: hit.market,
    });
    onEvent?.({
      t: "hit",
      query: p.name,
      ticker,
      name: hit.name,
    });
  }
  if (!resolved.length) {
    throw new Error(
      `None of the names resolved: ${names.slice(0, 8).join(", ")}`,
    );
  }

  // Fill blank Industry cells from other rows in the same paste (Screener
  // column is usually constant) — never from Yahoo/NSE taxonomy.
  const pasteMode = voteLabel(
    resolved.map((r) => r.industry || "").filter(Boolean),
  );
  for (const r of resolved) {
    if (r.industry) continue;
    if (pasteMode) r.industry = pasteMode;
  }
  const stillMissing = resolved.filter((r) => !r.industry);
  if (stillMissing.length === resolved.length) {
    throw new Error(INDUSTRY_REQUIRED);
  }

  const byIndustry = new Map<
    string,
    { label: string; members: Array<{ ticker: string; name: string; market: string }> }
  >();
  for (const r of resolved) {
    const label = tidyIndustry(r.industry);
    if (!label) continue;
    const k = label.toLowerCase();
    const cur = byIndustry.get(k) ?? { label, members: [] };
    cur.members.push({
      ticker: r.ticker,
      name: r.name,
      market: r.market,
    });
    byIndustry.set(k, cur);
  }

  const sectors: RotationSector[] = [];
  for (const bag of byIndustry.values()) {
    const prior =
      listRotationSectors().find(
        (s) => s.label.toLowerCase() === bag.label.toLowerCase(),
      )?.members.length ?? 0;
    const sector = mergeRotationSectorByLabel(bag.label, bag.members);
    sectors.push(sector);
    onEvent?.({
      t: "count",
      extracted: pairs.length,
      resolved: bag.members.length,
      unresolved: unresolved.length,
      before: prior,
      after: sector.members.length,
    });
    onEvent?.({ t: "save", label: sector.label, n: sector.members.length });
  }

  if (!sectors.length) {
    throw new Error("No industry baskets to save.");
  }

  sectors.sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
  const primary = sectors[0]!;
  void Promise.all(
    resolved.map(async (m) => {
      try {
        await bootstrapCompanyTicker(m.ticker, {
          name: m.name,
          market: m.market,
        });
      } catch {
        /* optional */
      }
    }),
  ).then(() => invalidateCompanyCache());

  return {
    industry: primary.label,
    names,
    unresolved: [
      ...unresolved,
      ...stillMissing.map((r) => `${r.query} (no industry)`),
    ],
    sector: primary,
    sectors,
  };
}

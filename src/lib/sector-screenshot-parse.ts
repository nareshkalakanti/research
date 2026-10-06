/**
 * Parse a stock-screener screenshot OCR: Name + Industry columns.
 * Client-safe. No issuer lists.
 */
import { flattenOcrHtml } from "./din-screenshot-parse";

export type SectorShotExtract = {
  industry: string | null;
  names: string[];
};

const NOISE =
  /showing\s+\d+\s+results|edit columns|download|^default\b|performance|technical|valuation|holdings|growth|profit\/loss|balance sheet|cash flow|ratios|^chart$|^scores$/i;

const HEADER_NAME = /^(?:#|no\.?|s\.?\s*no\.?|name|stock name|company)$/i;
const HEADER_IND = /^industry$|^sector$|^theme$/i;

function isIndustryHeader(s: string): boolean {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return HEADER_IND.test(t) || /^(market capitalization|close price|name)$/i.test(t);
}

/** Screener Name-column values must not become the sector title. */
function looksIssuerLabel(s: string): boolean {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (LEGAL.test(t)) return true;
  return /\b(?:Ltd|Limited|Plc|LLP)\b/i.test(t) && t.split(/\s+/).length >= 2;
}

export function tidyIndustry(s: string | null): string | null {
  if (!s) return null;
  const t = s
    .replace(/\s+/g, " ")
    .replace(/^(industry|sector)\s*:\s*/i, "")
    .replace(/[.…]+$/g, "")
    .trim();
  if (!t || isIndustryHeader(t) || looksIssuerLabel(t)) return null;
  return t;
}
const PRICEISH =
  /^(?:₹|rs\.?)?\s*[\d,]+(?:\.\d+)?\s*(?:cr|crore)?$/i;
const LEGAL =
  /\b(?:Ltd|Limited|Plc|Inc|LLP|Corp|Corporation|Company)\.?$/i;

function decodeFence(text: string): string {
  return (text || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function allJsonObjects(text: string): Record<string, unknown>[] {
  const raw = decodeFence(text);
  const out: Record<string, unknown>[] = [];
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf("{", i);
    if (start < 0) break;
    const blob = firstJsonObject(raw.slice(start));
    if (!blob) break;
    try {
      const obj = JSON.parse(blob) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        out.push(obj as Record<string, unknown>);
      }
    } catch {
      /* truncated / invalid object */
    }
    i = start + Math.max(1, blob.length);
  }
  return out;
}

function fieldByKey(
  obj: Record<string, unknown>,
  key: RegExp,
): string {
  for (const [k, v] of Object.entries(obj)) {
    const name = k.replace(/\s+/g, " ").trim();
    if (!key.test(name)) continue;
    return String(v ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function keepRecoveredName(s: string): boolean {
  const t = cleanExtractedName(s);
  if (t.length < 5) return false;
  if (/^(industry|names|name|sector|companies)$/i.test(t)) return false;
  const words = t.split(/\s+/);
  if (!looksIssuerLabel(t)) return false;
  return (
    words.length >= 3 ||
    (words.length === 2 && (words[0] || "").length >= 6)
  );
}

function recoverPartialBasket(text: string): SectorShotExtract | null {
  const raw = decodeFence(text);
  const names: string[] = [];
  const industries: string[] = [];
  const indM = raw.match(/"industry"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (indM?.[1]) industries.push(indM[1].replace(/\s+/g, " ").trim());
  for (const m of raw.matchAll(/"Industry"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    if (m[1]) industries.push(m[1].replace(/\s+/g, " ").trim());
  }
  const namesBlock = raw.match(/"names"\s*:\s*\[([\s\S]*?)(?:\]|$)/i);
  if (namesBlock?.[1]) {
    for (const m of namesBlock[1].matchAll(/"((?:\\.|[^"\\])*)"/g)) {
      const s = cleanExtractedName(m[1] || "");
      if (keepRecoveredName(s)) names.push(s);
    }
  }
  const extra: string[] = [];
  for (const i of industries) {
    if (looksIssuerLabel(i)) extra.push(cleanExtractedName(i));
  }
  const uniq = uniqNames([...extra, ...names].filter(keepRecoveredName));
  const industry = tidyIndustry(pickIndustry(industries));
  if (!industry && !uniq.length) return null;
  return { industry, names: uniq };
}

function tryJson(text: string): SectorShotExtract | null {
  const objs = allJsonObjects(text);
  if (!objs.length) return null;
  const names: string[] = [];
  const industries: string[] = [];
  for (const obj of objs) {
    const list = obj.names ?? obj.companies;
    if (Array.isArray(list)) {
      for (const n of list) {
        const s = cleanExtractedName(String(n || ""));
        if (s.length >= 2) names.push(s);
      }
      const bundled = String(obj.industry || obj.sector || "")
        .replace(/\s+/g, " ")
        .trim();
      if (bundled) industries.push(bundled);
      continue;
    }
    const name = cleanExtractedName(fieldByKey(obj, /^(name|company|stock name)$/i));
    const ind = fieldByKey(obj, /^(industry|sector|theme)$/i);
    if (name.length >= 3) names.push(name);
    if (ind) industries.push(ind);
  }
  const uniq = uniqNames(names);
  const industry = tidyIndustry(pickIndustry(industries));
  const extra = industries.filter(looksIssuerLabel).map(cleanExtractedName);
  if (!industry && !uniq.length && !extra.length) return null;
  return {
    industry,
    names: uniqNames([...extra, ...uniq]),
  };
}

function uniqNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function cleanExtractedName(s: string): string {
  return (s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/^\d+\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cellsOf(line: string): string[] {
  return line
    .split(/\t+|\s{2,}|[|│]/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function looksName(s: string): boolean {
  const t = s.replace(/^\d+\s+/, "").trim();
  if (t.length < 3) return false;
  if (/[{}"\[\]]/.test(t)) return false;
  if (HEADER_NAME.test(t) || HEADER_IND.test(t)) return false;
  if (PRICEISH.test(t)) return false;
  if (/^market\s+cap/i.test(t) || /^close\s+price/i.test(t)) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  return true;
}

function nameFromLine(line: string, cells: string[]): string | null {
  const legal = line.match(
    /(?:^|\s)(\d+\s+)?([A-Za-z][A-Za-z0-9 .,&+\uFF06'/-]{2,}(?:Ltd|Limited|Plc|Inc|LLP)\.?)/i,
  );
  if (legal) {
    const n = legal[2]!.replace(/\s+/g, " ").trim();
    if (looksName(n)) return n;
  }
  const first = (cells[0] || "").replace(/^\d+\s+/, "").trim();
  if (looksName(first) && !PRICEISH.test(first)) return first;
  return null;
}

function industryFromCells(
  cells: string[],
  indIdx: number,
): string | null {
  if (indIdx >= 0 && cells[indIdx] && !PRICEISH.test(cells[indIdx]!)) {
    const t = cells[indIdx]!.replace(/\s+/g, " ").trim();
    if (t && !HEADER_IND.test(t) && !HEADER_NAME.test(t)) return t;
  }
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!;
    if (PRICEISH.test(c)) continue;
    if (HEADER_NAME.test(c) || HEADER_IND.test(c)) continue;
    if (/^close/i.test(c) || /^mcap/i.test(c)) continue;
    if (LEGAL.test(c) || looksName(c) && LEGAL.test(c)) continue;
    if (/[A-Za-z]/.test(c) && c.length < 48 && !LEGAL.test(c) && !/^\d/.test(c)) {
      if (cells.indexOf(c) === 0 && LEGAL.test(c)) continue;
      if (i === 0) continue;
      return c.replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

function htmlRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
      (c) =>
        c[1]!
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/\s+/g, " ")
          .trim(),
    );
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

function fromHtml(text: string): SectorShotExtract | null {
  if (!/<t[rdh]|<table/i.test(text || "")) return null;
  const rows = htmlRows(text);
  if (!rows.length) return null;
  let nameIdx = 0;
  let indIdx = -1;
  const names: string[] = [];
  const industries: string[] = [];
  for (const cells of rows) {
    if (
      cells.some((c) => HEADER_NAME.test(c)) &&
      cells.some((c) => HEADER_IND.test(c))
    ) {
      nameIdx = cells.findIndex((c) => HEADER_NAME.test(c));
      indIdx = cells.findIndex((c) => HEADER_IND.test(c));
      continue;
    }
    const name = (cells[nameIdx] || "").replace(/^\d+\s+/, "").trim();
    if (!looksName(name)) continue;
    names.push(name);
    const ind =
      indIdx >= 0 ? (cells[indIdx] || "").trim() : industryFromCells(cells, -1);
    if (ind && ind.toLowerCase() !== name.toLowerCase()) industries.push(ind);
  }
  if (!names.length) return null;
  return { industry: pickIndustry(industries), names: uniqNames(names) };
}

function pickIndustry(industries: string[]): string | null {
  const usable = industries.filter(
    (i) => i && !isIndustryHeader(i) && !looksIssuerLabel(i),
  );
  const counts = new Map<string, number>();
  for (const i of usable) {
    const k = i.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let industry: string | null = null;
  let best = 0;
  for (const i of usable) {
    const n = counts.get(i.toLowerCase()) || 0;
    if (n > best) {
      best = n;
      industry = i;
    }
  }
  return industry;
}

function fromTable(text: string): SectorShotExtract {
  const html = fromHtml(text);
  if (html?.names.length) return html;
  const lines = flattenOcrHtml(decodeFence(text))
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));

  let nameIdx = -1;
  let indIdx = -1;
  const names: string[] = [];
  const industries: string[] = [];

  for (const line of lines) {
    const cells = cellsOf(line);
    const joined = cells.join(" ").toLowerCase();
    if (
      cells.some((c) => HEADER_NAME.test(c)) &&
      cells.some((c) => HEADER_IND.test(c))
    ) {
      nameIdx = cells.findIndex((c) => HEADER_NAME.test(c));
      indIdx = cells.findIndex((c) => HEADER_IND.test(c));
      continue;
    }
    if (/\bname\b/.test(joined) && /\bindustry\b/.test(joined)) {
      nameIdx = cells.findIndex((c) => HEADER_NAME.test(c) || /^name$/i.test(c));
      indIdx = cells.findIndex((c) => HEADER_IND.test(c));
      continue;
    }
    const name =
      nameIdx >= 0 && cells[nameIdx] && looksName(cells[nameIdx]!)
        ? cells[nameIdx]!.replace(/^\d+\s+/, "").trim()
        : nameFromLine(line, cells);
    if (!name) continue;
    names.push(name);
    const ind = industryFromCells(cells, indIdx);
    if (ind && ind.toLowerCase() !== name.toLowerCase()) industries.push(ind);
  }
  return { industry: tidyIndustry(pickIndustry(industries)), names: uniqNames(names) };
}

export function parseSectorScreenshot(text: string): SectorShotExtract {
  const json = tryJson(text);
  const partial = recoverPartialBasket(text);
  const table = fromTable(text);
  const issuerAsName =
    json?.industry && looksIssuerLabel(json.industry)
      ? [json.industry]
      : [];
  const names = uniqNames([
    ...issuerAsName,
    ...(json?.names?.length ? json.names : []),
    ...(json?.names?.length ? [] : partial?.names ?? []),
    ...(json?.names?.length ? [] : table.names),
  ]);
  const industry = tidyIndustry(
    (!json?.industry || looksIssuerLabel(json.industry)
      ? null
      : json.industry) ||
      partial?.industry ||
      table.industry ||
      (text.match(/(?:^|\n)\s*(?:industry|sector)\s*:\s*(.+)$/im)?.[1] ?? null),
  );
  return { industry, names };
}

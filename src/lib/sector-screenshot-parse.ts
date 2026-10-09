/**
 * Parse a stock-screener screenshot OCR: Name + Industry columns.
 * Client-safe. No issuer lists.
 */
import { flattenOcrHtml } from "./din-screenshot-parse";

export type SectorShotExtract = {
  industry: string | null;
  names: string[];
  /** Industry-column cells (not a page heading / parent group). */
  rowIndustries: string[];
};

const NOISE =
  /showing\s+\d+\s+results|edit columns|download|^default\b|performance|technical|valuation|holdings|growth|profit\/loss|balance sheet|cash flow|ratios|^chart$|^scores$|^stock\s+price\s+quote$/i;

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

/**
 * Vision OCR often dumps the Industry column as "X, X, X, …" or "X X X".
 * Collapse to one label (generic — no issuer/sector special cases).
 */
export function collapseRepeatedIndustry(s: string): string {
  let t = (s || "").replace(/\s+/g, " ").trim();
  if (!t) return t;

  const chunks = t
    .split(/\s*[,;|]\s*/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length >= 2) {
    const voted = pickIndustry(chunks);
    if (voted) return voted;
  }

  const lower = t.toLowerCase();
  const maxUnit = Math.min(Math.floor(t.length / 2), 96);
  for (let len = maxUnit; len >= 8; len--) {
    const unit = t.slice(0, len).replace(/[\s,;|/]+$/g, "").trim();
    if (unit.split(/\s+/).length < 2) continue;
    const u = unit.toLowerCase();
    let pos = 0;
    let n = 0;
    while (pos < lower.length) {
      while (pos < lower.length && /[\s,;|/]/.test(lower[pos]!)) pos++;
      if (pos >= lower.length) break;
      if (!lower.startsWith(u, pos)) {
        n = 0;
        break;
      }
      n += 1;
      pos += u.length;
    }
    if (n >= 2 && pos >= lower.length) return unit;
  }
  return t;
}

export function tidyIndustry(s: string | null): string | null {
  if (!s) return null;
  const t = collapseRepeatedIndustry(
    s
      .replace(/\s+/g, " ")
      .replace(/^(industry|sector)\s*:\s*/i, "")
      .replace(/[.…]+$/g, "")
      .trim(),
  );
  if (!t || isIndustryHeader(t) || looksIssuerLabel(t)) return null;
  // Real industry names are short; refuse leftover OCR dumps.
  if (t.length > 96) return null;
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
  if (/[{}"\[\]]/.test(t)) return false;
  if (t.length < 6) return false;
  if (/^(industry|names|name|sector|companies)$/i.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (looksIssuerLabel(t)) {
    return (
      words.length >= 3 ||
      (words.length === 2 && (words[0] || "").length >= 6)
    );
  }
  if (PRICEISH.test(t) || HEADER_NAME.test(t) || HEADER_IND.test(t)) return false;
  const first = words[0] || "";
  if (words.length >= 3 && first.length >= 3 && /^[A-Za-z]/.test(first)) return true;
  return false;
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
  const namesBlock = raw.match(/"names"\s*:\s*\[([\s\S]*)/i);
  if (namesBlock?.[1]) {
    const block = namesBlock[1];
    for (const m of block.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
      const s = cleanExtractedName(m[1] || "");
      if (keepRecoveredName(s)) names.push(s);
    }
    const dangling = block.match(/"((?:\\.|[^"\\])+)$/);
    if (dangling?.[1] && !/[{}\[\]]/.test(dangling[1])) {
      const s = cleanExtractedName(dangling[1]);
      if (keepRecoveredName(s)) names.push(s);
    }
  }
  for (const m of raw.matchAll(/"Name"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gi)) {
    const s = cleanExtractedName(m[1] || "");
    if (keepRecoveredName(s)) names.push(s);
  }
  const extra: string[] = [];
  for (const i of industries) {
    if (looksIssuerLabel(i)) extra.push(cleanExtractedName(i));
  }
  const uniq = uniqNames([...extra, ...names].filter(keepRecoveredName));
  const rowIndustries = industries.filter(
    (i) => i && !isIndustryHeader(i) && !looksIssuerLabel(i),
  );
  const industry = tidyIndustry(pickIndustry(rowIndustries));
  if (!industry && !uniq.length) return null;
  return { industry, names: uniq, rowIndustries };
}

function namesFromNumberedMap(obj: Record<string, unknown>): string[] {
  const pairs: Array<{ i: number; name: string }> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!/^\d{1,2}$/.test(k)) continue;
    if (typeof v !== "string") continue;
    const s = cleanExtractedName(v);
    if (s.length < 3) continue;
    if (!looksIssuerLabel(s) && !keepRecoveredName(s)) continue;
    pairs.push({ i: Number(k), name: s });
  }
  pairs.sort((a, b) => a.i - b.i);
  return pairs.map((p) => p.name);
}

function recoverNumberedJsonNames(text: string): string[] {
  const raw = decodeFence(text);
  const pairs: Array<{ i: number; name: string }> = [];
  const seen = new Set<number>();
  for (const m of raw.matchAll(/"(\d{1,2})"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    const i = Number(m[1]);
    const s = cleanExtractedName((m[2] || "").replace(/\\"/g, '"'));
    if (s.length < 3) continue;
    if (!looksIssuerLabel(s) && !keepRecoveredName(s)) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    pairs.push({ i, name: s });
  }
  const dangling = raw.match(/"(\d{1,2})"\s*:\s*"((?:\\.|[^"\\])+)$/);
  if (dangling?.[1] && dangling[2] && !/[{}\[\]]/.test(dangling[2])) {
    const i = Number(dangling[1]);
    const s = cleanExtractedName(dangling[2].replace(/\\"/g, '"'));
    if (!seen.has(i) && (looksIssuerLabel(s) || keepRecoveredName(s))) {
      pairs.push({ i, name: s });
    }
  }
  pairs.sort((a, b) => a.i - b.i);
  return pairs.map((p) => p.name);
}

function tryJson(text: string): SectorShotExtract | null {
  const objs = allJsonObjects(text);
  if (!objs.length) return null;
  const names: string[] = [];
  const bundled: string[] = [];
  const rowIndustries: string[] = [];
  for (const obj of objs) {
    const list = obj.names ?? obj.companies;
    if (Array.isArray(list)) {
      for (const n of list) {
        const s = cleanExtractedName(String(n || ""));
        if (s.length >= 2) names.push(s);
      }
      const one = String(obj.industry || obj.sector || "")
        .replace(/\s+/g, " ")
        .trim();
      if (one) bundled.push(one);
      continue;
    }
    const numbered = namesFromNumberedMap(obj);
    if (numbered.length >= 2) {
      names.push(...numbered);
      const one = String(obj.industry || obj.sector || "")
        .replace(/\s+/g, " ")
        .trim();
      if (one) bundled.push(one);
      continue;
    }
    const name = cleanExtractedName(fieldByKey(obj, /^(name|company|stock name)$/i));
    const ind = fieldByKey(obj, /^(industry|sector|theme)$/i);
    if (name.length >= 3) names.push(name);
    if (ind) rowIndustries.push(ind);
  }
  const uniq = uniqNames(names);
  const extra = [...bundled, ...rowIndustries]
    .filter(looksIssuerLabel)
    .map(cleanExtractedName);
  const voted = tidyIndustry(pickIndustry(rowIndustries));
  const fallback = tidyIndustry(pickIndustry(bundled));
  if (!voted && !fallback && !uniq.length && !extra.length) return null;
  return {
    industry: voted || fallback,
    names: uniqNames([...extra, ...uniq]),
    rowIndustries,
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
  if (NOISE.test(t)) return false;
  if (PRICEISH.test(t)) return false;
  if (/^market\s+cap/i.test(t) || /^close\s+price/i.test(t)) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  return true;
}

function nameFromLine(line: string, cells: string[]): string | null {
  const stripped = line.replace(/^\s*\d+\s+/, "").trim();
  const legal = stripped.match(
    /^([A-Za-z][A-Za-z0-9 .,&+\uFF06'()/-]{2,}(?:Ltd|Limited|Plc|Inc|LLP)\.?)/i,
  );
  if (legal) {
    const n = legal[1]!.replace(/\s+/g, " ").trim();
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
  const rowIndustries = industries.filter(
    (i) => i && !isIndustryHeader(i) && !looksIssuerLabel(i),
  );
  return {
    industry: pickIndustry(rowIndustries),
    names: uniqNames(names),
    rowIndustries,
  };
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
    if (/[{}\[\]]/.test(line) && /"/.test(line)) continue;
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
  return {
    industry: tidyIndustry(pickIndustry(industries)),
    names: uniqNames(names),
    rowIndustries: industries.filter(
      (i) => i && !isIndustryHeader(i) && !looksIssuerLabel(i),
    ),
  };
}

function numberedNames(text: string): string[] {
  const out: string[] = [];
  for (const line of (text || "").split(/\n/)) {
    const m = line.match(
      /^\s*\d{1,2}\s+([A-Za-z][A-Za-z0-9 .,&'()+/-]{2,}?\b(?:Ltd|Limited)\.?)\s*$/i,
    );
    if (!m?.[1]) continue;
    const s = cleanExtractedName(m[1]);
    if (s.split(/\s+/).filter(Boolean).length >= 2) out.push(s);
  }
  return out;
}

/** Quote tables: issuer + 5–7 digit BSE scrip, often without Ltd. */
function namesFromScripRows(text: string): string[] {
  const out: string[] = [];
  for (const line of (text || "").split(/\n/)) {
    const m = line.match(
      /^\s*(?:\d{1,2}[.)]\s+)?([A-Za-z][A-Za-z0-9 .,&'()+/-]{2,}?)\s+(\d{5,7})(?!\s*(?:Cr|Crore|\.\d))/i,
    );
    if (!m?.[1] || !m[2]) continue;
    const name = cleanExtractedName(m[1]);
    if (/[₹{}"\[\]]/.test(name) || PRICEISH.test(name)) continue;
    if (name.split(/\s+/).filter(Boolean).length < 2) continue;
    if (name.length > 80) continue;
    out.push(name);
    out.push(m[2]);
  }
  return out;
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
    ...(json?.names ?? []),
    ...(partial?.names ?? []),
    ...(table.names ?? []),
    ...numberedNames(text),
    ...namesFromScripRows(text),
    ...recoverNumberedJsonNames(text),
  ]);
  const rowIndustries = [
    ...(json?.rowIndustries ?? []),
    ...(partial?.rowIndustries ?? []),
    ...(table.rowIndustries ?? []),
  ];
  const fromRows = tidyIndustry(pickIndustry(rowIndustries));
  const bundled = tidyIndustry(
    !json?.industry || looksIssuerLabel(json.industry) ? null : json.industry,
  );
  const industry = tidyIndustry(
    fromRows ||
      bundled ||
      partial?.industry ||
      table.industry ||
      (text.match(/(?:^|\n)\s*(?:industry|sector)\s*:\s*(.+)$/im)?.[1] ?? null),
  );
  return { industry, names, rowIndustries };
}

/** Same parent prefix, different leaf (Capital Goods Switchgear vs Transformers). */
export function areSiblingIndustryLeaves(prior: string, next: string): boolean {
  const aw = (prior || "").replace(/\s+/g, " ").trim().toLowerCase().split(/\s+/);
  const bw = (next || "").replace(/\s+/g, " ").trim().toLowerCase().split(/\s+/);
  if (aw.length < 2 || bw.length < 2) return false;
  const aTail = aw[aw.length - 1]!;
  const bTail = bw[bw.length - 1]!;
  const aHead = aw.slice(0, -1).join(" ");
  const bHead = bw.slice(0, -1).join(" ");
  return Boolean(aHead && aHead === bHead && aTail !== bTail);
}

/**
 * Same Capital Goods / Auto prefix but different leaf
 * (Transformers vs Switchgear) — treat as different industries.
 */
export function industriesCompatible(prior: string, next: string): boolean {
  const a = (prior || "").replace(/\s+/g, " ").trim().toLowerCase();
  const b = (next || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!a || !b) return true;
  if (a === b) return true;
  if (areSiblingIndustryLeaves(a, b)) return false;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

/**
 * Later pages in a multi-screenshot batch often OCR a parent group instead of
 * the Industry column. Keep a prior leaf over a parent; never keep a prior
 * sibling leaf (Switchgear must not absorb Transformers).
 */
export function preferBatchIndustry(prior: string, next: string): string {
  const a = (prior || "").replace(/\s+/g, " ").trim();
  const b = (next || "").replace(/\s+/g, " ").trim();
  if (!a) return b;
  if (!b) return a;
  if (a.toLowerCase() === b.toLowerCase()) return b;
  if (areSiblingIndustryLeaves(a, b)) return b;
  const aw = a.split(/\s+/).length;
  const bw = b.split(/\s+/).length;
  if (aw >= 2 && bw === 1) return a;
  if (bw >= 2 && aw === 1) return b;
  if (b.toLowerCase().includes(a.toLowerCase()) && b.length > a.length) return b;
  if (a.toLowerCase().includes(b.toLowerCase()) && a.length > b.length) return a;
  return b;
}

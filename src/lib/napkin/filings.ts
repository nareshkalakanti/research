/**
 * Exchange filing discovery for Napkin. No Qwen. No issuer forks.
 * Newest-first. Outcome PDFs are results, not concalls.
 */

import {
  discoverBseInvestorMaterialSources,
  getCachedBseScripCode,
} from "@/lib/bse-investor-discover";
import { nseHttp1Fetch } from "@/lib/nse-http";
import { parseNseDateTime } from "@/lib/nse-corp-events";
import { formatNseApiDateFromInstant, istCivilDayToUtcNoon, istRangeDaysBack } from "@/lib/nse-time";
import { napkinLog } from "./log";
import type { NapkinStepEvent } from "./progress";
import { NAPKIN_DOC_SLOTS } from "./doc-collection";
import { listInvestorMaterials } from "@/lib/investor-materials";

export type NapkinDocType =
  | "RESULT"
  | "ANNUAL_REPORT"
  | "INVESTOR_PRESENTATION"
  | "CONCALL_TRANSCRIPT"
  | "CORPORATE_ANNOUNCEMENT"
  | "OTHER";

export type NapkinFilingRow = {
  document_title: string;
  document_type: NapkinDocType;
  date: string | null;
  source: string;
  url: string;
  picked?: boolean;
};

const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    return url.split("/").pop() || "";
  }
}

/** Generic classifier: filename + title. Outcome ≠ transcript. */
export function classifyFiling(title: string, url: string): NapkinDocType {
  const file = fileName(url);
  const blob = `${title} ${file}`.replace(/[_-]+/g, " ");

  const transcript =
    /transcript/i.test(blob) ||
    (/(?:con\s*call|conference\s+call|earnings?\s+call)/i.test(blob) &&
      /transcript|verbatim/i.test(blob));
  const outcome = /\boutcome\b/i.test(blob);
  if (transcript && !outcome) return "CONCALL_TRANSCRIPT";

  if (
    /investors?\s+presentation|earnings\s+presentation|analyst\s+presentation|\bipp?\b|\.pptx?$/i.test(
      blob,
    )
  ) {
    return "INVESTOR_PRESENTATION";
  }
  if (/annual\s+report|board\s+report/i.test(blob)) return "ANNUAL_REPORT";
  if (
    outcome ||
    /financial\s+results?|quarterly\s+results?|unaudited|audited\s+financial|earnings\s+release/i.test(
      blob,
    )
  ) {
    return "RESULT";
  }
  if (/nsearchives\.nseindia|nseindia\.com|bseindia\.com/i.test(url)) {
    return "CORPORATE_ANNOUNCEMENT";
  }
  return "OTHER";
}

type NseAnnRow = Record<string, unknown>;
type OnStep = (ev: NapkinStepEvent) => void;
type OnFilings = (rows: NapkinFilingRow[]) => void;

const NSE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NSE_HOME = "https://www.nseindia.com/";
const SESSION_MS = 25_000;
const ANN_MS = 15_000;

async function nseGet(
  url: string,
  jar: { cookie: string },
  referer: string,
  timeoutMs: number,
): Promise<Response> {
  return nseHttp1Fetch(url, {
    jar,
    headers: {
      "User-Agent": NSE_UA,
      Accept: "application/json,text/html,*/*",
      Referer: referer,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
}

async function nseSession(): Promise<{ cookie: string }> {
  const jar = { cookie: "" };
  await nseGet(NSE_HOME, jar, NSE_HOME, SESSION_MS);
  await nseGet(NSE_ANN_REF, jar, NSE_HOME, SESSION_MS);
  return jar;
}

async function fetchNseWindow(
  symbol: string,
  index: "equities" | "sme",
  from: Date,
  to: Date,
  jar: { cookie: string },
): Promise<NseAnnRow[]> {
  const u = new URL(CORP_ANN_URL);
  u.searchParams.set("index", index);
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("from_date", formatNseApiDateFromInstant(from));
  u.searchParams.set("to_date", formatNseApiDateFromInstant(to));
  const res = await nseGet(u.toString(), jar, NSE_ANN_REF, ANN_MS);
  if (!res.ok) return [];
  const rows = (await res.json()) as unknown;
  return Array.isArray(rows) ? (rows as NseAnnRow[]) : [];
}

async function nseRows(symbol: string, onStep?: OnStep): Promise<NseAnnRow[]> {
  const t0 = Date.now();
  onStep?.({
    id: "nse_session",
    status: "running",
    label: "NSE session",
    detail: "Cookie handshake",
  });
  let jar: { cookie: string };
  try {
    jar = await nseSession();
    onStep?.({
      id: "nse_session",
      status: "done",
      label: "NSE session",
      detail: jar.cookie ? "ok" : "no cookies",
      ms: Date.now() - t0,
    });
  } catch (e) {
    onStep?.({
      id: "nse_session",
      status: "fail",
      label: "NSE session",
      detail: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    });
    onStep?.({
      id: "nse_anns",
      status: "skip",
      label: "NSE filings",
      detail: "Skipped — no NSE session",
    });
    return [];
  }

  const t1 = Date.now();
  onStep?.({
    id: "nse_anns",
    status: "running",
    label: "NSE filings",
    detail: `${symbol} equities, 180d`,
  });
  const { from, to } = istRangeDaysBack(180);
  const fromD = istCivilDayToUtcNoon(from);
  const toD = istCivilDayToUtcNoon(to);
  const out: NseAnnRow[] = [];
  const seen = new Set<string>();
  for (const index of ["equities", "sme"] as const) {
    try {
      onStep?.({
        id: "nse_anns",
        status: "running",
        label: "NSE filings",
        detail: `${symbol} ${index}`,
      });
      for (const row of await fetchNseWindow(symbol, index, fromD, toD, jar)) {
        const seq = str(row.seq_id) || str(row.attchmntFile);
        if (seq && seen.has(seq)) continue;
        if (seq) seen.add(seq);
        out.push(row);
      }
      if (out.length) break;
    } catch (e) {
      napkinLog("nse anns fail", {
        symbol,
        index,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  onStep?.({
    id: "nse_anns",
    status: out.length ? "done" : "fail",
    label: "NSE filings",
    detail: `${out.length} raw rows`,
    ms: Date.now() - t1,
  });
  return out;
}

function fromNse(row: NseAnnRow): NapkinFilingRow | null {
  const url = str(row.attchmntFile);
  if (!url.startsWith("http") || url.endsWith("/-")) return null;
  const title = str(row.desc) || str(row.attchmntText) || fileName(url);
  const dt = parseNseDateTime(row.an_dt || row.sort_date || row.dt);
  return {
    document_title: title,
    document_type: classifyFiling(title, url),
    date: dt,
    source: "NSE",
    url,
  };
}

function fromBseHit(hit: {
  title: string;
  url: string;
  announced_at: string | null;
}): NapkinFilingRow {
  return {
    document_title: hit.title,
    document_type: classifyFiling(hit.title, hit.url),
    date: hit.announced_at,
    source: "BSE",
    url: hit.url,
  };
}

function sortNewest(a: NapkinFilingRow, b: NapkinFilingRow): number {
  const at = a.date ? Date.parse(a.date) : 0;
  const bt = b.date ? Date.parse(b.date) : 0;
  return bt - at;
}

async function bseRows(
  symbol: string,
  onStep?: OnStep,
): Promise<NapkinFilingRow[]> {
  const scrip = getCachedBseScripCode(symbol);
  const tB = Date.now();
  if (!scrip) {
    onStep?.({
      id: "bse",
      status: "skip",
      label: "BSE",
      detail: "No cached BSE scrip",
    });
    return [];
  }
  onStep?.({
    id: "bse",
    status: "running",
    label: "BSE fallback",
    detail: `scrip ${scrip}`,
  });
  try {
    const bse = await discoverBseInvestorMaterialSources(symbol, scrip, new Set());
    const rows = bse.map(fromBseHit);
    onStep?.({
      id: "bse",
      status: rows.length ? "done" : "fail",
      label: "BSE",
      detail: `${rows.length} docs`,
      ms: Date.now() - tB,
    });
    return rows;
  } catch (e) {
    onStep?.({
      id: "bse",
      status: "fail",
      label: "BSE",
      detail: e instanceof Error ? e.message : String(e),
      ms: Date.now() - tB,
    });
    return [];
  }
}

/** Newest of each research-useful type. Newest filing is not assumed to be a concall. */
export function pickNapkinFilings(rows: NapkinFilingRow[]): NapkinFilingRow[] {
  const sorted = [...rows].sort(sortNewest);
  const out: NapkinFilingRow[] = [];
  const used = new Set<string>();
  for (const slot of NAPKIN_DOC_SLOTS) {
    const hits = sorted.filter(
      (r) => r.document_type === slot.kind && !used.has(r.url),
    );
    for (const hit of hits.slice(0, slot.take)) {
      used.add(hit.url);
      out.push({ ...hit, picked: true });
    }
  }
  return out;
}

export function pickConcallTranscripts(
  rows: NapkinFilingRow[],
  limit = 8,
): NapkinFilingRow[] {
  return [...rows]
    .filter((r) => r.document_type === "CONCALL_TRANSCRIPT")
    .sort(sortNewest)
    .slice(0, Math.max(0, limit));
}

function markPicked(rows: NapkinFilingRow[], picked: NapkinFilingRow[]): NapkinFilingRow[] {
  const urls = new Set(picked.map((p) => p.url));
  return rows.map((r) => ({ ...r, picked: urls.has(r.url) }));
}

function fileKey(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
    return name.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Prefer earlier sources (NSE, then BSE, then IR). Same URL or same PDF name = one row. */
export function dedupeNapkinFilings(parts: NapkinFilingRow[][]): NapkinFilingRow[] {
  const seenUrl = new Set<string>();
  const seenFile = new Set<string>();
  const out: NapkinFilingRow[] = [];
  for (const part of parts) {
    for (const row of part) {
      const url = row.url.toLowerCase();
      const file = fileKey(row.url);
      if (seenUrl.has(url) || (file && seenFile.has(file))) continue;
      seenUrl.add(url);
      if (file) seenFile.add(file);
      out.push(row);
    }
  }
  out.sort(sortNewest);
  return out.slice(0, 40);
}

export function qwenFilingPack(rows: NapkinFilingRow[]): NapkinFilingRow[] {
  const picked = pickNapkinFilings(rows);
  const calls = pickConcallTranscripts(rows, 8);
  return dedupeNapkinFilings([picked, calls]);
}

function irRows(symbol: string, onStep?: OnStep): NapkinFilingRow[] {
  const t0 = Date.now();
  onStep?.({
    id: "ir",
    status: "running",
    label: "Company IR",
  });
  try {
    const rows: NapkinFilingRow[] = [];
    for (const m of listInvestorMaterials(symbol)) {
      const url = (m.source_url || "").trim();
      if (!url.startsWith("http")) continue;
      rows.push({
        document_title: m.title || fileName(url),
        document_type: classifyFiling(m.title || "", url),
        date: m.period,
        source: "IR",
        url,
      });
    }
    onStep?.({
      id: "ir",
      status: rows.length ? "done" : "skip",
      label: "Company IR",
      detail: rows.length ? `${rows.length} stored IR docs` : "None stored",
      ms: Date.now() - t0,
    });
    return rows;
  } catch (e) {
    onStep?.({
      id: "ir",
      status: "skip",
      label: "Company IR",
      detail: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    });
    return [];
  }
}

export async function listNapkinFilings(
  ticker: string,
  onStep?: OnStep,
  onFilings?: OnFilings,
): Promise<NapkinFilingRow[]> {
  const symbol = ticker.trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
  if (!symbol) return [];

  const nseRaw = await nseRows(symbol, onStep);
  const nse = nseRaw.map(fromNse).filter(Boolean) as NapkinFilingRow[];
  if (nse.length) onFilings?.(dedupeNapkinFilings([nse]));

  const bse = await bseRows(symbol, onStep);
  if (nse.length || bse.length) onFilings?.(dedupeNapkinFilings([nse, bse]));

  const ir = irRows(symbol, onStep);

  onStep?.({
    id: "classify",
    status: "running",
    label: "Classify · dedupe · pick",
  });
  const merged = dedupeNapkinFilings([nse, bse, ir]);
  const picked = pickNapkinFilings(merged);
  const tagged = markPicked(merged, picked);
  onStep?.({
    id: "classify",
    status: "done",
    label: "Classify · dedupe · pick",
    detail: `${tagged.length} after dedupe · ${picked.length} picked`,
  });
  onFilings?.(tagged);
  return tagged;
}

/**
 * Napkin context extras (not Analyse math): corp actions, other-income %,
 * promoter trend, operating cash flow, optional analyst consensus.
 * Sources: Upstox Analytics (free) + IndianAPI when key present.
 */
import {
  isinForTicker,
  upstoxConfigured,
  upstoxGet,
} from "@/lib/upstox-fundamentals";
import type { NapkinCorpAction, NapkinExtras, NapkinPromoterPoint } from "./extras-types";

export type { NapkinCorpAction, NapkinExtras, NapkinPromoterPoint } from "./extras-types";

type PeriodVal = { period: string; value: number };

function num(v: unknown): number | null {
  if (v == null || v === "" || v === "-") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function historyFromCategory(
  rows: Array<{ category?: string; history?: Array<{ period?: string; value?: number }> }> | undefined,
  category: string,
): PeriodVal[] {
  const cat = (rows || []).find((c) => c.category === category);
  const out: PeriodVal[] = [];
  for (const h of cat?.history || []) {
    if (!h.period || h.value == null || !Number.isFinite(h.value)) continue;
    out.push({ period: h.period, value: h.value });
  }
  return out;
}

function lineSeries(
  full: Array<{ particular?: string; history?: Array<{ period?: string; value?: number }> }> | undefined,
  particular: string,
): PeriodVal[] {
  const row = (full || []).find((x) => (x.particular || "").trim() === particular);
  const out: PeriodVal[] = [];
  for (const h of row?.history || []) {
    if (!h.period || h.value == null || !Number.isFinite(h.value)) continue;
    out.push({ period: h.period, value: h.value });
  }
  return out;
}

function parseYear(period: string): number | null {
  const m = /(\d{4})\s*$/.exec(period.trim());
  return m ? Number(m[1]) : null;
}

function periodsFresh(periods: string[]): boolean {
  const years = periods.map(parseYear).filter((y): y is number => y != null);
  if (!years.length) return false;
  const latest = Math.max(...years);
  const now = new Date();
  const fyNow = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return latest >= fyNow - 1;
}

type IncomePayload = {
  income_statement?: Array<{ category?: string; history?: Array<{ period?: string; value?: number }> }>;
  full_statement?: Array<{ particular?: string; history?: Array<{ period?: string; value?: number }> }>;
};

async function fetchIncome(isin: string, type: "consolidated" | "standalone"): Promise<IncomePayload | null> {
  try {
    return (await upstoxGet(`/${encodeURIComponent(isin)}/income-statement`, {
      type,
      time_period: "yearly",
      fs: "true",
    })) as IncomePayload;
  } catch {
    return null;
  }
}

async function pickIncome(isin: string): Promise<{ data: IncomePayload; type: string } | null> {
  const cons = await fetchIncome(isin, "consolidated");
  const consRev = cons ? historyFromCategory(cons.income_statement, "revenue") : [];
  if (cons && consRev.length && periodsFresh(consRev.map((r) => r.period))) {
    return { data: cons, type: "consolidated" };
  }
  const stand = await fetchIncome(isin, "standalone");
  const standRev = stand ? historyFromCategory(stand.income_statement, "revenue") : [];
  if (stand && standRev.length) return { data: stand, type: "standalone" };
  if (cons && consRev.length) return { data: cons, type: "consolidated" };
  return null;
}

async function pickCashFlow(isin: string) {
  for (const type of ["consolidated", "standalone"] as const) {
    try {
      const data = (await upstoxGet(`/${encodeURIComponent(isin)}/cash-flow`, {
        type,
        fs: "true",
      })) as {
        cash_flow?: Array<{ category?: string; history?: Array<{ period?: string; value?: number }> }>;
      };
      const op = historyFromCategory(data.cash_flow, "operating");
      if (op.length && periodsFresh(op.map((r) => r.period))) return op;
      if (type === "standalone" || op.length) return op;
    } catch {
      /* next */
    }
  }
  return [] as PeriodVal[];
}

function ocfTrend(ocf: PeriodVal[]): "rising" | "falling" | "flat" | null {
  if (ocf.length < 2) return null;
  const a = ocf[0]!.value;
  const b = ocf[Math.min(2, ocf.length - 1)]!.value;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = a - b;
  const scale = Math.max(Math.abs(b), 1);
  if (Math.abs(diff) / scale < 0.05) return "flat";
  return diff > 0 ? "rising" : "falling";
}

/** Same event from Upstox vs IndianAPI often differs on ratio/amount text. */
function actionKey(a: NapkinCorpAction): string {
  const kind = a.name.toLowerCase();
  const day = a.expiry_date || "";
  // One split/bonus/rights per ex-date. Dividends: same day can have interim + special.
  if (kind === "dividend") {
    const amt = a.amount != null && a.amount !== 0 ? String(a.amount) : "";
    return `${kind}|${day}|${amt}`;
  }
  return `${kind}|${day}`;
}

/** Prefer the richer of two records for the same event. */
function preferAction(a: NapkinCorpAction, b: NapkinCorpAction): NapkinCorpAction {
  const score = (x: NapkinCorpAction): number => {
    let s = 0;
    if (x.detail) s += 2;
    if (x.ratio) s += 2;
    // Face-value "10→2" reads clearer than "2:10" for splits.
    if (x.ratio && /→/.test(x.ratio)) s += 2;
    if (x.amount != null && x.amount !== 0) s += 1;
    // Prefer IndianAPI for structural (bonus/split); Upstox for cash dividends.
    if (/^(bonus|split|rights)$/i.test(x.name) && x.source === "indianapi") s += 1;
    if (/^dividend$/i.test(x.name) && x.source === "upstox") s += 1;
    return s;
  };
  return score(a) >= score(b) ? a : b;
}

function cleanAction(a: NapkinCorpAction): NapkinCorpAction {
  // Upstox often sends amount: 0 on splits — drop so we don't show ₹0.
  const amount = a.amount != null && a.amount !== 0 ? a.amount : null;
  return { ...a, amount };
}

/** Parse "14 Oct 2026" / "2026-10-14" for sort (newest first). */
function actionSortMs(date: string | null): number {
  if (!date) return 0;
  const t = Date.parse(date);
  if (Number.isFinite(t)) return t;
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(date.trim());
  if (!m) return 0;
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const mo = months[m[2]!];
  if (mo == null) return 0;
  return Date.UTC(Number(m[3]), mo, Number(m[1]));
}

function fmtIsoDate(raw: string | null | undefined): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return s;
  return `${Number(m[3])} ${months[mo]} ${m[1]}`;
}

function ratioFromRemarks(remarks: string | null | undefined): string | null {
  const t = (remarks || "").trim();
  if (!t) return null;
  const m = /ratio\s+of\s+(\d+\s*:\s*\d+)/i.exec(t) || /\b(\d+\s*:\s*\d+)\b/.exec(t);
  return m ? m[1]!.replace(/\s+/g, "") : null;
}

async function corpActionsUpstox(isin: string): Promise<NapkinCorpAction[]> {
  try {
    const data = (await upstoxGet(`/${encodeURIComponent(isin)}/corporate-actions`)) as Array<{
      name?: string;
      expiry_date?: string;
      amount?: number;
      ratio?: string | null;
      event_details?: Array<{ name?: string; value?: string }>;
    }> | null;
    const out: NapkinCorpAction[] = [];
    for (const e of data || []) {
      const detail =
        e.event_details?.find((d) => /details/i.test(d.name || ""))?.value ||
        e.event_details?.find((d) => /dividend type|type/i.test(d.name || ""))?.value ||
        null;
      const ratioRaw =
        (e.ratio && String(e.ratio).trim()) ||
        e.event_details?.find((d) => /ratio/i.test(d.name || ""))?.value ||
        null;
      out.push({
        name: (e.name || "Action").trim(),
        expiry_date: e.expiry_date?.trim() || null,
        amount: num(e.amount),
        ratio: ratioRaw ? String(ratioRaw).replace(/\s+/g, "") : null,
        detail,
        source: "upstox",
      });
    }
    return out;
  } catch {
    return [];
  }
}

type IndianStockBody = {
  analystView?: Array<{ ratingName?: string; numberOfAnalystsLatest?: string | number }>;
  recosBar?: { stockAnalyst?: Array<{ ratingName?: string; numberOfAnalysts?: number }> };
  stockCorporateActionData?: {
    dividend?: Array<{
      remarks?: string;
      xdDate?: string;
      recordDate?: string;
      sortDate?: string;
      value?: number;
      interimOrFinal?: string;
    }>;
    bonus?: Array<{
      remarks?: string;
      xbDate?: string;
      recordDate?: string;
      sortDate?: string;
    }>;
    rights?: Array<{
      remarks?: string;
      xrDate?: string;
      recordDate?: string;
      sortDate?: string;
      value?: number;
    }>;
    splits?: Array<{
      remarks?: string;
      xsDate?: string;
      recordDate?: string;
      sortDate?: string;
      oldFaceValue?: number;
      newFaceValue?: number;
    }>;
  };
};

/** One IndianAPI /stock fetch (corp actions + analyst). */
async function fetchIndianStock(ticker: string): Promise<IndianStockBody | null> {
  const key = (process.env.STOCK_PRICE_API_KEY || "").trim();
  if (!key) return null;
  try {
    const res = await fetch(
      `https://stock.indianapi.in/stock?name=${encodeURIComponent(ticker)}`,
      { headers: { "X-Api-Key": key }, cache: "no-store" },
    );
    if (!res.ok) return null;
    return (await res.json()) as IndianStockBody;
  } catch {
    return null;
  }
}

/** Dividends, bonus, rights, splits — skips AGM / board meetings. */
function corpActionsFromIndian(body: IndianStockBody | null): NapkinCorpAction[] {
  const d = body?.stockCorporateActionData;
  if (!d) return [];
  const out: NapkinCorpAction[] = [];

  for (const e of d.dividend || []) {
    out.push({
      name: "Dividend",
      expiry_date: fmtIsoDate(e.xdDate || e.sortDate || e.recordDate),
      amount: num(e.value),
      ratio: null,
      detail: (e.remarks || e.interimOrFinal || "").trim() || null,
      source: "indianapi",
    });
  }
  for (const e of d.bonus || []) {
    const rem = (e.remarks || "").trim();
    out.push({
      name: "Bonus",
      expiry_date: fmtIsoDate(e.xbDate || e.sortDate || e.recordDate),
      amount: null,
      ratio: ratioFromRemarks(rem),
      detail: rem || null,
      source: "indianapi",
    });
  }
  for (const e of d.rights || []) {
    const rem = (e.remarks || "").trim();
    out.push({
      name: "Rights",
      expiry_date: fmtIsoDate(e.xrDate || e.sortDate || e.recordDate),
      amount: num(e.value),
      ratio: ratioFromRemarks(rem),
      detail: rem || null,
      source: "indianapi",
    });
  }
  for (const e of d.splits || []) {
    const rem = (e.remarks || "").trim();
    const fv =
      e.oldFaceValue != null && e.newFaceValue != null
        ? `${e.oldFaceValue}→${e.newFaceValue}`
        : null;
    out.push({
      name: "Split",
      expiry_date: fmtIsoDate(e.xsDate || e.sortDate || e.recordDate),
      amount: null,
      ratio: fv || ratioFromRemarks(rem),
      detail: rem || fv,
      source: "indianapi",
    });
  }
  return out;
}

/** Merge Upstox + IndianAPI; one row per event (dedupe split/bonus on ex-date). */
export function mergeCorpActions(
  up: NapkinCorpAction[],
  indian: NapkinCorpAction[],
): NapkinCorpAction[] {
  const byKey = new Map<string, NapkinCorpAction>();
  for (const raw of [...indian, ...up]) {
    const a = cleanAction(raw);
    const k = actionKey(a);
    const prev = byKey.get(k);
    byKey.set(k, prev ? preferAction(prev, a) : a);
  }
  const cutoff = Date.now() - 3 * 365.25 * 24 * 3600 * 1000; // ~3Y — latest only
  return [...byKey.values()]
    .filter((a) => {
      const ms = actionSortMs(a.expiry_date);
      return ms === 0 || ms >= cutoff;
    })
    .sort((a, b) => actionSortMs(b.expiry_date) - actionSortMs(a.expiry_date))
    .slice(0, 4);
}

async function promoterHistory(isin: string): Promise<NapkinPromoterPoint[]> {
  try {
    const data = (await upstoxGet(`/${encodeURIComponent(isin)}/share-holdings`)) as Array<{
      category?: string;
      history?: Array<{ period?: string; value?: number }>;
    }> | null;
    const prom = (data || []).find((c) => /promoter/i.test(c.category || ""));
    const out: NapkinPromoterPoint[] = [];
    for (const h of prom?.history || []) {
      if (!h.period || h.value == null || !Number.isFinite(h.value)) continue;
      out.push({ period: h.period, pct: h.value });
    }
    return out;
  } catch {
    return [];
  }
}

/** Analyst consensus — only when ≥5 analysts cover the name. */
function analystFromIndian(body: IndianStockBody | null): NapkinExtras["analyst"] {
  if (!body) return null;
  const rows =
    body.recosBar?.stockAnalyst?.map((r) => ({
      name: (r.ratingName || "").trim(),
      n: Number(r.numberOfAnalysts) || 0,
    })) ||
    body.analystView?.map((r) => ({
      name: (r.ratingName || "").trim(),
      n: Number(r.numberOfAnalystsLatest) || 0,
    })) ||
    [];
  if (!rows.length) return null;
  let buy = 0;
  let hold = 0;
  let sell = 0;
  for (const r of rows) {
    const n = r.n;
    if (/strong\s*buy|^buy$/i.test(r.name)) buy += n;
    else if (/hold|neutral/i.test(r.name)) hold += n;
    else if (/sell/i.test(r.name)) sell += n;
  }
  const total = buy + hold + sell;
  if (total < 5) return null;
  let consensus = "Hold";
  if (buy >= hold && buy >= sell && buy / total >= 0.45) {
    consensus = buy > hold * 1.5 ? "Buy" : "Lean Buy";
  } else if (sell >= hold && sell >= buy && sell / total >= 0.45) {
    consensus = "Sell";
  } else if (hold >= buy && hold >= sell) {
    consensus = "Hold";
  }
  return { consensus, buy, hold, sell, total, source: "indianapi" };
}

function emptyExtras(ticker: string): NapkinExtras {
  return {
    ticker: ticker.toUpperCase(),
    isin: null,
    source: "none",
    other_income_pct: null,
    other_income_period: null,
    promoter: [],
    promoter_delta_pp: null,
    ocf: [],
    ocf_trend: null,
    corp_actions: [],
    analyst: null,
  };
}

/** Build Napkin extras for one ticker (Upstox + optional IndianAPI). */
export async function buildNapkinExtras(ticker: string): Promise<NapkinExtras> {
  const t = ticker.trim().toUpperCase();
  const out = emptyExtras(t);
  const isin = isinForTicker(t);
  out.isin = isin;

  const indianP = fetchIndianStock(t);

  if (!upstoxConfigured() || !isin) {
    const indian = await indianP;
    out.corp_actions = mergeCorpActions([], corpActionsFromIndian(indian));
    out.analyst = analystFromIndian(indian);
    out.source =
      out.corp_actions.length || out.analyst ? "indianapi" : "none";
    return out;
  }

  // Sequential Upstox (shared throttle); IndianAPI in parallel.
  const incPack = await pickIncome(isin).catch(() => null);
  const ocf = await pickCashFlow(isin).catch(() => [] as PeriodVal[]);
  const prom = await promoterHistory(isin);
  const [upActions, indian] = await Promise.all([
    corpActionsUpstox(isin),
    indianP,
  ]);

  out.ocf = ocf.slice(0, 4).map((r) => ({ period: r.period, value: r.value }));
  out.ocf_trend = ocfTrend(ocf);
  out.promoter = prom.slice(0, 8);
  if (prom.length >= 2) {
    const newest = prom[0]!.pct;
    const older = prom[Math.min(prom.length - 1, 4)]!.pct;
    out.promoter_delta_pp = Math.round((newest - older) * 100) / 100;
  }
  const indianActions = corpActionsFromIndian(indian);
  out.corp_actions = mergeCorpActions(upActions, indianActions);
  out.analyst = analystFromIndian(indian);

  if (incPack?.data) {
    const other = lineSeries(incPack.data.full_statement, "Other Income");
    const totalRev = lineSeries(incPack.data.full_statement, "Total Revenue");
    const revFallback = historyFromCategory(incPack.data.income_statement, "revenue");
    const period = other[0]?.period || totalRev[0]?.period || revFallback[0]?.period || null;
    const oi = other[0]?.value ?? null;
    const tr =
      totalRev.find((r) => r.period === period)?.value ??
      revFallback.find((r) => r.period === period)?.value ??
      totalRev[0]?.value ??
      revFallback[0]?.value ??
      null;
    if (oi != null && tr != null && tr > 0) {
      out.other_income_pct = Math.round((oi / tr) * 10000) / 100;
      out.other_income_period = period;
    }
  }

  const usedIndian = Boolean(out.analyst) || indianActions.length > 0;
  out.source = ["upstox", usedIndian ? "indianapi" : null]
    .filter(Boolean)
    .join("+");
  return out;
}

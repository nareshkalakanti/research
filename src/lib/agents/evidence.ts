import fs from "fs";
import path from "path";
import YahooFinance from "yahoo-finance2";
import { loadAllCompanies } from "@/lib/db";
import { edgeTickerSet, loadEdge } from "@/lib/edge";
import { holdingsTickerSet, loadHoldings } from "@/lib/holdings";
import { capTier } from "@/lib/types";
import { toYfinanceSymbol } from "@/lib/yfinance";
import type { EvidenceBundle } from "./types";
import type { UniverseFile } from "./config";
import type { ListMarket } from "./types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const DATA = path.join(process.cwd(), "data");

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(n: number | null): number | null {
  if (n == null) return null;
  return Math.round(n * 10) / 10;
}

function round2(n: number | null): number | null {
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function sentimentScore(text: string): number {
  const t = text.toLowerCase();
  const pos = [
    "surge",
    "gain",
    "beat",
    "upgrade",
    "record",
    "growth",
    "win",
    "strong",
    "profit",
    "expansion",
  ];
  const neg = [
    "fall",
    "drop",
    "miss",
    "downgrade",
    "loss",
    "weak",
    "cut",
    "decline",
    "probe",
    "fine",
  ];
  let s = 0;
  for (const w of pos) if (t.includes(w)) s += 1;
  for (const w of neg) if (t.includes(w)) s -= 1;
  if (s > 0) return 1;
  if (s < 0) return -1;
  return 0;
}

export function loadUniverseFile(): UniverseFile {
  const p = path.join(DATA, "agent_universe.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as UniverseFile & {
    meta?: unknown;
  };
  return {
    large: raw.large ?? [],
    mid: raw.mid ?? [],
    small: raw.small ?? [],
  };
}

export function loadDemoEvidence(symbol: string): EvidenceBundle | null {
  const key = symbol.toUpperCase();
  const p = path.join(DATA, "demo_agents", `${key}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as EvidenceBundle;
}

export function listDemoSymbols(): string[] {
  const dir = path.join(DATA, "demo_agents");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/i, "").toUpperCase());
}

export type UniverseEntry = {
  ticker: string;
  market: string;
  bucket: "large" | "mid" | "small";
};

function capBucket(
  tier: ReturnType<typeof capTier>,
): "large" | "mid" | "small" {
  if (tier === "LC") return "large";
  if (tier === "MC") return "mid";
  return "small";
}

function companyMarket(c: { market?: string | null }): string {
  const mk = (c.market || "").trim().toUpperCase();
  return mk === "NSE SME" ? "NSE SME" : "NSE";
}

function entryForTicker(
  ticker: string,
  market: string,
): UniverseEntry {
  const row = loadAllCompanies().find(
    (c) => c.ticker.toUpperCase() === ticker.toUpperCase(),
  );
  const mk = row ? companyMarket(row) : companyMarket({ market });
  return {
    ticker: ticker.toUpperCase(),
    market: mk,
    bucket: capBucket(capTier(row?.mcap_cr)),
  };
}

/** Scout universe — company DB, or Hold / Edge watchlists. */
export function listUniverseEntries(list: ListMarket): UniverseEntry[] {
  const out: UniverseEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (entry: UniverseEntry) => {
    const key = `${entry.market}:${entry.ticker}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  if (list === "Hold") {
    for (const h of loadHoldings()) {
      addEntry(entryForTicker(h.ticker, h.market || "NSE"));
    }
    return out;
  }

  if (list === "Edge") {
    for (const e of loadEdge()) {
      addEntry(entryForTicker(e.ticker, e.market || "NSE"));
    }
    return out;
  }

  const wantNse = list === "NSE" || list === "All";
  const wantSme = list === "NSE SME" || list === "All";

  for (const c of loadAllCompanies()) {
    const mk = companyMarket(c);
    if (wantNse && mk === "NSE") {
      addEntry({
        ticker: c.ticker.toUpperCase(),
        market: "NSE",
        bucket: capBucket(capTier(c.mcap_cr)),
      });
    } else if (wantSme && mk === "NSE SME") {
      addEntry({
        ticker: c.ticker.toUpperCase(),
        market: "NSE SME",
        bucket: capBucket(capTier(c.mcap_cr)),
      });
    }
  }

  return out;
}

export function countUniverseEntries(list: ListMarket): number {
  return listUniverseEntries(list).length;
}

export async function buildLiveEvidence(
  ticker: string,
  capSegment: string,
): Promise<EvidenceBundle> {
  const gaps: string[] = [];
  const companies = loadAllCompanies();
  const row = companies.find((c) => c.ticker.toUpperCase() === ticker.toUpperCase());
  const market = row?.market || "NSE";
  const name = row?.name || ticker;
  const sector = row?.sector || row?.sub_sector || null;
  const sym = toYfinanceSymbol(ticker, market);

  const period1 = new Date();
  period1.setDate(period1.getDate() - 35);
  const period1Str = period1.toISOString().slice(0, 10);

  let monthBars: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];

  try {
    const chart = await yf.chart(sym, {
      period1: period1Str,
      interval: "1d",
    });
    monthBars = (chart.quotes ?? [])
      .filter(
        (q) =>
          q.date &&
          q.close != null &&
          q.high != null &&
          q.low != null &&
          q.open != null,
      )
      .map((q) => ({
        date: new Date(q.date).toISOString().slice(0, 10),
        open: Number(q.open),
        high: Number(q.high),
        low: Number(q.low),
        close: Number(q.close),
        volume: Number(q.volume ?? 0),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    gaps.push("daily_ohlc");
  }

  let live: number | null = null;
  let dayOpen: number | null = null;
  let dayHigh: number | null = null;
  let dayLow: number | null = null;
  let prevClose: number | null = null;
  let volume: number | null = null;
  let w52High: number | null = null;
  let w52Low: number | null = null;

  if (monthBars.length >= 2) {
    const last = monthBars[monthBars.length - 1]!;
    const prev = monthBars[monthBars.length - 2]!;
    live = last.close;
    dayOpen = last.open;
    dayHigh = last.high;
    dayLow = last.low;
    prevClose = prev.close;
    volume = last.volume;
    w52High = Math.max(...monthBars.map((b) => b.high));
    w52Low = Math.min(...monthBars.map((b) => b.low));
  } else {
    gaps.push("daily_ohlc");
  }

  let dayChangePct: number | null = null;
  if (live != null && prevClose != null && prevClose > 0) {
    dayChangePct = round2(((live - prevClose) / prevClose) * 100);
  }

  let pctFromHigh: number | null = null;
  let positionPct: number | null = null;
  if (live != null && w52High != null && w52Low != null && w52High > w52Low) {
    pctFromHigh = round1(((live / w52High) - 1) * 100);
    positionPct = round1(((live - w52Low) / (w52High - w52Low)) * 100);
  }

  const closes = monthBars.map((b) => b.close);
  const vols = monthBars.map((b) => b.volume);

  let quoteVol: number | null = null;
  let quoteAvgVol: number | null = null;
  try {
    const q = await yf.quote(sym);
    quoteVol = num(q.regularMarketVolume);
    quoteAvgVol =
      num(q.averageDailyVolume3Month) ?? num(q.averageDailyVolume10Day);
  } catch {
    gaps.push("quote");
  }

  if ((volume == null || volume <= 0) && quoteVol != null && quoteVol > 0) {
    volume = quoteVol;
  }

  let avgVol: number | null = null;
  if (vols.length >= 21) {
    avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  } else if (vols.length > 1) {
    avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
  }
  if ((avgVol == null || avgVol <= 0) && quoteAvgVol != null && quoteAvgVol > 0) {
    avgVol = quoteAvgVol;
  }

  let rvol: number | null = null;
  if (volume != null && volume > 0 && avgVol != null && avgVol > 0) {
    rvol = round2(volume / avgVol);
  } else {
    gaps.push("rvol");
  }

  const sma20 = sma(closes, 20);
  let priceVsSmaPct: number | null = null;
  if (live != null && sma20 != null && sma20 > 0) {
    priceVsSmaPct = round1(((live - sma20) / sma20) * 100);
  } else {
    gaps.push("sma20");
  }

  let windowReturnPct: number | null = null;
  if (closes.length >= 2 && closes[0]! > 0) {
    windowReturnPct = round1(((closes[closes.length - 1]! / closes[0]!) - 1) * 100);
  }

  let trend: "up" | "down" | "sideways" | null = null;
  if (priceVsSmaPct != null) {
    if (priceVsSmaPct > 2) trend = "up";
    else if (priceVsSmaPct < -2) trend = "down";
    else trend = "sideways";
  }

  let dayRangePos: number | null = null;
  if (live != null && dayHigh != null && dayLow != null && dayHigh > dayLow) {
    dayRangePos = round1(((live - dayLow) / (dayHigh - dayLow)) * 100);
  }

  let analyst = {
    consensus: null as string | null,
    num_analysts: null as number | null,
    buy_pct: null as number | null,
    hold_pct: null as number | null,
    sell_pct: null as number | null,
    target_mean: null as number | null,
    target_low: null as number | null,
    target_high: null as number | null,
    upside_pct: null as number | null,
  };

  try {
    const qs = await yf.quoteSummary(sym, {
      modules: [
        "financialData",
        "recommendationTrend",
        "summaryDetail",
        "price",
      ],
    });
    analyst.consensus =
      (qs.financialData?.recommendationKey as string | undefined)?.trim() ||
      null;
    analyst.target_mean = num(qs.financialData?.targetMeanPrice);
    analyst.target_low = num(qs.financialData?.targetLowPrice);
    analyst.target_high = num(qs.financialData?.targetHighPrice);
    analyst.num_analysts = num(qs.financialData?.numberOfAnalystOpinions);

    const trendRows = qs.recommendationTrend?.trend ?? [];
    const latest = trendRows[0];
    if (latest) {
      const strongBuy = num(latest.strongBuy) ?? 0;
      const buy = num(latest.buy) ?? 0;
      const hold = num(latest.hold) ?? 0;
      const sell = num(latest.sell) ?? 0;
      const strongSell = num(latest.strongSell) ?? 0;
      const total = strongBuy + buy + hold + sell + strongSell;
      if (total > 0) {
        analyst.buy_pct = round1(((strongBuy + buy) / total) * 100);
        analyst.hold_pct = round1((hold / total) * 100);
        analyst.sell_pct = round1(((sell + strongSell) / total) * 100);
        if (!analyst.num_analysts) analyst.num_analysts = total;
      }
    }

    if (live != null && analyst.target_mean != null && live > 0) {
      analyst.upside_pct = round1(
        ((analyst.target_mean - live) / live) * 100,
      );
    }
  } catch {
    gaps.push("analyst");
  }

  const newsRecent: EvidenceBundle["news"]["recent"] = [];
  let pos = 0;
  let neg = 0;
  let neu = 0;
  try {
    const search = await yf.search(ticker, { newsCount: 8 });
    for (const item of search.news ?? []) {
      const title = String(item.title || "").trim();
      if (!title) continue;
      const s = sentimentScore(title);
      if (s > 0) pos += 1;
      else if (s < 0) neg += 1;
      else neu += 1;
      newsRecent.push({
        title,
        link: String(item.link || item.uuid || ""),
        published: item.providerPublishTime
          ? new Date(Number(item.providerPublishTime) * 1000)
              .toISOString()
              .slice(0, 10)
          : null,
      });
    }
  } catch {
    gaps.push("news");
  }

  if (!row?.mcap_cr && gaps.length === 0) {
    /* ok */
  }

  const cap = capTier(row?.mcap_cr ?? null);

  return {
    symbol: ticker.toUpperCase(),
    name,
    cap_segment: capSegment || cap.toLowerCase(),
    sector,
    market,
    price: {
      live: round2(live),
      day_open: round2(dayOpen),
      day_high: round2(dayHigh),
      day_low: round2(dayLow),
      prev_close: round2(prevClose),
      day_change_pct: dayChangePct,
      volume: volume != null ? Math.round(volume) : null,
    },
    range_52w: {
      high: round2(w52High),
      low: round2(w52Low),
      pct_from_high: pctFromHigh,
      position_pct: positionPct,
    },
    technicals: {
      rvol,
      price_vs_sma_pct: priceVsSmaPct,
      window_return_pct: windowReturnPct,
      swing_high: round2(w52High),
      swing_low: round2(w52Low),
      day_range_position_pct: dayRangePos,
      trend,
    },
    analyst,
    news: {
      total: newsRecent.length,
      positive: pos,
      negative: neg,
      neutral: neu,
      recent: newsRecent.slice(0, 6),
    },
    data_gaps: gaps,
  };
}

export async function scoutShortlistLive(
  shortlistPerBucket: number,
  list: ListMarket = "NSE",
): Promise<{ scanned: number; bundles: EvidenceBundle[] }> {
  const entries = listUniverseEntries(list);
  const buckets: Array<{ key: string; items: UniverseEntry[] }> = [
    { key: "large", items: [] },
    { key: "mid", items: [] },
    { key: "small", items: [] },
  ];
  for (const e of entries) {
    const b = buckets.find((x) => x.key === e.bucket);
    if (b) b.items.push(e);
  }

  const shortlisted: EvidenceBundle[] = [];
  let scanned = 0;

  for (const bucket of buckets) {
    const scored: Array<{ entry: UniverseEntry; change: number }> = [];
    for (const entry of bucket.items) {
      scanned += 1;
      try {
        const sym = toYfinanceSymbol(entry.ticker, entry.market);
        const q = await yf.quote(sym);
        const price = num(q?.regularMarketPrice);
        const prev = num(q?.regularMarketPreviousClose);
        if (price != null && prev != null && prev > 0) {
          scored.push({
            entry,
            change: Math.abs(((price - prev) / prev) * 100),
          });
        }
      } catch {
        /* skip */
      }
    }
    scored.sort((a, b) => b.change - a.change);
    const picks = scored.slice(0, shortlistPerBucket);
    for (const { entry } of picks) {
      try {
        const bundle = await buildLiveEvidence(entry.ticker, entry.bucket);
        shortlisted.push(bundle);
      } catch {
        /* skip */
      }
    }
  }

  return { scanned, bundles: shortlisted };
}

export function loadDemoBundles(list: ListMarket = "All"): EvidenceBundle[] {
  const hold = holdingsTickerSet();
  const edge = edgeTickerSet();
  return listDemoSymbols()
    .map((s) => loadDemoEvidence(s))
    .filter(Boolean)
    .filter((b) => {
      if (list === "All") return true;
      if (list === "Hold") return hold.has(b!.symbol.toUpperCase());
      if (list === "Edge") return edge.has(b!.symbol.toUpperCase());
      const mk = companyMarket(b!);
      return mk === list;
    }) as EvidenceBundle[];
}

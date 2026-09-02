import * as cheerio from "cheerio";
import {
  cacheBseScripCode,
  discoverBseInvestorMaterialSources,
  extractBseScripCode,
  resolveBseScripCode,
} from "./bse-investor-discover";
import { loadAllCompanies } from "./db";
import { screenerUrl } from "./links";
import { discoverNseInvestorMaterialSources } from "./nse-investor-discover";
import { discoverTrendlyneInvestorMaterialSources } from "./trendlyne-investor-discover";
import type {
  DiscoveredMaterialSource,
  InvestorMaterialKind,
  MaterialSourceProvider,
} from "./investor-material-types";
import { ensureInvestorMaterialsSchema } from "./investor-materials-schema";
import { openSqliteNamed } from "./sqlite-utils";

export type { DiscoveredMaterialSource, InvestorMaterialKind, MaterialSourceProvider };

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DISCOVER_CACHE_MS = 30 * 60 * 1000;
const discoverCache = new Map<
  string,
  { at: number; sources: DiscoveredMaterialSource[]; screener_url: string; note?: string }
>();

const ANNOUNCEMENT_KIND: Array<{ re: RegExp; kind: InvestorMaterialKind; title: string }> = [
  {
    re: /earnings\s+call\s+transcript|concall\s+transcript|conference\s+call\s+transcript/i,
    kind: "concall",
    title: "Earnings call transcript",
  },
  {
    re: /investor\s+presentation|earnings\s+presentation|analyst\s+presentation|investor\s+meet/i,
    kind: "ppt",
    title: "Investor presentation",
  },
];

function sourceId(url: string): string {
  return url.trim().toLowerCase();
}

function normalizePeriod(raw: string): string | null {
  const t = raw.trim();
  return t || null;
}

function periodSortKey(period: string | null): number {
  if (!period) return 0;
  const m = period.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return 0;
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return Number(m[2]) * 12 + (months[m[1]!.toLowerCase()] ?? 0);
}

function sourceRecency(s: DiscoveredMaterialSource): number {
  if (s.announced_at) {
    const t = Date.parse(s.announced_at);
    if (Number.isFinite(t)) return t;
  }
  const key = periodSortKey(s.period);
  if (!key) return 0;
  const year = Math.floor((key - 1) / 12);
  const month = (key - 1) % 12;
  return Date.UTC(year, month, 15);
}

function importedUrlSet(ticker: string): Set<string> {
  ensureInvestorMaterialsSchema();
  const conn = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    const rows = conn
      .prepare(
        `SELECT source_url FROM investor_materials WHERE ticker = ? AND source_url IS NOT NULL`,
      )
      .all(ticker.toUpperCase()) as Array<{ source_url: string }>;
    return new Set(rows.map((r) => sourceId(r.source_url)));
  } finally {
    conn.close();
  }
}

function skipMediaUrl(url: string): boolean {
  return /\.(webm|mp3|mp4|wav|m4a)(\?|$)/i.test(url) || /youtu\.?be|youtube\.com/i.test(url);
}

import { fetchScreenerCompanyHtml, screenerBlocked } from "./screener-fetch";

function parseScreenerConcalls(
  $: cheerio.CheerioAPI,
  importedUrls: Set<string>,
): DiscoveredMaterialSource[] {
  const out: DiscoveredMaterialSource[] = [];
  const seen = new Set<string>();

  $(".documents.concalls ul.list-links > li").each((_i, li) => {
    const $li = $(li);
    const period = normalizePeriod($li.find("div.nowrap").first().text());
    $li.find("a.concall-link[href]").each((_j, a) => {
      const $a = $(a);
      const href = ($a.attr("href") || "").trim();
      const label = $a.text().trim().toLowerCase();
      if (!href || skipMediaUrl(href)) return;

      let kind: InvestorMaterialKind = "other";
      let title = $a.attr("title")?.trim() || $a.text().trim();
      if (label === "transcript" || /transcript/i.test(title)) {
        kind = "concall";
        title = period ? `Concall transcript — ${period}` : "Concall transcript";
      } else if (label === "ppt") {
        kind = "ppt";
        title = period ? `Investor presentation — ${period}` : "Investor presentation";
      } else if (label === "rec") {
        return;
      } else if (/\.pdf(\?|$)/i.test(href)) {
        kind = "concall";
      }

      const url = href.startsWith("http") ? href : `https://www.screener.in${href}`;
      const id = sourceId(url);
      if (seen.has(id)) return;
      seen.add(id);

      out.push({
        id,
        kind,
        title,
        period,
        url,
        provider: "screener_concalls",
        imported: importedUrls.has(id),
      });
    });
  });

  return out;
}

function parseScreenerAnnouncements(
  $: cheerio.CheerioAPI,
  importedUrls: Set<string>,
): DiscoveredMaterialSource[] {
  const out: DiscoveredMaterialSource[] = [];
  const seen = new Set<string>();

  $(
    "#company-announcements-tab ul.list-links > li, .documents.flex-column ul.list-links > li",
  ).each((_i, li) => {
    const $li = $(li);
    const $a = $li.find("a[href]").first();
    const href = ($a.attr("href") || "").trim();
    if (!href || skipMediaUrl(href)) return;

    const heading = $a.clone().children().remove().end().text().replace(/\s+/g, " ").trim();
    const detail = $li.find(".ink-600").text().replace(/\s+/g, " ").trim();
    const blob = `${heading} ${detail}`;
    const match = ANNOUNCEMENT_KIND.find((k) => k.re.test(blob));
    if (!match) return;

    const url = href.startsWith("http") ? href : `https://www.screener.in${href}`;
    const id = sourceId(url);
    if (seen.has(id)) return;
    seen.add(id);

    const period =
      detail.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i)?.[0] ?? null;

    out.push({
      id,
      kind: match.kind,
      title: heading || match.title,
      period,
      url,
      provider: "screener_announcements",
      imported: importedUrls.has(id),
    });
  });

  return out;
}

function mergeSources(lists: DiscoveredMaterialSource[][]): DiscoveredMaterialSource[] {
  const merged: DiscoveredMaterialSource[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      merged.push(s);
    }
  }
  merged.sort((a, b) => {
    const recency = sourceRecency(b) - sourceRecency(a);
    if (recency !== 0) return recency;
    return periodSortKey(b.period) - periodSortKey(a.period);
  });
  return merged;
}

const PROVIDER_RANK: Record<MaterialSourceProvider, number> = {
  bse_announcements: 0,
  nse_announcements: 0,
  trendlyne_analyst_calls: 1,
  screener_concalls: 2,
  screener_announcements: 3,
};

const NSE_MARKETS = new Set(["NSE", "NSE SME", "NATIONAL STOCK EXCHANGE"]);

function isNseListed(market: string | null | undefined): boolean {
  return NSE_MARKETS.has((market || "").trim().toUpperCase());
}

function isDeadScreenerUrl(url: string): boolean {
  return /\.doc(\?|$)/i.test(url) || /federalmogulgoetzeindia\.net/i.test(url);
}

function sourceScore(s: DiscoveredMaterialSource): number {
  let score = PROVIDER_RANK[s.provider] ?? 9;
  if (s.provider.startsWith("screener") && isDeadScreenerUrl(s.url)) score += 20;
  return score;
}

/** List concall / PPT URLs — Screener (throttled) with BSE API fallback. */
export async function discoverInvestorMaterialSources(
  ticker: string,
  opts?: { refresh?: boolean },
): Promise<{
  sources: DiscoveredMaterialSource[];
  screener_url: string;
  note?: string;
}> {
  const key = ticker.toUpperCase();
  const cached = discoverCache.get(key);
  if (!opts?.refresh && cached && Date.now() - cached.at < DISCOVER_CACHE_MS) {
    return cached;
  }

  const importedUrls = importedUrlSet(key);
  const lists: DiscoveredMaterialSource[][] = [];
  let note: string | undefined;

  const company = loadAllCompanies().find((c) => c.ticker.toUpperCase() === key);
  const market = company?.market ?? null;
  const scripCode = resolveBseScripCode(key, null);

  const [bseSettled, nseSettled, screenerSettled, trendlyneSettled] = await Promise.allSettled([
    scripCode
      ? discoverBseInvestorMaterialSources(key, scripCode, importedUrls)
      : Promise.resolve([] as DiscoveredMaterialSource[]),
    isNseListed(market)
      ? discoverNseInvestorMaterialSources(key, market, importedUrls)
      : Promise.resolve([] as DiscoveredMaterialSource[]),
    (async () => {
      const html = await fetchScreenerCompanyHtml(key);
      const scrip = extractBseScripCode(html);
      if (scrip) cacheBseScripCode(key, scrip);
      const $ = cheerio.load(html);
      return [
        ...parseScreenerConcalls($, importedUrls),
        ...parseScreenerAnnouncements($, importedUrls),
      ];
    })(),
    discoverTrendlyneInvestorMaterialSources(key, importedUrls),
  ]);

  if (bseSettled.status === "fulfilled" && bseSettled.value.length) {
    lists.push(bseSettled.value);
  } else if (bseSettled.status === "rejected") {
    note = bseSettled.reason instanceof Error ? bseSettled.reason.message : "BSE discover failed";
  }

  if (nseSettled.status === "fulfilled" && nseSettled.value.length) {
    lists.push(nseSettled.value);
  } else if (nseSettled.status === "rejected") {
    const nseErr =
      nseSettled.reason instanceof Error ? nseSettled.reason.message : "NSE discover failed";
    note = note ? `${note} · ${nseErr}` : nseErr;
  }

  if (screenerSettled.status === "fulfilled" && screenerSettled.value.length) {
    lists.push(screenerSettled.value);
  } else if (screenerSettled.status === "rejected") {
    const scErr =
      screenerSettled.reason instanceof Error
        ? screenerSettled.reason.message
        : "Screener unavailable";
    note = note ? `${note} · ${scErr}` : scErr;
  }

  if (trendlyneSettled.status === "fulfilled" && trendlyneSettled.value.length) {
    lists.push(trendlyneSettled.value);
  } else if (trendlyneSettled.status === "rejected") {
    const tlErr =
      trendlyneSettled.reason instanceof Error
        ? trendlyneSettled.reason.message
        : "Trendlyne unavailable";
    note = note ? `${note} · ${tlErr}` : tlErr;
  }

  if (scripCode && note) {
    note = `${note} · BSE scrip ${scripCode}`;
  } else if (!scripCode && note) {
    note = `${note} · No BSE scrip cached`;
  }

  const sources = mergeSources(lists);
  const result = {
    at: Date.now(),
    sources,
    screener_url: screenerUrl(key),
    note: sources.length ? note : note || "No transcript/PPT links found",
  };
  discoverCache.set(key, result);
  return result;
}

export function pickLatestSources(
  sources: DiscoveredMaterialSource[],
  opts?: {
    limit?: number;
    kinds?: InvestorMaterialKind[];
    skipImported?: boolean;
    includeResults?: boolean;
  },
): DiscoveredMaterialSource[] {
  const limit = opts?.limit ?? 2;
  const kinds = opts?.kinds;
  const skipImported = opts?.skipImported !== false;
  const includeResults = opts?.includeResults === true;

  const eligible = sources
    .filter((s) => {
      if (skipImported && s.imported) return false;
      if (kinds?.length && !kinds.includes(s.kind)) {
        if (!(includeResults && s.kind === "other")) return false;
      }
      if (!kinds?.length && s.kind === "other" && !includeResults) return false;
      return true;
    })
    .sort((a, b) => {
      const recency = sourceRecency(b) - sourceRecency(a);
      if (recency !== 0) return recency;
      return sourceScore(a) - sourceScore(b);
    });

  const byKind = (kind: InvestorMaterialKind) =>
    [...eligible]
      .filter((s) => s.kind === kind)
      .sort((a, b) => {
        const recency = sourceRecency(b) - sourceRecency(a);
        if (recency !== 0) return recency;
        return sourceScore(a) - sourceScore(b);
      })[0];

  if (kinds?.includes("concall") && kinds?.includes("ppt")) {
    const out: DiscoveredMaterialSource[] = [];
    const concall =
      byKind("concall") ||
      byKind("transcript") ||
      eligible.find((s) => s.kind === "concall" || s.kind === "transcript");
    const ppt = byKind("ppt");
    if (concall) out.push(concall);
    if (ppt && ppt.id !== concall?.id) out.push(ppt);
    if (includeResults) {
      const results =
        [...eligible]
          .filter((s) => s.kind === "other")
          .sort((a, b) => {
            const aFin = /^financial results/i.test(a.title) ? 0 : 1;
            const bFin = /^financial results/i.test(b.title) ? 0 : 1;
            if (aFin !== bFin) return aFin - bFin;
            return sourceRecency(b) - sourceRecency(a);
          })[0] ?? byKind("other");
      if (results && !out.some((x) => x.id === results.id)) out.push(results);
    }
    for (const s of eligible) {
      if (out.length >= limit + (includeResults ? 1 : 0)) break;
      if (out.some((x) => x.id === s.id)) continue;
      out.push(s);
    }
    return out.slice(0, limit + (includeResults ? 1 : 0));
  }

  return eligible.slice(0, limit);
}

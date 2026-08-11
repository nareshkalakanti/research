/**
 * Google News RSS — investor buying mentions (Trilithon, Devabhaktuni).
 */
import * as cheerio from "cheerio";
import { RSS_BASE_URL } from "@/lib/hidden-portfolio/config";
import { matchInvestors, TRACKED_INVESTORS } from "./investors";

const SLEEP_MS = 900;

export type NewsSignal = {
  investor_ids: string[];
  query: string;
  headline: string;
  link: string;
  published: string | null;
  fetched_at: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const INVESTOR_NEWS_QUERIES: Array<{ investorId: string; query: string }> = [
  {
    investorId: "trilithon",
    query: "Trilithon Hidden Gems",
  },
  {
    investorId: "trilithon",
    query: "Trilithon Asset Management stock",
  },
  {
    investorId: "devabhaktuni",
    query: "Manohar Devabhaktuni shares",
  },
  {
    investorId: "devabhaktuni",
    query: "Devabhaktuni portfolio stock",
  },
];

const NOISE =
  /\b(cricket|ipl|wedding|obituary|movie|actor|minister|election)\b/i;

async function fetchRss(query: string): Promise<NewsSignal[]> {
  const url = RSS_BASE_URL.replace("{query}", encodeURIComponent(query));
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ResearchBot/1.0)" },
    cache: "no-store",
  });
  if (!res.ok) return [];

  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const fetchedAt = new Date().toISOString();
  const out: NewsSignal[] = [];

  $("item").each((_, el) => {
    const title = $(el).find("title").text().trim();
    const link = $(el).find("link").text().trim();
    const pub = $(el).find("pubDate").text().trim() || null;
    if (!title || NOISE.test(title)) return;

    const investor_ids: string[] = [];
    if (/trilithon|hidden gems scheme/i.test(title)) investor_ids.push("trilithon");
    if (/devabhaktuni/i.test(title)) investor_ids.push("devabhaktuni");
    for (const id of matchInvestors(title)) {
      if (!investor_ids.includes(id)) investor_ids.push(id);
    }

    if (!investor_ids.length) return;

    out.push({
      investor_ids,
      query,
      headline: title.replace(/ - .*$/, ""),
      link,
      published: pub,
      fetched_at: fetchedAt,
    });
  });

  return out;
}

export async function fetchInvestorNewsSignals(): Promise<NewsSignal[]> {
  const seen = new Set<string>();
  const out: NewsSignal[] = [];

  for (const q of INVESTOR_NEWS_QUERIES) {
    try {
      const rows = await fetchRss(q.query);
      for (const r of rows) {
        const key = `${r.headline}|${r.link}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!r.investor_ids.includes(q.investorId)) {
          r.investor_ids.push(q.investorId);
        }
        out.push(r);
      }
    } catch (e) {
      console.warn("[news-investor] RSS failed:", q.query, e);
    }
    await sleep(SLEEP_MS);
  }

  return out.sort((a, b) => {
    const ta = a.published ? Date.parse(a.published) : 0;
    const tb = b.published ? Date.parse(b.published) : 0;
    return tb - ta;
  });
}

export function investorNewsQueries(): typeof INVESTOR_NEWS_QUERIES {
  return INVESTOR_NEWS_QUERIES;
}

export { TRACKED_INVESTORS };

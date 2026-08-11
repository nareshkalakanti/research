/**
 * Google News RSS catalyst scanner + smart-money flag.
 */
import * as cheerio from "cheerio";
import {
  NEWS_ITEMS_PER_STOCK,
  NEWS_SLEEP_MS,
  RSS_BASE_URL,
  THEMES_KEYWORDS,
  type HiddenNewsHit,
  type KeywordTheme,
} from "./config";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function bareNewsSymbol(symbol: string): string {
  return symbol
    .replace(/-SM\.NS$/i, "")
    .replace(/\.(NS|BO)$/i, "")
    .trim()
    .toUpperCase();
}

const NAME_STOP = new Set([
  "limited",
  "ltd",
  "india",
  "indian",
  "company",
  "co",
  "corp",
  "corporation",
  "private",
  "pvt",
  "services",
  "service",
  "holdings",
  "international",
]);

/** Distinctive name phrases for headline matching (longest first). */
export function companyMatchPhrases(name: string): string[] {
  const clean = name.replace(/"/g, "").trim();
  if (!clean) return [];
  const words = clean.split(/\s+/).filter((w) => w.length > 1);
  const sig = words.filter((w) => !NAME_STOP.has(w.toLowerCase()));
  const out: string[] = [];
  const lower = clean.toLowerCase();

  if (lower.length >= 10) out.push(lower);
  if (sig.length >= 3) out.push(sig.slice(0, 3).join(" ").toLowerCase());
  if (sig.length >= 2) out.push(sig.slice(0, 2).join(" ").toLowerCase());
  for (const w of sig) {
    if (w.length >= 5) out.push(w.toLowerCase());
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

const STOCK_CONTEXT =
  /\b(nse|bse|nifty|sensex|stock|stocks|shares|share price|equity|listed|listing|market cap|mcap|crore| crore|lakh|rs\.?|inr|sme|block deal|bulk deal|q[1-4]|fy2[0-9]|results|earnings|revenue|order|contract|ipo|dividend)\b/i;

const PERSON_SPORTS =
  /\b(cricket|ipl|test match|odi|t20|batsman|wicket|football|tennis|actor|actress|minister|election)\b/i;

/**
 * Reject headlines that don't refer to this company.
 * e.g. "Dhruv Jurel" cricket ≠ Dhruv Consultancy Services.
 */
export function headlineMatchesCompany(
  title: string,
  name: string,
  symbol: string,
): boolean {
  const hay = title.toLowerCase();
  if (!hay.trim()) return false;

  const bare = bareNewsSymbol(symbol).toLowerCase();
  const phrases = companyMatchPhrases(name);

  // Multi-word company phrase — strongest signal
  for (const p of phrases) {
    if (p.includes(" ") && p.length >= 8 && hay.includes(p)) return true;
  }

  // Full legal name
  const full = name.replace(/"/g, "").trim().toLowerCase();
  if (full.length >= 14 && hay.includes(full)) return true;

  // Long distinctive single token from name (e.g. "consultancy", "valves")
  for (const p of phrases) {
    if (!p.includes(" ") && p.length >= 8 && hay.includes(p)) return true;
  }

  // Symbol — only with market context, or very unique ticker (>= 7 chars)
  if (bare.length >= 7 && hay.includes(bare)) return true;
  if (bare.length >= 4 && hay.includes(bare) && STOCK_CONTEXT.test(hay)) {
    return true;
  }

  // Short symbol / first name only — require stock context and no sports noise
  if (
    bare.length >= 4 &&
    bare.length <= 6 &&
    hay.includes(bare) &&
    STOCK_CONTEXT.test(hay) &&
    !PERSON_SPORTS.test(hay)
  ) {
    // Still reject if a longer person-style token follows bare name ("dhruv jurel")
    const personLike = new RegExp(
      `\\b${bare}\\s+[a-z]{3,}\\b`,
      "i",
    );
    if (personLike.test(title) && !phrases.some((p) => p.includes(" ") && hay.includes(p))) {
      return false;
    }
    return true;
  }

  return false;
}

function buildQuery(name: string, symbol: string): string {
  const company = name.replace(/"/g, "").trim();
  const bare = bareNewsSymbol(symbol);
  if (!company && !bare) return "";

  // Prefer company name + market terms; avoid bare short tickers alone
  if (company.length >= 10) {
    const twoWord = companyMatchPhrases(name).find((p) => p.includes(" "));
    if (twoWord) {
      return `"${twoWord}" (stock OR shares OR NSE OR order OR revenue)`;
    }
    return `"${company}" (stock OR shares OR NSE)`;
  }

  if (bare.length >= 6) {
    return `("${company || bare}" OR ${bare}) (stock OR shares OR NSE)`;
  }

  return `"${company || bare}" (stock OR shares OR NSE OR SME OR crore)`;
}

/** Case-insensitive keyword hit; prefer longer phrases first. */
function findKeywordHits(
  text: string,
): { matched: string[]; themes: KeywordTheme[] } {
  const hay = text.toLowerCase();
  const matched: string[] = [];
  const themeSet = new Set<KeywordTheme>();

  for (const theme of Object.keys(THEMES_KEYWORDS) as KeywordTheme[]) {
    const kws = [...THEMES_KEYWORDS[theme]].sort(
      (a, b) => b.length - a.length,
    );
    for (const kw of kws) {
      if (hay.includes(kw.toLowerCase())) {
        matched.push(kw);
        themeSet.add(theme);
      }
    }
  }
  return { matched: [...new Set(matched)], themes: [...themeSet] };
}

type RssItem = { title: string; link: string; published: string | null };

async function fetchRssItems(query: string): Promise<RssItem[]> {
  const url = RSS_BASE_URL.replace("{query}", encodeURIComponent(query));
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ResearchHiddenPortfolio/1.0)",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true } as Parameters<
    typeof cheerio.load
  >[1]);
  const items: RssItem[] = [];
  $("item").each((_, el) => {
    if (items.length >= NEWS_ITEMS_PER_STOCK) return false;
    const title = normalizeText($(el).find("title").first().text());
    const link = normalizeText(
      $(el).find("link").first().text() ||
        $(el).find("guid").first().text(),
    );
    const published =
      normalizeText($(el).find("pubDate").first().text()) || null;
    if (title) items.push({ title, link, published });
  });
  return items;
}

export type NewsScanResult = {
  news: HiddenNewsHit[];
  moat_keywords: string[];
  growth_keywords: string[];
  smart_money_keywords: string[];
  smart_money_flag: boolean;
  top_headline: string | null;
  top_link: string | null;
};

/**
 * Scan Google News RSS for catalysts. Sleeps after each request.
 * Never throws — returns empty on failure.
 */
export async function scanNewsCatalysts(
  name: string,
  symbol: string,
  opts?: { sleepMs?: number },
): Promise<NewsScanResult> {
  const empty: NewsScanResult = {
    news: [],
    moat_keywords: [],
    growth_keywords: [],
    smart_money_keywords: [],
    smart_money_flag: false,
    top_headline: null,
    top_link: null,
  };

  try {
    const query = buildQuery(name, symbol);
    if (!query) return empty;

    const raw = await fetchRssItems(query);
    await sleep(opts?.sleepMs ?? NEWS_SLEEP_MS);

    const items = raw.filter((it) =>
      headlineMatchesCompany(it.title, name, symbol),
    );

    const news: HiddenNewsHit[] = [];
    const moat = new Set<string>();
    const growth = new Set<string>();
    const smart = new Set<string>();

    for (const it of items) {
      const { matched, themes } = findKeywordHits(it.title);
      if (matched.length === 0) continue;
      news.push({
        title: it.title,
        link: it.link,
        published: it.published,
        matched,
        themes,
      });
      for (const kw of matched) {
        if (
          (THEMES_KEYWORDS.moat as readonly string[]).some(
            (k) => k.toLowerCase() === kw.toLowerCase(),
          )
        ) {
          moat.add(kw);
        }
        if (
          (THEMES_KEYWORDS.growth as readonly string[]).some(
            (k) => k.toLowerCase() === kw.toLowerCase(),
          )
        ) {
          growth.add(kw);
        }
        if (
          (THEMES_KEYWORDS.smart_money as readonly string[]).some(
            (k) => k.toLowerCase() === kw.toLowerCase(),
          )
        ) {
          smart.add(kw);
        }
      }
    }

    // Top headline: first relevant item (prefer catalyst hit, else any on-company)
    const top =
      news[0] ??
      (items[0]
        ? { title: items[0].title, link: items[0].link }
        : null);

    return {
      news,
      moat_keywords: [...moat],
      growth_keywords: [...growth],
      smart_money_keywords: [...smart],
      smart_money_flag: smart.size > 0,
      top_headline: top?.title ?? null,
      top_link: top?.link ?? null,
    };
  } catch (e) {
    console.warn(
      `[hidden-portfolio] news failed ${symbol}:`,
      e instanceof Error ? e.message : e,
    );
    try {
      await sleep(opts?.sleepMs ?? NEWS_SLEEP_MS);
    } catch {
      /* ignore */
    }
    return empty;
  }
}

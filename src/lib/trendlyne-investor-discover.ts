/**
 * Trendlyne analyst-calls listing — secondary discover when Screener links fail (.doc etc.).
 * PDFs on Trendlyne require login; we import inline post text from the SSR listing page.
 */
import * as cheerio from "cheerio";
import type { DiscoveredMaterialSource, InvestorMaterialKind } from "./investor-material-types";
import { ensureInvestorMaterialsSchema } from "./investor-materials-schema";
import { withWebsiteFetch } from "./scrape-pool";
import { openSqliteNamed } from "./sqlite-utils";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const RESEARCH_REPORTS_URL =
  "https://trendlyne.com/research-reports/stock/{ticker}/";

function sourceId(url: string): string {
  return url.trim().toLowerCase();
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

function formatPeriodFromTitle(title: string): string | null {
  const m = title.match(/\b(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})\b/);
  if (!m) return null;
  return `${m[2]} ${m[3]}`;
}

function classifyKind(label: string, heading: string): InvestorMaterialKind {
  const blob = `${label} ${heading}`.toLowerCase();
  if (/earnings call transcript|concall transcript|conference call transcript/.test(blob)) {
    return "concall";
  }
  if (/meet outcome|analyst\/investor meet|investor meet - outcome/.test(blob)) {
    return "concall";
  }
  if (/investor presentation|earnings presentation|analyst presentation/.test(blob)) {
    return "ppt";
  }
  if (/conference call|analyst call|earnings call/.test(blob)) {
    return "concall";
  }
  return "other";
}

function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function ensureTrendlyneStockCacheSchema(): void {
  ensureInvestorMaterialsSchema();
  const db = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_trendlyne_stock (
        ticker TEXT PRIMARY KEY,
        stock_id TEXT NOT NULL,
        slug TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

export function getCachedTrendlyneStockId(ticker: string): string | null {
  ensureTrendlyneStockCacheSchema();
  const conn = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    const row = conn
      .prepare(`SELECT stock_id FROM company_trendlyne_stock WHERE ticker = ?`)
      .get(ticker.toUpperCase()) as { stock_id: string } | undefined;
    return row?.stock_id?.trim() || null;
  } finally {
    conn.close();
  }
}

export function getCachedTrendlyneSlug(ticker: string): string | null {
  ensureTrendlyneStockCacheSchema();
  const conn = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    const row = conn
      .prepare(`SELECT slug FROM company_trendlyne_stock WHERE ticker = ?`)
      .get(ticker.toUpperCase()) as { slug: string | null } | undefined;
    return row?.slug?.trim() || null;
  } finally {
    conn.close();
  }
}

export function cacheTrendlyneStockId(
  ticker: string,
  stockId: string,
  slug?: string | null,
): void {
  const id = stockId.trim();
  if (!id) return;
  ensureTrendlyneStockCacheSchema();
  const conn = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    conn
      .prepare(
        `INSERT INTO company_trendlyne_stock (ticker, stock_id, slug, updated_at)
         VALUES (@ticker, @stock_id, @slug, @updated_at)
         ON CONFLICT(ticker) DO UPDATE SET
           stock_id = excluded.stock_id,
           slug = excluded.slug,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticker: ticker.toUpperCase(),
        stock_id: id,
        slug: slug?.trim() || null,
        updated_at: new Date().toISOString(),
      });
  } finally {
    conn.close();
  }
}

/** Resolve Trendlyne numeric stock id via research-reports redirect page. */
export async function resolveTrendlyneStockId(ticker: string): Promise<string | null> {
  const key = ticker.toUpperCase();
  const cached = getCachedTrendlyneStockId(key);
  const slug = getCachedTrendlyneSlug(key);
  if (cached && slug) return cached;

  const url = RESEARCH_REPORTS_URL.replace("{ticker}", encodeURIComponent(key));
  const html = await withWebsiteFetch(url, async () => {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, referer: "https://trendlyne.com/" },
      signal: AbortSignal.timeout(45_000),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Trendlyne stock lookup failed (${res.status})`);
    return res.text();
  });

  const m = html.match(
    new RegExp(`equity/(\\d+)/${key}\\b`, "i"),
  );
  if (!m?.[1]) return null;

  const slugM = html.match(
    new RegExp(`equity/${m[1]}/${key}/([a-z0-9-]+)`, "i"),
  );
  cacheTrendlyneStockId(key, m[1], slugM?.[1] ?? null);
  return m[1];
}

export type TrendlyneListingPost = {
  postId: string;
  kind: InvestorMaterialKind;
  title: string;
  period: string | null;
  heading: string;
  bodyText: string;
  postUrl: string;
  pdfUrl: string | null;
};

function analystCallsUrl(ticker: string, stockId: string, slug: string | null): string {
  const slugPart = slug || ticker.toLowerCase();
  return `https://trendlyne.com/latest-news/analyst-calls/${stockId}/${ticker}/${slugPart}/`;
}

/** Parse SSR analyst-calls listing (inline article text, no login). */
export function parseTrendlyneAnalystCallsHtml(
  html: string,
  ticker: string,
): TrendlyneListingPost[] {
  const $ = cheerio.load(html);
  const out: TrendlyneListingPost[] = [];
  const seen = new Set<string>();

  $("div.panel-post[id^='post-']").each((_i, panel) => {
    const $panel = $(panel);
    const postId = ($panel.attr("data-postid") || $panel.attr("id") || "")
      .replace(/^post-/, "")
      .trim();
    if (!postId || seen.has(postId)) return;
    seen.add(postId);

    const dateTitle = $panel.find("[title*='202']").first().attr("title") || "";
    const period =
      formatPeriodFromTitle(dateTitle) ||
      formatPeriodFromTitle($panel.find(".post-head-subtext").text()) ||
      null;

    const label = $panel.find("label.label-secondary span").first().text().trim();
    const heading = $panel.find("h6 .newslink, h6 a.newslink").first().text().trim();
    const headingFull = $panel.find("h6").text().replace(/\s+/g, " ").trim();
    const kind = classifyKind(label, headingFull);

    const pdfHref = $panel.find("a.newslink[href*='get-document/post/pdf']").first().attr("href");
    const pdfUrl = pdfHref
      ? pdfHref.startsWith("http")
        ? pdfHref
        : `https://trendlyne.com${pdfHref}`
      : null;

    const shareHref = $panel
      .find(`a.copy-post-link[data-href*='posts/${postId}']`)
      .first()
      .attr("data-href");
    const postUrl =
      shareHref ||
      `https://trendlyne.com/posts/${postId}/${slugifyHeading(heading || label || ticker)}`;

    const article = $panel.find("article").first();
    const bodyText = article
      .text()
      .replace(/\s+/g, " ")
      .trim();

    if (bodyText.replace(/\s/g, "").length < 60) return;

    out.push({
      postId,
      kind,
      title:
        label && period
          ? `${label} — ${period}`
          : heading.slice(0, 120) || `Trendlyne post ${postId}`,
      period,
      heading: headingFull.slice(0, 200),
      bodyText: bodyText.slice(0, 12_000),
      postUrl,
      pdfUrl,
    });
  });

  out.sort((a, b) => periodSortKey(b.period) - periodSortKey(a.period));
  return out;
}

export async function fetchTrendlyneAnalystCallsListing(
  ticker: string,
  stockId: string,
  slug?: string | null,
): Promise<TrendlyneListingPost[]> {
  const url = analystCallsUrl(ticker.toUpperCase(), stockId, slug ?? null);
  const html = await withWebsiteFetch(url, async () => {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, referer: "https://trendlyne.com/" },
      signal: AbortSignal.timeout(45_000),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Trendlyne analyst-calls failed (${res.status})`);
    return res.text();
  });
  return parseTrendlyneAnalystCallsHtml(html, ticker.toUpperCase());
}

/** Extract post body from cached listing by post id (fallback when PDF login-blocked). */
export async function fetchTrendlynePostText(
  ticker: string,
  postId: string,
): Promise<string | null> {
  const key = ticker.toUpperCase();
  const stockId = await resolveTrendlyneStockId(key);
  if (!stockId) return null;
  const posts = await fetchTrendlyneAnalystCallsListing(key, stockId, getCachedTrendlyneSlug(key));
  const hit = posts.find((p) => p.postId === postId);
  return hit?.bodyText?.trim() || null;
}

export async function discoverTrendlyneInvestorMaterialSources(
  ticker: string,
  importedUrls: Set<string>,
): Promise<DiscoveredMaterialSource[]> {
  const key = ticker.toUpperCase();
  const stockId = await resolveTrendlyneStockId(key);
  if (!stockId) return [];

  const slug = getCachedTrendlyneSlug(key);
  let posts: TrendlyneListingPost[];
  try {
    posts = await fetchTrendlyneAnalystCallsListing(key, stockId, slug);
  } catch {
    return [];
  }

  const out: DiscoveredMaterialSource[] = [];
  for (const post of posts) {
    if (post.kind !== "concall" && post.kind !== "ppt") continue;
    const url = post.postUrl;
    const id = sourceId(`trendlyne:post:${post.postId}`);
    out.push({
      id,
      kind: post.kind,
      title: post.title,
      period: post.period,
      url,
      provider: "trendlyne_analyst_calls",
      imported: importedUrls.has(sourceId(url)) || importedUrls.has(id),
    });
  }

  return out;
}

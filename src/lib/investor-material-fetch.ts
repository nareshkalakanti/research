import * as cheerio from "cheerio";
import { withWebsiteFetch } from "./scrape-pool";
import {
  fetchTrendlynePostText,
  getCachedTrendlyneSlug,
  parseTrendlyneAnalystCallsHtml,
  resolveTrendlyneStockId,
} from "./trendlyne-investor-discover";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const MAX_CHARS = 80_000;

function normalizeSpace(s: string): string {
  return s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, noscript, iframe, svg, form").remove();
  const paras: string[] = [];
  $("p, li, td, h1, h2, h3, h4, blockquote, pre").each((_i, el) => {
    const t = normalizeSpace($(el).text());
    if (t.length >= 24) paras.push(t);
  });
  if (!paras.length) {
    const body = normalizeSpace($("body").text());
    if (body.length >= 80) paras.push(body);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paras) {
    const key = p.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join("\n\n").slice(0, MAX_CHARS);
}

function fetchHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8",
  };
  if (/bseindia\.com/i.test(url)) {
    headers.referer = "https://www.bseindia.com/";
  }
  if (/trendlyne\.com/i.test(url)) {
    headers.referer = "https://trendlyne.com/";
  }
  return headers;
}

function trendlynePostId(url: string): string | null {
  const fromPosts = url.match(/trendlyne\.com\/posts\/(\d+)\//i);
  if (fromPosts?.[1]) return fromPosts[1];
  const fromDoc = url.match(/get-document\/post\/pdf\/(\d+)\/?/i);
  return fromDoc?.[1] ?? null;
}

async function fetchTrendlyneListingPost(ticker: string, postId: string): Promise<string> {
  const key = ticker.toUpperCase();
  const stockId = await resolveTrendlyneStockId(key);
  if (!stockId) throw new Error("Trendlyne stock id not found");
  const url = `https://trendlyne.com/latest-news/analyst-calls/${stockId}/${key}/${getCachedTrendlyneSlug(key) || key.toLowerCase()}/`;
  const html = await withWebsiteFetch(url, async () => {
    const res = await fetch(url, {
      headers: fetchHeaders(url),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`Trendlyne listing failed (${res.status})`);
    return res.text();
  });
  const posts = parseTrendlyneAnalystCallsHtml(html, ticker.toUpperCase());
  const hit = posts.find((p) => p.postId === postId);
  if (!hit?.bodyText?.trim()) throw new Error("Trendlyne post text not found in listing");
  return hit.bodyText.trim();
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // pdf-parse main entry runs debug code on import — use lib path only.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
    opts?: { max?: number },
  ) => Promise<{ text: string; numpages: number }>;
  const data = await pdfParse(buf, { max: 12 });
  const text = data.text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, MAX_CHARS);
}

export type FetchMaterialResult = {
  text: string;
  title: string | null;
  content_type: string | null;
};

/** Fetch URL and extract readable text (HTML, plain text, or PDF). */
export async function fetchInvestorMaterialUrl(
  url: string,
  opts?: { ticker?: string },
): Promise<FetchMaterialResult> {
  const u = url.trim();
  if (!u) throw new Error("URL required");

  const tlPost = trendlynePostId(u);
  if (tlPost && opts?.ticker) {
    const text = await fetchTrendlyneListingPost(opts.ticker, tlPost);
    return { text, title: null, content_type: "text/plain" };
  }

  return withWebsiteFetch(u, async () => {
    const res = await fetch(u, {
      headers: fetchHeaders(u),
      signal: AbortSignal.timeout(120_000),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

    const finalUrl = res.url || u;
    if (/accounts\/login/i.test(finalUrl) && tlPost && opts?.ticker) {
      const text = await fetchTrendlynePostText(opts.ticker, tlPost);
      if (text) return { text, title: null, content_type: "text/plain" };
      throw new Error("Trendlyne PDF requires login — post text unavailable");
    }

    const contentType = res.headers.get("content-type") || "";
    const isPdf =
      /application\/pdf/i.test(contentType) ||
      u.toLowerCase().includes(".pdf") ||
      /AnnPdfOpen\.aspx/i.test(u);

    if (isPdf) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error("PDF download empty");
      const text = await extractPdfText(buf);
      if (text.replace(/\s/g, "").length < 80) {
        throw new Error("PDF has no extractable text — paste manually");
      }
      return { text, title: null, content_type: "application/pdf" };
    }

    const raw = await res.text();
    let text: string;
    let title: string | null = null;

    if (/text\/html/i.test(contentType) || raw.includes("<html")) {
      const $ = cheerio.load(raw);
      title = normalizeSpace($("title").first().text()) || null;
      text = htmlToText(raw);
    } else {
      text = raw.slice(0, MAX_CHARS);
    }

    if (text.replace(/\s/g, "").length < 80) {
      throw new Error("Page too short — paste text manually");
    }

    return { text, title, content_type: contentType || null };
  });
}

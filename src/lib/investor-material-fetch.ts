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

function isPdfParseNoise(message: string): boolean {
  return (
    /font private use area/i.test(message) ||
    /Warning:\s*TT:/i.test(message) ||
    /undefined function:\s*\d+/i.test(message) ||
    /invalid function id:/i.test(message)
  );
}

/** pdf.js / fontkit spam on many Indian exchange PDFs — not actionable. */
async function withSuppressedPdfNoise<T>(fn: () => Promise<T>): Promise<T> {
  const origWarn = console.warn;
  const origError = console.error;
  const origLog = console.log;
  const filter =
    (orig: typeof console.warn) =>
    (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      if (isPdfParseNoise(msg)) return;
      orig.apply(console, args as [unknown?, ...unknown[]]);
    };
  console.warn = filter(origWarn);
  console.error = filter(origError);
  console.log = filter(origLog);
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
    console.error = origError;
    console.log = origLog;
  }
}

async function extractPdfText(buf: Buffer): Promise<string> {
  return withSuppressedPdfNoise(async () => {
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
  });
}

export type FetchMaterialResult = {
  text: string;
  title: string | null;
  content_type: string | null;
  parser?: "pdf-parse" | "firecrawl" | "html" | "trendlyne";
};

async function extractWithFirecrawl(
  url: string,
  isPdf: boolean,
  contentType: string,
  getBuffer: () => Promise<Buffer>,
): Promise<string | null> {
  if (!process.env.FIRECRAWL_API_KEY?.trim()) return null;

  const fc = await import("./firecrawl-parse");
  if (!isPdf && !fc.isFirecrawlDocumentUrl(url, contentType)) return null;

  try {
    const parsed = await fc.parseDocumentFromUrl(url, async () => {
      const buf = await getBuffer();
      return { buffer: buf, contentType };
    });
    if (parsed.markdown.replace(/\s/g, "").length < 80) return null;
    return parsed.markdown;
  } catch {
    try {
      const buf = await getBuffer();
      const name = url.split("/").pop()?.split("?")[0] || "document.pdf";
      const parsed = await fc.parseDocumentBuffer(buf, name, { contentType });
      if (parsed.markdown.replace(/\s/g, "").length < 80) return null;
      return parsed.markdown;
    } catch {
      return null;
    }
  }
}

function firecrawlConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY?.trim());
}

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

      const firecrawlText = await extractWithFirecrawl(
        finalUrl || u,
        true,
        contentType,
        async () => buf,
      );
      if (firecrawlText) {
        return {
          text: firecrawlText,
          title: null,
          content_type: "application/pdf",
          parser: "firecrawl",
        };
      }

      const text = await extractPdfText(buf);
      if (text.replace(/\s/g, "").length < 80) {
        throw new Error(
          firecrawlConfigured()
            ? "PDF has no extractable text — Firecrawl also failed"
            : "PDF has no extractable text — set FIRECRAWL_API_KEY for OCR parse",
        );
      }
      return { text, title: null, content_type: "application/pdf", parser: "pdf-parse" };
    }

    if (/\.(pdf|docx?|docm|odt|rtf|xlsx?|xlsm|pptx?|pptm|epub|csv)(\?|$)/i.test(finalUrl || u) ||
      /application\/pdf|wordprocessing|msword|spreadsheet|presentation|opendocument|rtf|epub|csv/i.test(contentType)) {
      const buf = Buffer.from(await res.arrayBuffer());
      const firecrawlText = await extractWithFirecrawl(
        finalUrl || u,
        false,
        contentType,
        async () => buf,
      );
      if (firecrawlText) {
        return {
          text: firecrawlText,
          title: null,
          content_type: contentType || null,
          parser: "firecrawl",
        };
      }
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

/**
 * Research · Auto DINs:
 * 1) NSE corporate governance / integrated filing (current board + DIN)
 * 2) MCA / public director registry (authoritative DIN + name)
 * 3) Annual-report / CG filing PDFs (regex Name + DIN)
 */
import * as cheerio from "cheerio";
import { listListingCompaniesLite } from "./db";
import {
  lookupCompanyCurrentDirectors,
  lookupDinOnMcaDirectories,
} from "./din-mca-lookup";
import { saveDinSeats } from "./din-fill";
import { isPlaceholderDirectorName } from "./gov-director-name";
import {
  createNseBuybackSession,
  nseFetch,
  type NseCookieJar,
} from "./nse-buybacks";
import {
  formatNseApiDateFromInstant,
  istCivilDayToUtcNoon,
  istTodayParts,
  shiftIstCivilDay,
} from "./nse-time";
import {
  fetchBoardFromNse,
  inferDirectorCategory,
  isPlaceholderDin,
  normDin,
  type BoardSeat,
} from "./nse-governance";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const QUOTE_URL = "https://www.nseindia.com/api/quote-equity";
const QUOTE_PAGE = "https://www.nseindia.com/get-quotes/equity";
const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

export type AutoDinHit = {
  name: string;
  din: string;
  designation: string;
};

export type AutoDinSourceLog = {
  source: string;
  ok: boolean;
  seats: number;
  detail?: string;
  url?: string;
};

export type AutoDinPreview = {
  ticker: string;
  company: string;
  market: string | null;
  pdfs: string[];
  seats: BoardSeat[];
  logs: AutoDinSourceLog[];
  why: string;
};

function nseSymbol(ticker: string): string {
  return (ticker || "")
    .trim()
    .toUpperCase()
    .replace(/-SM$/i, "")
    .replace(/\.(NS|BO)$/i, "");
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function localListing(ticker: string): {
  name: string | null;
  market: string | null;
} {
  const key = nseSymbol(ticker);
  if (!key) return { name: null, market: null };
  const hit = listListingCompaniesLite().find(
    (c) => c.ticker.toUpperCase() === key,
  );
  if (!hit) return { name: null, market: null };
  const name = (hit.name || "").trim();
  return {
    name: name.length >= 3 ? name : null,
    market: (hit.market || "").trim() || null,
  };
}

function mergeSeat(
  byDin: Map<string, BoardSeat>,
  seat: BoardSeat,
  preferSource?: boolean,
): void {
  const din = normDin(seat.din);
  if (!din || din.length !== 8 || isPlaceholderDin(din)) return;
  const name = (seat.name || "").replace(/\s+/g, " ").trim();
  if (!name || isPlaceholderDirectorName(name)) return;
  const next: BoardSeat = {
    din,
    name,
    designation: (seat.designation || "Director").trim() || "Director",
    category: inferDirectorCategory(seat.designation || "Director"),
    source: seat.source || "auto_dins",
    as_of: seat.as_of || "",
  };
  const prior = byDin.get(din);
  if (!prior) {
    byDin.set(din, next);
    return;
  }
  const betterName =
    preferSource ||
    (next.name.length > prior.name.length &&
      !/^din\s+\d{8}$/i.test(next.name));
  const betterRole =
    preferSource ||
    (/director|chair|managing|independent|executive|cfo|ceo/i.test(
      next.designation,
    ) &&
      prior.designation === "Director");
  byDin.set(din, {
    din,
    name: betterName ? next.name : prior.name,
    designation: betterRole ? next.designation : prior.designation,
    category: inferDirectorCategory(
      betterRole ? next.designation : prior.designation,
    ),
    source: preferSource ? next.source : prior.source || next.source,
    as_of: next.as_of || prior.as_of || "",
  });
}

async function nseCompanyName(
  symbol: string,
  jar: NseCookieJar,
): Promise<string | null> {
  try {
    await nseFetch(QUOTE_PAGE, jar, {
      params: { symbol },
      referer: "https://www.nseindia.com/",
    });
    const res = await nseFetch(QUOTE_URL, jar, {
      params: { symbol },
      referer: `${QUOTE_PAGE}?symbol=${encodeURIComponent(symbol)}`,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      info?: { companyName?: unknown; companyNameOriginal?: unknown };
    };
    const name =
      safeStr(json.info?.companyName) ||
      safeStr(json.info?.companyNameOriginal);
    return name.length >= 3 ? name : null;
  } catch {
    return null;
  }
}

function isDinFilingBlob(blob: string): boolean {
  const t = blob.toLowerCase();
  if (/newspaper|postal ballot|dividend|credit rating|buy\s*back/i.test(t)) {
    return false;
  }
  return /annual\s*report|integrated\s*filing|corporate\s*governance|board\s*of\s*directors|director|din\b|kmp|composition\s+of\s+board/i.test(
    t,
  );
}

function filingScore(blob: string): number {
  const t = blob.toLowerCase();
  let s = 0;
  if (/annual\s*report/.test(t)) s += 40;
  if (/integrated\s*filing/.test(t)) s += 30;
  if (/corporate\s*governance/.test(t)) s += 20;
  if (/board\s*of\s*directors|composition\s+of\s+board/.test(t)) s += 15;
  if (/\bdin\b/.test(t)) s += 10;
  return s;
}

async function nseFilingPdfLinks(
  symbol: string,
  jar: NseCookieJar,
  maxLinks: number,
): Promise<string[]> {
  const end = istTodayParts();
  const start = shiftIstCivilDay(end, -400);
  const from = istCivilDayToUtcNoon(start);
  const to = istCivilDayToUtcNoon(end);
  const scored: Array<{ url: string; score: number }> = [];
  const seen = new Set<string>();

  for (const index of ["equities", "sme"] as const) {
    try {
      const u = new URL(CORP_ANN_URL);
      u.searchParams.set("index", index);
      u.searchParams.set("symbol", symbol);
      u.searchParams.set("from_date", formatNseApiDateFromInstant(from));
      u.searchParams.set("to_date", formatNseApiDateFromInstant(to));
      const res = await nseFetch(u.toString(), jar, { referer: NSE_ANN_REF });
      if (!res.ok) continue;
      const rows = (await res.json()) as unknown;
      if (!Array.isArray(rows)) continue;
      for (const row of rows as Array<Record<string, unknown>>) {
        const url = safeStr(row.attchmntFile);
        if (!url.startsWith("http") || !/\.pdf(\?|$)/i.test(url)) continue;
        if (seen.has(url)) continue;
        const blob = `${safeStr(row.desc)} ${safeStr(row.attchmntText)} ${url}`;
        if (!isDinFilingBlob(blob)) continue;
        seen.add(url);
        scored.push({ url, score: filingScore(blob) });
      }
      if (scored.length) break;
    } catch {
      /* try other index / DDG */
    }
  }

  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return scored.slice(0, maxLinks).map((x) => x.url);
}

function unwrapDdgHref(href: string): string {
  const raw = (href || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw, "https://html.duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    /* keep raw */
  }
  return raw;
}

async function duckDuckGoArchivePdfs(
  companyName: string,
  maxLinks: number,
): Promise<string[]> {
  const query = `site:archives.nseindia.com OR site:nsearchives.nseindia.com "${companyName}" DIN annual report`;
  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const out: string[] = [];
    const seen = new Set<string>();
    $("a.result__a, a.result-link, a[href]").each((_, el) => {
      if (out.length >= maxLinks) return;
      const href = unwrapDdgHref($(el).attr("href") || "");
      if (!/^https?:\/\//i.test(href)) return;
      if (!/\.pdf(\?|$)/i.test(href)) return;
      if (
        !/archives\.nseindia\.com|nsearchives\.nseindia\.com/i.test(href)
      ) {
        return;
      }
      if (seen.has(href)) return;
      seen.add(href);
      out.push(href);
    });
    return out;
  } catch {
    return [];
  }
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
  ) => Promise<{ text?: string }>;
  const parsed = await pdfParse(buf);
  return (parsed.text || "").replace(/\u00a0/g, " ");
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/pdf,*/*",
        Referer: "https://www.nseindia.com/",
      },
      signal: AbortSignal.timeout(45_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Name near DIN from filing text — stable 8-digit pattern only. */
export function extractDinHitsFromText(text: string): AutoDinHit[] {
  const blob = (text || "").replace(/\r/g, "\n");
  const hits: AutoDinHit[] = [];
  const seen = new Set<string>();

  const patterns: RegExp[] = [
    /(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?)?\s*([A-Z][A-Za-z .'-]{2,60}?)\s*(?:\((?:DIN|Din)\s*[:\-–]?\s*|(?:DIN|Din)\s*[:\-–]?\s+)(\d{8})\b/g,
    /([A-Z][A-Za-z .'-]{2,60}?)\s+DIN\s*[:\-–]?\s*(\d{8})\b/gi,
    /(\d{8})\s*[-–—|:]\s*([A-Z][A-Za-z .'-]{2,60}?)(?=\s{2,}|\n|,|$)/g,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blob)) != null) {
      let name: string;
      let dinRaw: string;
      if (/^\d{8}$/.test(m[1] || "")) {
        dinRaw = m[1]!;
        name = m[2]!;
      } else {
        name = m[1]!;
        dinRaw = m[2]!;
      }
      const din = normDin(dinRaw);
      if (!din || din.length !== 8 || isPlaceholderDin(din) || seen.has(din)) {
        continue;
      }
      name = name
        .replace(/\s+/g, " ")
        .replace(/^(?:Mr|Ms|Mrs|Dr)\.?\s+/i, "")
        .replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "")
        .trim();
      if (name.length < 4) continue;
      if (/^(din|director|name|designation|chairman|promoter)$/i.test(name)) {
        continue;
      }
      if (/\b(limited|ltd|private|pvt|company)\b/i.test(name)) continue;
      seen.add(din);
      hits.push({
        name,
        din,
        designation: "Director",
      });
    }
  }

  return hits;
}

export async function previewAutoDins(opts: {
  ticker: string;
  maxPdfs?: number;
}): Promise<AutoDinPreview> {
  const ticker = nseSymbol(opts.ticker);
  if (!ticker) {
    return {
      ticker: "",
      company: "",
      market: null,
      pdfs: [],
      seats: [],
      logs: [],
      why: "Enter an NSE/BSE symbol.",
    };
  }

  const maxPdfs = Math.max(1, Math.min(opts.maxPdfs ?? 5, 8));
  const listing = localListing(ticker);
  let company = listing.name || "";
  const market = listing.market;
  const jar = await createNseBuybackSession();
  if (!company) {
    company = (await nseCompanyName(ticker, jar)) || "";
  }
  if (!company) {
    return {
      ticker,
      company: "",
      market,
      pdfs: [],
      seats: [],
      logs: [],
      why: `Could not resolve company name for ${ticker}.`,
    };
  }

  const byDin = new Map<string, BoardSeat>();
  const logs: AutoDinSourceLog[] = [];
  const pdfs: string[] = [];

  // 1) NSE corporate governance / integrated filing — current board + DIN
  try {
    const nseBoard = await fetchBoardFromNse(ticker, market, jar);
    if (nseBoard?.seats?.length) {
      for (const s of nseBoard.seats) mergeSeat(byDin, s, true);
      logs.push({
        source: nseBoard.source || "nse_corporate_governance",
        ok: true,
        seats: nseBoard.seats.length,
        detail: nseBoard.as_of
          ? `as of ${nseBoard.as_of}`
          : "NSE CG / integrated filing",
      });
    } else {
      logs.push({
        source: "nse_corporate_governance",
        ok: false,
        seats: 0,
        detail: "No CG / integrated board rows",
      });
    }
  } catch (e) {
    logs.push({
      source: "nse_corporate_governance",
      ok: false,
      seats: 0,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 2) MCA / public director registry — authoritative DIN + name
  try {
    const registry = await lookupCompanyCurrentDirectors(company);
    if (registry?.seats?.length) {
      for (const s of registry.seats) {
        mergeSeat(
          byDin,
          { ...s, source: s.source || "mca_registry" },
          true,
        );
      }
      logs.push({
        source: "mca_registry",
        ok: true,
        seats: registry.seats.length,
        detail: "MCA / director directory table",
        url: registry.source_url,
      });
    } else {
      logs.push({
        source: "mca_registry",
        ok: false,
        seats: 0,
        detail: "No current-directors table",
      });
    }
  } catch (e) {
    logs.push({
      source: "mca_registry",
      ok: false,
      seats: 0,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 3) Annual-report / CG filing PDFs (NSE announcements + archives)
  const seenPdf = new Set<string>();
  const pushPdf = (url: string) => {
    if (!url || seenPdf.has(url) || pdfs.length >= maxPdfs) return;
    seenPdf.add(url);
    pdfs.push(url);
  };
  for (const url of await nseFilingPdfLinks(ticker, jar, maxPdfs)) pushPdf(url);
  if (pdfs.length < maxPdfs) {
    for (const url of await duckDuckGoArchivePdfs(
      company,
      maxPdfs - pdfs.length,
    )) {
      pushPdf(url);
    }
  }

  for (const pdf of pdfs) {
    try {
      const buf = await downloadPdf(pdf);
      if (!buf) {
        logs.push({
          source: "filing_pdf",
          ok: false,
          seats: 0,
          detail: "download failed",
          url: pdf,
        });
        continue;
      }
      const text = await extractPdfText(buf);
      const hits = extractDinHitsFromText(text);
      for (const h of hits) {
        mergeSeat(byDin, {
          din: h.din,
          name: h.name,
          designation: h.designation || "Director",
          category: inferDirectorCategory(h.designation || "Director"),
          source: "nse_filing_pdf",
          as_of: "",
        });
      }
      logs.push({
        source: "filing_pdf",
        ok: true,
        seats: hits.length,
        detail: `${text.length.toLocaleString()} chars`,
        url: pdf,
      });
    } catch (e) {
      logs.push({
        source: "filing_pdf",
        ok: false,
        seats: 0,
        detail: e instanceof Error ? e.message : String(e),
        url: pdf,
      });
    }
  }

  // 4) MCA Master Data / DIN directory — authoritative names for known DINs
  const enrichList = [...byDin.values()].slice(0, 10);
  let mcaEnrich = 0;
  for (const seat of enrichList) {
    try {
      const hit = await lookupDinOnMcaDirectories(seat.din);
      if (!hit?.name || isPlaceholderDirectorName(hit.name)) continue;
      mergeSeat(
        byDin,
        {
          ...seat,
          name: hit.name,
          source: hit.source || "mca_din_master",
        },
        true,
      );
      mcaEnrich += 1;
    } catch {
      /* keep prior */
    }
  }
  if (mcaEnrich) {
    logs.push({
      source: "mca_din_master",
      ok: true,
      seats: mcaEnrich,
      detail: "Enriched names from MCA / DIN directory",
    });
  }

  const seats = [...byDin.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  const okSources = logs.filter((l) => l.ok && l.seats > 0);
  return {
    ticker,
    company,
    market,
    pdfs,
    seats,
    logs,
    why: seats.length
      ? `Found ${seats.length} DIN(s) for ${company} via ${okSources
          .map((s) => s.source)
          .join(", ") || "sources"}.`
      : `No DIN seats found for ${company} (tried NSE CG, MCA registry, filing PDFs).`,
  };
}

export async function saveAutoDins(opts: {
  ticker: string;
  company?: string;
  seats: BoardSeat[];
}): Promise<{
  ticker: string;
  company_extracted: string | null;
  seats: BoardSeat[];
  saved: number;
  why: string;
}> {
  return saveDinSeats({
    ticker: opts.ticker,
    company: opts.company,
    seats: opts.seats.map((s) => ({
      ...s,
      source: s.source || "nse_filing_pdf",
    })),
  });
}

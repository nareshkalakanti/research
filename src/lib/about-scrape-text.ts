import * as cheerio from "cheerio";
import { looksLikeNavJunk } from "./db";
import { websiteUrl } from "./links";

type CheerioRoot = ReturnType<typeof cheerio.load>;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MAX_TEXT = 24_000;
const MAX_URLS = 10;

const NOISE_LINE =
  /^(home|about us|contact us|contact|careers?|menu|login|sign in|search|privacy policy|terms|disclaimer|investor relations|board of directors|corporate governance|sitemap|skip to content|read more|learn more|click here)$/i;

const ABOUT_HINT =
  /about|profile|company|overview|who-we|our-story|corporate|business-profile|know-us|introduction|our-business|company-profile|about-us|aboutus/i;

const STRIP_SELECTORS = [
  "script",
  "style",
  "nav",
  "header",
  "footer",
  "noscript",
  "iframe",
  "svg",
  "form",
  "aside",
  ".menu",
  ".navbar",
  ".breadcrumb",
  ".cookie",
  ".popup",
  ".modal",
  ".social",
  ".share",
  ".newsletter",
  ".sidebar",
  "#sidebar",
  ".widget",
  ".footer",
  ".header",
].join(", ");

export type ScrapeExtractResult = {
  text: string | null;
  url: string | null;
  pages_tried?: number;
  reason?: "no_website" | "empty_page" | "nav_junk" | "unreachable";
};

function normalizeSpace(s: string): string {
  return s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function assembleProse(paragraphs: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paragraphs) {
    const p = normalizeSpace(raw);
    if (p.length < 32) continue;
    if (NOISE_LINE.test(p)) continue;
    const key = p.slice(0, 96).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join("\n\n").slice(0, MAX_TEXT);
}

function scoreText(text: string): number {
  if (!text || text.length < 80) return 0;
  if (looksLikeNavJunk(text)) return Math.min(text.length / 12, 180);
  const sentences = (text.match(/[.!?]/g) || []).length;
  const words = text.split(/\s+/).length;
  const businessHits = (
    text.match(
      /\b(manufactur|product|service|revenue|customer|market|export|plant|capacity|segment|industry|founded|incorporated|leading|specializ)\w*/gi,
    ) || []
  ).length;
  return (
    text.length +
    sentences * 140 +
    Math.min(words, 500) +
    businessHits * 80
  );
}

function extractParagraphs($: CheerioRoot, root: cheerio.Cheerio<cheerio.Element>): string[] {
  const paras: string[] = [];
  root.find("p, li, dd, blockquote, h2 + p, h3 + p").each((_i, el) => {
    const t = normalizeSpace($(el).text());
    if (t.length >= 36) paras.push(t);
  });

  if (paras.length >= 2) return paras;

  root.find("h2, h3").each((_i, el) => {
    const heading = normalizeSpace($(el).text());
    if (heading.length < 4 || heading.length > 120) return;
    if (NOISE_LINE.test(heading)) return;
    const chunk: string[] = [heading];
    let sib = $(el).next();
    for (let i = 0; i < 4 && sib.length; i += 1) {
      const tag = sib.prop("tagName")?.toLowerCase();
      if (tag === "h2" || tag === "h3") break;
      const t = normalizeSpace(sib.text());
      if (t.length >= 36) chunk.push(t);
      sib = sib.next();
    }
    if (chunk.length >= 2) paras.push(chunk.join(" — "));
  });

  if (paras.length >= 1) return paras;

  const block = normalizeSpace(root.text());
  if (block.length >= 80) {
    return block
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 40);
  }
  return paras;
}

function extractMeta($: CheerioRoot): string | null {
  const candidates = [
    $('meta[property="og:description"]').attr("content"),
    $('meta[name="description"]').attr("content"),
    $('meta[name="Description"]').attr("content"),
  ]
    .map((v) => normalizeSpace(v || ""))
    .filter((v) => v.length >= 60 && v.length <= 1200);
  const best = candidates.find((c) => !looksLikeNavJunk(c));
  return best || candidates[0] || null;
}

function extractJsonLd($: CheerioRoot): string | null {
  const bits: string[] = [];
  $("script[type='application/ld+json'], script[type=\"application/ld+json\"]").each(
    (_i, el) => {
      const raw = $(el).html()?.trim();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as unknown;
        collectJsonLdText(parsed, bits);
      } catch {
        /* ignore */
      }
    },
  );
  const joined = assembleProse(bits);
  return joined.length >= 80 ? joined : null;
}

function collectJsonLdText(node: unknown, out: string[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) collectJsonLdText(x, out);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const type = String(obj["@type"] || "").toLowerCase();
  const desc = obj.description;
  if (
    typeof desc === "string" &&
    desc.length >= 60 &&
    (type.includes("organization") ||
      type.includes("corporation") ||
      type.includes("company") ||
      !type)
  ) {
    out.push(desc);
  }
  if (typeof obj.about === "string" && obj.about.length >= 60) out.push(obj.about);
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") collectJsonLdText(v, out);
  }
}

function extractFromHtml(html: string): { text: string; paragraphs: number } {
  const $ = cheerio.load(html);
  $(STRIP_SELECTORS).remove();

  const contentSelectors = [
    "main",
    "article",
    '[role="main"]',
    "#about",
    "#about-us",
    ".about-us",
    ".about",
    ".company-profile",
    ".who-we-are",
    ".page-content",
    ".entry-content",
    ".content-area",
    "#content",
    ".content",
    ".main-content",
    ".inner-content",
  ];

  let bestParas: string[] = [];
  let bestScore = 0;

  for (const sel of contentSelectors) {
    $(sel).each((_i, node) => {
      const paras = extractParagraphs($, $(node));
      const text = assembleProse(paras);
      const s = scoreText(text);
      if (s > bestScore) {
        bestScore = s;
        bestParas = paras;
      }
    });
  }

  if (bestScore < 350) {
    const bodyParas = extractParagraphs($, $("body"));
    const text = assembleProse(bodyParas);
    const s = scoreText(text);
    if (s > bestScore) {
      bestScore = s;
      bestParas = bodyParas;
    }
  }

  const meta = extractMeta($);
  if (meta && bestScore < 900) {
    bestParas.unshift(meta);
  }

  const jsonLd = extractJsonLd($);
  if (jsonLd && bestScore < 700) {
    bestParas.unshift(...jsonLd.split("\n\n"));
  }

  const text = assembleProse(bestParas);
  return { text, paragraphs: bestParas.length };
}

function discoverAboutUrls(html: string, origin: string): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href")?.trim();
    const label = normalizeSpace($(el).text());
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
    if (!ABOUT_HINT.test(href) && !ABOUT_HINT.test(label)) return;
    try {
      const u = new URL(href, origin);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      if (u.origin !== origin) return;
      const path = u.pathname.toLowerCase();
      if (/\.(pdf|jpg|png|zip|doc)/.test(path)) return;
      found.add(u.href.split("#")[0]!);
    } catch {
      /* ignore */
    }
  });
  return [...found];
}

async function fetchHtml(
  url: string,
  timeoutMs = 12_000,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (
      ct &&
      !ct.includes("text/html") &&
      !ct.includes("application/xhtml") &&
      !ct.includes("text/plain")
    ) {
      return null;
    }
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function staticCandidateUrls(base: string): string[] {
  const normalized = websiteUrl(base);
  if (!normalized) return [];
  let origin: string;
  try {
    origin = new URL(normalized).origin;
  } catch {
    return [normalized];
  }
  const paths = [
    "",
    "/about-us",
    "/about",
    "/aboutus",
    "/about-us/",
    "/company-profile",
    "/who-we-are",
    "/our-company",
    "/corporate-profile",
    "/company",
    "/overview",
    "/our-business",
    "/business-profile",
    "/corporate-information",
    "/profile",
    "/know-us",
    "/introduction",
  ];
  return [...new Set(paths.map((p) => `${origin}${p.replace(/\/$/, "")}${p.endsWith("/") ? "/" : ""}`))];
}

/** When .com is dead, many Indian issuers use the same slug on .co.in (e.g. abcotspin). */
function alternateIndianOrigins(origin: string): string[] {
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const alts: string[] = [];
    if (host.endsWith(".com")) {
      const stem = host.slice(0, -4);
      if (stem) {
        alts.push(`${u.protocol}//${stem}.co.in`);
        alts.push(`${u.protocol}//www.${stem}.co.in`);
      }
    }
    return alts.filter((a) => a !== origin);
  } catch {
    return [];
  }
}

export async function scrapeCompanyWebsite(
  website: string | null | undefined,
): Promise<ScrapeExtractResult> {
  const normalized = websiteUrl(website || "");
  if (!normalized) {
    return { text: null, url: null, reason: "no_website" };
  }

  const urlSet = new Set<string>(staticCandidateUrls(normalized));

  let origin: string;
  try {
    origin = new URL(normalized).origin;
  } catch {
    return { text: null, url: null, reason: "no_website" };
  }

  let homeHtml = await fetchHtml(origin, 8_000);
  if (!homeHtml) {
    for (const alt of alternateIndianOrigins(origin)) {
      const altHtml = await fetchHtml(alt, 8_000);
      if (altHtml) {
        origin = alt;
        homeHtml = altHtml;
        for (const u of staticCandidateUrls(alt)) urlSet.add(u);
        break;
      }
    }
  }

  if (!homeHtml) {
    return {
      text: null,
      url: origin,
      pages_tried: 0,
      reason: "unreachable",
    };
  }

  for (const u of discoverAboutUrls(homeHtml, origin)) urlSet.add(u);

  const urls = [...urlSet].slice(0, MAX_URLS);
  let bestText = "";
  let bestUrl: string | null = null;
  let bestScore = 0;
  let pagesTried = 0;

  for (const url of urls) {
    const html = url === origin && homeHtml ? homeHtml : await fetchHtml(url);
    if (!html) continue;
    pagesTried += 1;
    const { text } = extractFromHtml(html);
    const score = scoreText(text);
    if (score > bestScore) {
      bestScore = score;
      bestText = text;
      bestUrl = url;
    }
    if (score >= 1600 && !looksLikeNavJunk(text)) break;
  }

  if (!bestText || bestText.length < 80) {
    const reason =
      pagesTried === 0 ? ("unreachable" as const) : ("empty_page" as const);
    return { text: null, url: bestUrl ?? origin, pages_tried: pagesTried, reason };
  }
  if (looksLikeNavJunk(bestText)) {
    return { text: null, url: bestUrl, pages_tried: pagesTried, reason: "nav_junk" };
  }

  return { text: bestText, url: bestUrl, pages_tried: pagesTried };
}

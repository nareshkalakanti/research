/**
 * Look up a DIN on public MCA director directories and parse name + companies.
 * RegisterKaro is tried first; Tofler is the fallback when that host is blocked.
 */
import * as cheerio from "cheerio";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "./sqlite-utils";
import { normDin } from "./nse-governance";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type RegistryCompany = {
  name: string;
  cin: string;
  status: string;
  designation: string;
  as_of: string;
};

export type DinRegistryHit = {
  din: string;
  name: string;
  source: string;
  source_url: string;
  companies: RegistryCompany[];
};

function slugName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function dinUnpadded(din: string): string {
  return din.replace(/^0+/, "") || "0";
}

function parseAppointment(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  const m = t.match(/^(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})$/);
  if (!m) return "";
  const months: Record<string, string> = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };
  const mm = months[m[2]!];
  if (!mm) return "";
  return `${m[3]}-${mm}-${String(Number(m[1])).padStart(2, "0")}`;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (/just a moment|security verification|enable javascript/i.test(html)) {
      return null;
    }
    if (!html || html.length < 200) return null;
    return html;
  } catch {
    return null;
  }
}

export function parseQorpiqDirectorHtml(html: string, expectedDin: string, url: string): DinRegistryHit | null {
  const din = normDin(expectedDin);
  if (!din) return null;
  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (!title || /^din\s+\d{8}$/i.test(title)) return null;
  const body = $("body").text();
  if (!body.includes(din)) return null;
  const companies: RegistryCompany[] = [];
  $("table tbody tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .toArray()
      .map((td) => $(td).text().replace(/\s+/g, " ").trim());
    if (cells.length < 3) return;
    const name = cells[0] || "";
    const cin = (cells[1] || "").toUpperCase();
    if (!name || !/[A-Z]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}/.test(cin)) return;
    companies.push({
      name,
      cin,
      status: cells[5] || cells[cells.length - 1] || "Active",
      designation: cells[2] || "Director",
      as_of: parseAppointment(cells[4] || ""),
    });
  });
  return {
    din,
    name: title,
    source: "qorpiq_din",
    source_url: url,
    companies,
  };
}

export function parseDirectorRegistryHtml(html: string, din: string, url: string): DinRegistryHit | null {
  const host = url.toLowerCase();
  if (host.includes("tofler.in")) return parseToflerDirectorHtml(html, din);
  if (host.includes("masterdata.in")) return parseMasterdataDirectorHtml(html, din, url);
  if (host.includes("qorpiq.com")) return parseQorpiqDirectorHtml(html, din, url);
  if (host.includes("registerkaro.in")) return parseRegisterKaroHtml(html, din, url);
  return (
    parseToflerDirectorHtml(html, din) ||
    parseMasterdataDirectorHtml(html, din, url) ||
    parseQorpiqDirectorHtml(html, din, url) ||
    parseRegisterKaroHtml(html, din, url)
  );
}

export function parseToflerDirectorHtml(html: string, expectedDin: string): DinRegistryHit | null {
  const din = normDin(expectedDin);
  if (!din) return null;
  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (!title || /^din\s+\d{8}$/i.test(title)) return null;
  const pageDin = normDin(
    $("p")
      .filter((_, el) => /^\d{8}$/.test($(el).text().trim()))
      .first()
      .text() ||
      html.match(/\b(\d{8})\b/)?.[1] ||
      "",
  );
  if (pageDin && pageDin !== din) return null;

  const companies: RegistryCompany[] = [];
  const rows = $("#directorshipsTableBody tr, table#data-table tbody tr");
  if (!rows.length) return null;
  rows.each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .toArray()
      .map((td) => $(td).text().replace(/\s+/g, " ").trim());
    if (cells.length < 4) return;
    const href = $(tr).find("a[href*='/company/']").attr("href") || "";
    const cin = (href.match(/\/company\/([A-Z0-9]{21})/i)?.[1] || "").toUpperCase();
    const name = cells[0] || "";
    if (!name) return;
    companies.push({
      name,
      cin,
      status: cells[3] || "",
      designation: cells[6] || cells[cells.length - 1] || "Director",
      as_of: parseAppointment(cells[4] || ""),
    });
  });

  return {
    din,
    name: title,
    source: "tofler_din",
    source_url: `https://www.tofler.in/director/${din}`,
    companies,
  };
}

export function parseRegisterKaroHtml(html: string, expectedDin: string, url: string): DinRegistryHit | null {
  const din = normDin(expectedDin);
  if (!din) return null;
  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (!title || /^din\s+\d{8}$/i.test(title)) return null;
  const body = $("body").text().replace(/\s+/g, " ");
  if (!body.includes(din) && !body.includes(dinUnpadded(din))) return null;

  const companies: RegistryCompany[] = [];
  $("h2, h3")
    .filter((_, el) => /directorship/i.test($(el).text()))
    .parent()
    .find("a, li, article")
    .each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      const name = text
        .replace(/\b(ACTIVE|RESIGNED|Director|Managing|Independent)\b.*$/i, "")
        .trim();
      if (name.length < 4 || name.length > 120) return;
      if (!/\blimited\b|\bltd\b/i.test(name)) return;
      companies.push({
        name,
        cin: "",
        status: /resign/i.test(text) ? "Resigned" : "Active",
        designation: /independent/i.test(text)
          ? "Independent Director"
          : /managing/i.test(text)
            ? "Managing Director"
            : "Director",
        as_of: "",
      });
    });

  return {
    din,
    name: title,
    source: "registerkaro_din",
    source_url: url,
    companies,
  };
}

function parseMasterdataDirectorHtml(html: string, expectedDin: string, url: string): DinRegistryHit | null {
  const din = normDin(expectedDin);
  if (!din) return null;
  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (!title || /^din\s+\d{8}$/i.test(title)) return null;
  const companies: RegistryCompany[] = [];
  $("table tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const name = $tr.find("a").first().text().replace(/\s+/g, " ").trim();
    if (!name) return;
    const href = $tr.find("a[href*='/company/']").attr("href") || "";
    const cin = (
      href.match(/\/([A-Z]{1}\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})/i)?.[1] ||
      $tr.text().match(/\b([A-Z]{1}\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b/)?.[1] ||
      ""
    ).toUpperCase();
    const cells = $tr
      .find("td")
      .toArray()
      .map((td) => $(td).text().replace(/\s+/g, " ").trim());
    companies.push({
      name,
      cin,
      status: cells[3] || "",
      designation: cells[1] || "Director",
      as_of: parseAppointment(cells[2] || ""),
    });
  });
  return {
    din,
    name: title,
    source: "masterdata_din",
    source_url: url,
    companies,
  };
}

async function lookupMasterdata(din: string): Promise<DinRegistryHit | null> {
  const search = await fetchHtml(`https://www.masterdata.in/search?q=${encodeURIComponent(din)}`);
  if (!search) return null;
  const $ = cheerio.load(search);
  let path = "";
  $("a[href*='/director/']").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (href.includes(din) && !path) path = href;
  });
  if (!path) return null;
  const url = path.startsWith("http") ? path : `https://www.masterdata.in${path}`;
  const html = await fetchHtml(url);
  if (!html) return null;
  return parseMasterdataDirectorHtml(html, din, url);
}

export async function lookupDinOnMcaDirectories(rawDin: string): Promise<DinRegistryHit | null> {
  const din = normDin(rawDin);
  if (!din || din.length !== 8) return null;

  const tofler = await fetchHtml(`https://www.tofler.in/director/${din}`);
  const toflerHit = tofler ? parseToflerDirectorHtml(tofler, din) : null;

  if (toflerHit) {
    const rkUrl = `https://www.registerkaro.in/company-details/directors/${slugName(toflerHit.name)}-${dinUnpadded(din)}`;
    const rkHtml = await fetchHtml(rkUrl);
    const rkHit = rkHtml ? parseRegisterKaroHtml(rkHtml, din, rkUrl) : null;
    if (rkHit?.name) {
      const names = new Map<string, RegistryCompany>();
      for (const c of [...rkHit.companies, ...toflerHit.companies]) {
        const key = c.cin || c.name.toLowerCase();
        if (!names.has(key)) names.set(key, c);
      }
      return {
        ...toflerHit,
        name: rkHit.name,
        source: rkHit.companies.length ? "registerkaro_din" : toflerHit.source,
        source_url: rkHit.companies.length ? rkUrl : toflerHit.source_url,
        companies: [...names.values()],
      };
    }
    return toflerHit;
  }

  return lookupMasterdata(din);
}

export async function lookupDinFromPage(
  rawDin: string,
  url: string,
): Promise<DinRegistryHit | null> {
  const din = normDin(rawDin);
  if (!din || !url) return null;
  const html = await fetchHtml(url);
  if (!html) return null;
  return parseDirectorRegistryHtml(html, din, url);
}

export function companyMatchKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(limited|ltd|pvt|private|plc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ListedMatch = {
  ticker: string;
  name: string;
  market: string;
  designation: string;
  as_of: string;
};

type ListingRow = { ticker: string; name: string; market: string; cin: string };

let listingCache: {
  byCin: Map<string, ListingRow>;
  byKey: Map<string, ListingRow[]>;
} | null = null;

function loadListingIndex(): {
  byCin: Map<string, ListingRow>;
  byKey: Map<string, ListingRow[]>;
} {
  if (listingCache) return listingCache;
  const byCin = new Map<string, ListingRow>();
  const byKey = new Map<string, ListingRow[]>();
  const add = (row: ListingRow) => {
    const ticker = row.ticker.toUpperCase();
    if (!ticker || !row.name) return;
    const rec = {
      ticker,
      name: row.name,
      market: row.market || "NSE",
      cin: (row.cin || "").toUpperCase(),
    };
    if (rec.cin && rec.cin.length === 21) byCin.set(rec.cin, rec);
    const key = companyMatchKey(rec.name);
    if (!key) return;
    const list = byKey.get(key) || [];
    if (!list.some((x) => x.ticker === rec.ticker)) list.push(rec);
    byKey.set(key, list);
  };

  const govPath = path.join(DATA_DIR, "governance.db");
  if (fs.existsSync(govPath)) {
    const db = new Database(govPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(`SELECT ticker, name, market, COALESCE(cin, '') AS cin FROM companies`)
        .all() as ListingRow[];
      for (const r of rows) add(r);
    } finally {
      db.close();
    }
  }

  const aboutPath = path.join(DATA_DIR, "company_about.db");
  if (fs.existsSync(aboutPath)) {
    const db = new Database(aboutPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT ticker, name, COALESCE(market, '') AS market, '' AS cin FROM company_about WHERE TRIM(COALESCE(name, '')) != ''`,
        )
        .all() as ListingRow[];
      for (const r of rows) add(r);
    } finally {
      db.close();
    }
  }

  listingCache = { byCin, byKey };
  return listingCache;
}

function isActiveStatus(status: string): boolean {
  const t = status.toLowerCase();
  if (!t) return true;
  if (/strike|dissolv|amalgam|liquid|dead/i.test(t)) return false;
  if (/resign/i.test(t) && !/active/i.test(t)) return false;
  return true;
}

export function matchRegistryCompaniesToListings(
  companies: RegistryCompany[],
): { matched: ListedMatch[]; unmatched: string[] } {
  const { byCin, byKey } = loadListingIndex();
  const matched: ListedMatch[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();

  for (const c of companies) {
    if (!isActiveStatus(c.status)) continue;
    let hit: ListingRow | undefined;
    if (c.cin) hit = byCin.get(c.cin.toUpperCase());
    if (!hit) {
      const key = companyMatchKey(c.name);
      const list = key ? byKey.get(key) : undefined;
      if (list?.length === 1) hit = list[0];
    }
    if (!hit) {
      unmatched.push(c.name);
      continue;
    }
    if (seen.has(hit.ticker)) continue;
    seen.add(hit.ticker);
    matched.push({
      ticker: hit.ticker,
      name: hit.name,
      market: hit.market,
      designation: c.designation || "Director",
      as_of: c.as_of || "",
    });
  }
  return { matched, unmatched };
}

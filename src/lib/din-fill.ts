/**
 * Research · Fill DIN: one missing board at a time, Zauba screenshot → governance.db
 */
import { pendingWebDinJobs, regexBoardDinsFromText } from "./board-din-web";
import { bootstrapCompanyTicker } from "./company-ticker-bootstrap";
import { ensureCompanyAboutRow } from "./company-about-write";
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { invalidateCompanyCache, loadAllCompanies } from "./db";
import { invalidateGovernanceMapCache } from "./governance-map";
import { invalidateBoardIndependenceCache } from "./gov-independence";
import { openSqliteNamed } from "./sqlite-utils";
import {
  parseScreenshotBoard,
  parseCompanyLabelsFromBoardText,
  parsePersonCompanyRoles,
  parseTickerBoardNotes,
} from "./din-screenshot-parse";
import {
  listingQueryVariants,
  pickUniqueListing,
  scoreListingName,
} from "./listing-name-match";
import {
  ensureGovernanceCompanyStub,
  listCompanyBoardSeats,
  recordScanAttempt,
  relinkSeatToSourceDin,
  saveCompanyBoard,
  tickerMostSharingDins,
} from "./governance-write";
import { inferDirectorCategory, normDin, type BoardSeat } from "./nse-governance";
import { zaubaCorpGoogleUrl, zaubaCorpSearchQuery, zaubaCorpSiteSearchUrl } from "./links";
import { searchGrowwListings } from "./web-mcap";

const OCR_PROMPT =
  "One pass: company title (after Personnel of if present), then each director row as name\\tDIN\\tdesignation. Use the person name — not Managing/Independent/Whole-time. Plain text only.";

/** Prefer Tesseract; accept only when ≥2 DIN seats parse (else vision). */
async function ocrDinScreenshot(imageDataUrl: string): Promise<string> {
  return ocrImageWithQianfan(imageDataUrl, OCR_PROMPT, 1536, {
    maxEdge: 896,
    numCtx: 4096,
    acceptLocal: (text) => {
      const seats = mergeSeats(
        parseScreenshotBoard(text).seats,
        regexBoardDinsFromText(text),
      );
      return seats.length >= 2;
    },
  });
}

export type DinFillJob = {
  ticker: string;
  name: string;
  market: string;
  zauba_query: string;
  zauba_google: string;
  zauba_site: string;
};

function jobFromPending(p: {
  ticker: string;
  name: string;
  market: string;
}): DinFillJob {
  return {
    ticker: p.ticker,
    name: p.name,
    market: p.market,
    zauba_query: zaubaCorpSearchQuery(p.name),
    zauba_google: zaubaCorpGoogleUrl(p.name),
    zauba_site: zaubaCorpSiteSearchUrl(p.name),
  };
}

export function listMissingDinJobs(limit = 80): {
  current: DinFillJob | null;
  remaining: number;
  queue: DinFillJob[];
} {
  const pending = pendingWebDinJobs({ missingOnly: true });
  const cap = Math.min(200, Math.max(1, limit));
  const queue = pending.slice(0, cap).map(jobFromPending);
  return {
    current: queue[0] ?? null,
    remaining: pending.length,
    queue,
  };
}

function mergeSeats(a: BoardSeat[], b: BoardSeat[]): BoardSeat[] {
  const byDin = new Map<string, BoardSeat>();
  for (const s of [...a, ...b]) {
    if (!s.din || s.din.length !== 8) continue;
    if (!byDin.has(s.din)) byDin.set(s.din, s);
  }
  return [...byDin.values()];
}

export type DinFillListing = {
  ticker: string;
  name: string;
  market: string;
};

export type DinFillPreview = {
  company_extracted: string | null;
  labels: string[];
  ticker: string | null;
  listing_name: string | null;
  market: string | null;
  groww: DinFillListing | null;
  seats: BoardSeat[];
  ocr_chars: number;
  why: string;
};

type ListingRow = { ticker: string; name: string; market?: string };

/** About + governance stubs (thin BSE names often only live in governance). */
function listingUniverse(): ListingRow[] {
  const by = new Map<string, ListingRow>();
  const addAbout = () => {
    for (const c of loadAllCompanies()) {
      const ticker = String(c.ticker || "").trim().toUpperCase();
      if (!ticker) continue;
      by.set(ticker, {
        ticker,
        name: String(c.name || ticker).trim() || ticker,
        market: String(c.market || "").trim() || undefined,
      });
    }
  };
  try {
    addAbout();
  } catch {
    // Transient About disk I/O — drop cached FDs and retry once.
    try {
      invalidateCompanyCache();
      addAbout();
    } catch {
      /* governance-only universe still usable */
    }
  }
  try {
    const db = openSqliteNamed("governance.db", {
      readonly: true,
      fileMustExist: true,
      quickCheck: false,
    });
    try {
      const rows = db
        .prepare(`SELECT ticker, name, market FROM companies`)
        .all() as Array<{ ticker: string; name: string; market: string }>;
      for (const c of rows) {
        const ticker = String(c.ticker || "").trim().toUpperCase();
        if (!ticker || by.has(ticker)) continue;
        by.set(ticker, {
          ticker,
          name: String(c.name || ticker).trim() || ticker,
          market: String(c.market || "").trim() || undefined,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    /* about rows still usable */
  }
  return [...by.values()];
}

function hintFitsLabels(
  hint: ListingRow | null,
  labels: string[],
): boolean {
  if (!hint) return false;
  // No OCR/company labels → do not keep a sticky prior ticker (wrong house).
  if (!labels.length) return false;
  return labels.some(
    (label) => scoreListingName(label, hint.ticker, hint.name) >= 70,
  );
}

async function matchListing(opts: {
  labels: string[];
  hintTicker?: string;
  dins?: string[];
}): Promise<{
  local: ListingRow | null;
  groww: DinFillListing | null;
}> {
  const hintTicker = (opts.hintTicker || "").trim().toUpperCase();
  const companies = listingUniverse();
  const labels = opts.labels.filter((x) => x && x.trim());
  const hintRow = hintTicker
    ? companies.find((c) => c.ticker.toUpperCase() === hintTicker) || null
    : null;
  const preferHint = hintFitsLabels(hintRow, labels) ? hintTicker : undefined;

  let picked: ListingRow | null = null;
  for (const label of labels) {
    picked = pickUniqueListing(label, companies, preferHint);
    if (picked) break;
  }
  if (!picked) {
    const scored = labels.flatMap((label) =>
      companies.map((c) => ({
        c,
        s: scoreListingName(label, c.ticker, c.name),
      })),
    );
    scored.sort((a, b) => b.s - a.s);
    const best = scored[0];
    const second = scored[1];
    if (best && best.s >= 70 && (!second || best.s >= second.s + 3)) {
      picked = best.c;
    }
  }

  let groww: DinFillListing | null = null;
  // Skip Groww when local/hint already matched — sequential Groww was a big lag after OCR.
  if (!picked && labels.length) {
    try {
      const queries: string[] = [];
      for (const label of labels) {
        for (const v of listingQueryVariants(label)) {
          if (!queries.includes(v)) queries.push(v);
        }
      }
      const remote: Awaited<ReturnType<typeof searchGrowwListings>> = [];
      const seenT = new Set<string>();
      // Cap + parallel: first few variants cover nearly all BSE stubs.
      const batches = await Promise.all(
        queries.slice(0, 3).map((q) => searchGrowwListings(q, 6)),
      );
      for (const hits of batches) {
        for (const hit of hits) {
          const k = hit.ticker.toUpperCase();
          if (seenT.has(k)) continue;
          seenT.add(k);
          remote.push(hit);
        }
      }
      let g = null as (typeof remote)[number] | null;
      for (const label of [...labels, ...queries]) {
        g = pickUniqueListing(label, remote, preferHint);
        if (g) break;
      }
      if (!g && remote.length === 1) g = remote[0]!;
      if (g) {
        groww = { ticker: g.ticker, name: g.name, market: g.market };
        picked = companies.find(
          (c) => c.ticker.toUpperCase() === g!.ticker.toUpperCase(),
        ) || { ticker: g.ticker, name: g.name, market: g.market };
      }
    } catch {
      /* local listing match still usable */
    }
  }

  if (!picked && hintFitsLabels(hintRow, labels)) {
    picked = hintRow;
  }
  if (!picked && !labels.length && opts.dins?.length) {
    const dinHit = tickerMostSharingDins(opts.dins);
    if (dinHit) {
      picked =
        companies.find((c) => c.ticker.toUpperCase() === dinHit) || null;
    }
  }

  return { local: picked, groww };
}

export async function resolveDinCompany(opts: {
  company: string;
  ticker?: string;
}): Promise<DinFillPreview> {
  const company = opts.company.trim();
  const hint = (opts.ticker || "").trim().toUpperCase();
  const { local, groww } = await matchListing({
    labels: company ? [company] : [],
    hintTicker: hint,
  });
  const ticker = (local?.ticker || groww?.ticker || hint || "").toUpperCase() || null;
  const listing_name = local?.name || groww?.name || null;
  return {
    company_extracted: company || null,
    labels: company ? [company] : [],
    ticker,
    listing_name,
    market: local?.market || groww?.market || null,
    groww,
    seats: [],
    ocr_chars: 0,
    why: ticker
      ? `Matched ${ticker}${listing_name ? ` · ${listing_name}` : ""}`
      : company
        ? `No listing match for “${company}”. Edit the name or pick a ticker.`
        : "Enter a company name or ticker.",
  };
}

export async function previewDinScreenshot(opts: {
  ticker?: string;
  imageDataUrl: string;
}): Promise<DinFillPreview> {
  const ocr = await ocrDinScreenshot(opts.imageDataUrl);
  const parsed = parseScreenshotBoard(ocr);
  const regex = regexBoardDinsFromText(ocr);
  const seats = mergeSeats(parsed.seats, regex);
  if (!seats.length) {
    const clip = ocr.replace(/\s+/g, " ").trim().slice(0, 220);
    throw new Error(
      clip
        ? `No DIN + name rows. OCR saw: ${clip}`
        : "No DIN + name rows (empty OCR — check vision OCR)",
    );
  }

  const labels = [
    parsed.company,
    ...parseCompanyLabelsFromBoardText(ocr),
  ].filter((x): x is string => Boolean(x && x.trim()));
  // Prefer symbol printed on the screenshot over a sticky prior listing chip.
  const ocrTicker = (parsed.ticker || "").trim().toUpperCase();
  const hintTicker = (ocrTicker || opts.ticker || "").trim().toUpperCase();
  let local: ListingRow | null = null;
  let groww: DinFillListing | null = null;
  try {
    const matched = await matchListing({
      labels,
      hintTicker,
      dins: seats.map((s) => s.din),
    });
    local = matched.local;
    groww = matched.groww;
  } catch {
    // Seats still usable — user can pick ticker if About I/O is flaky.
  }
  // Explicit NSE/BSE symbol on the image wins when it exists locally.
  if (ocrTicker) {
    const ocrHit = listingUniverse().find(
      (c) => c.ticker.toUpperCase() === ocrTicker,
    );
    if (ocrHit) local = ocrHit;
  }
  const ticker =
    (local?.ticker || groww?.ticker || ocrTicker || "").toUpperCase() || null;  const listing_name = local?.name || groww?.name || null;
  const company = parsed.company || labels[0] || null;
  let why = `Read ${seats.length} DIN row(s). Approve to save.`;
  if (ticker) {
    why = `Matched ${ticker}${listing_name ? ` · ${listing_name}` : ""}. Approve to save.`;
  } else if (company) {
    why = `Read ${seats.length} DIN row(s). Could not match “${company}” — edit the name or pick a ticker.`;
  } else {
    why = `Read ${seats.length} DIN row(s). No company in OCR — type the name or pick a ticker.`;
  }
  return {
    company_extracted: company,
    labels,
    ticker,
    listing_name,
    market: local?.market || groww?.market || null,
    groww,
    seats,
    ocr_chars: ocr.length,
    why,
  };
}

export async function saveDinSeats(opts: {
  ticker?: string;
  company?: string;
  seats: BoardSeat[];
}): Promise<{
  ticker: string;
  company_extracted: string | null;
  seats: BoardSeat[];
  saved: number;
  why: string;
}> {
  const seats = mergeSeats(opts.seats, []);
  if (!seats.length) throw new Error("No DIN seats to save");
  const hint = (opts.ticker || "").trim().toUpperCase();
  const company = (opts.company || "").trim();
  const { local, groww } = await matchListing({
    labels: company ? [company] : [],
    hintTicker: hint,
    dins: seats.map((s) => s.din),
  });
  let ticker = (local?.ticker || groww?.ticker || hint).toUpperCase();
  let listingName = local?.name || groww?.name || company;
  let market = local?.market || groww?.market || "";
  if (!ticker) {
    throw new Error(
      company
        ? `Could not match “${company}” to a ticker.`
        : "Pick a ticker or enter a company name before saving.",
    );
  }
  let co = loadAllCompanies().find((c) => c.ticker.toUpperCase() === ticker);
  if (!co) {
    await bootstrapCompanyTicker(ticker, {
      name: listingName || company || ticker,
      market: market || undefined,
    });
    invalidateCompanyCache();
    co = loadAllCompanies().find((c) => c.ticker.toUpperCase() === ticker);
  }
  if (!co) {
    // Last resort: write the about row from the approved name/ticker so DIN
    // save is not blocked by Yahoo/Groww misses on thin BSE names.
    ensureCompanyAboutRow(ticker, {
      name: listingName || company || ticker,
      market: market || "BSE",
    });
    ensureGovernanceCompanyStub({
      ticker,
      name: listingName || company || ticker,
      market: market || "BSE",
    });
    invalidateCompanyCache();
    co = loadAllCompanies().find((c) => c.ticker.toUpperCase() === ticker);
  }
  if (!co) throw new Error(`Could not add listing ${ticker}.`);
  ticker = co.ticker.toUpperCase();
  listingName = co.name || listingName;
  market = co.market || market;

  const saved = saveCompanyBoard({
    ticker,
    name: listingName || ticker,
    market,
    seats,
    notes: "zauba_screenshot",
    replaceSeats: true,
    protectDinBoard: false,
  });
  recordScanAttempt(ticker, "ok", `zauba screenshot ${seats.length} seats`);
  invalidateGovernanceMapCache();
  invalidateBoardIndependenceCache();

  return {
    ticker,
    company_extracted: company || listingName,
    seats,
    saved: saved.seats,
    why: saved.skipped
      ? saved.reason || "skipped"
      : `Saved ${saved.seats} DIN seats on ${ticker}`,
  };
}

function isControlKmpRole(designation: string): boolean {
  return /\bcfo\b|\bceo\b|chief financial|chief executive|managing director|\bmd\b/i.test(
    designation,
  );
}

/** Relink existing named seats to DINs from labeled company notes. Never replaces a board. */
export function applyTickerBoardDinNotes(text: string): {
  parsed: number;
  updated: number;
  skipped: number;
  details: string[];
} {
  const chunks = parseTickerBoardNotes(text);
  const details: string[] = [];
  let parsed = 0;
  let updated = 0;
  let skipped = 0;
  for (const chunk of chunks) {
    const ticker = (chunk.ticker || "").toUpperCase();
    for (const seat of chunk.seats) {
      parsed += 1;
      const result = relinkSeatToSourceDin({
        ticker,
        name: seat.name,
        din: seat.din,
        designation: seat.designation,
        source: "din_note",
      });
      details.push(result.reason);
      if (result.ok && /→/.test(result.reason)) updated += 1;
      else if (result.ok) skipped += 1;
      else skipped += 1;
    }
  }
  if (updated) {
    invalidateGovernanceMapCache();
    invalidateBoardIndependenceCache();
  }
  return { parsed, updated, skipped, details };
}

/** Merge KMP/board bios onto existing boards (never replace a listed board). */
export async function applyPersonRoleNotes(text: string): Promise<{
  parsed: number;
  saved: number;
  skipped: number;
  details: string[];
}> {
  const rows = parsePersonCompanyRoles(text);
  const details: string[] = [];
  let saved = 0;
  let skipped = 0;
  for (const row of rows) {
    const { local, groww } = await matchListing({ labels: [row.company] });
    const ticker = (local?.ticker || groww?.ticker || "").toUpperCase();
    const listingName = local?.name || groww?.name || row.company;
    const market = local?.market || groww?.market || "";
    if (!ticker) {
      skipped += 1;
      details.push(`No listing for “${row.company}”`);
      continue;
    }
    const din = normDin(row.din);
    const existing = listCompanyBoardSeats(ticker);
    const prior = existing.find((s) => normDin(s.din || "") === din);
    if (prior && !isControlKmpRole(row.designation)) {
      skipped += 1;
      details.push(`Kept ${ticker} seat ${din}`);
      continue;
    }
    if (prior && isControlKmpRole(prior.designation || "")) {
      skipped += 1;
      details.push(`Already ${ticker} ${prior.designation}`);
      continue;
    }
    const seats: BoardSeat[] = [
      {
        din,
        name: row.name,
        designation: row.designation,
        category: inferDirectorCategory(row.designation),
        source: "kmp_note",
        as_of: "",
      },
    ];
    const result = saveCompanyBoard({
      ticker,
      name: listingName || ticker,
      market: market || undefined,
      seats,
      notes: "kmp_note",
      replaceSeats: false,
      protectDinBoard: false,
    });
    if (result.skipped) {
      skipped += 1;
      details.push(result.reason || `skipped ${ticker}`);
      continue;
    }
    saved += 1;
    recordScanAttempt(ticker, "ok", `kmp note ${din} ${row.designation}`);
    details.push(`Saved ${row.designation} on ${ticker}`);
  }
  if (saved) {
    invalidateGovernanceMapCache();
    invalidateBoardIndependenceCache();
  }
  return { parsed: rows.length, saved, skipped, details };
}

export async function applyDinScreenshot(opts: {
  ticker?: string;
  imageDataUrl: string;
  save?: boolean;
}): Promise<DinFillPreview & { saved: number }> {
  const preview = await previewDinScreenshot(opts);
  if (!opts.save) return { ...preview, saved: 0 };
  const saved = await saveDinSeats({
    ticker: preview.ticker || opts.ticker,
    company: preview.company_extracted || undefined,
    seats: preview.seats,
  });
  return {
    ...preview,
    ticker: saved.ticker,
    listing_name: saved.company_extracted,
    saved: saved.saved,
    why: saved.why,
  };
}

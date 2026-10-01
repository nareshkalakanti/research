/**
 * Research · Fill DIN: one missing board at a time, Zauba screenshot → governance.db
 */
import { pendingWebDinJobs, regexBoardDinsFromText } from "./board-din-web";
import { bootstrapCompanyTicker } from "./company-ticker-bootstrap";
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { invalidateCompanyCache, loadAllCompanies } from "./db";
import { invalidateGovernanceMapCache } from "./governance-map";
import { invalidateBoardIndependenceCache } from "./gov-independence";
import {
  parseScreenshotBoard,
  parseCompanyLabelsFromBoardText,
  parsePersonCompanyRoles,
} from "./din-screenshot-parse";
import {
  listingQueryVariants,
  pickUniqueListing,
  scoreListingName,
} from "./listing-name-match";
import {
  listCompanyBoardSeats,
  recordScanAttempt,
  saveCompanyBoard,
  tickerMostSharingDins,
} from "./governance-write";
import { inferDirectorCategory, normDin, type BoardSeat } from "./nse-governance";
import { zaubaCorpGoogleUrl, zaubaCorpSearchQuery, zaubaCorpSiteSearchUrl } from "./links";
import { searchGrowwListings } from "./web-mcap";

const OCR_PROMPT =
  "Transcribe the heading (Personnel of COMPANY) then one director per line: 8-digit DIN, name, designation, appointment date. Tab-separated. No HTML.";

const HEADING_OCR =
  "Read the card title only. Output the company after Personnel of. One line. No table.";

async function ocrDinScreenshot(imageDataUrl: string): Promise<string> {
  const chunks: string[] = [];
  try {
    const { cropImageDataUrlTop } = await import("./pdf-rasterize");
    const top = await cropImageDataUrlTop(imageDataUrl, 0.4);
    if (top) chunks.push(await ocrImageWithQianfan(top, HEADING_OCR));
  } catch {
    /* table OCR still runs */
  }
  chunks.push(await ocrImageWithQianfan(imageDataUrl, OCR_PROMPT));
  return chunks.filter((t) => t.trim()).join("\n");
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

async function matchListing(opts: {
  labels: string[];
  hintTicker?: string;
  dins?: string[];
}): Promise<{
  local: ListingRow | null;
  groww: DinFillListing | null;
}> {
  const hintTicker = (opts.hintTicker || "").trim().toUpperCase();
  const companies = loadAllCompanies();
  const labels = opts.labels.filter((x) => x && x.trim());

  let picked: ListingRow | null = hintTicker
    ? companies.find((c) => c.ticker.toUpperCase() === hintTicker) || null
    : null;
  for (const label of labels) {
    if (picked) break;
    picked = pickUniqueListing(label, companies, hintTicker);
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
  if (!picked && opts.dins?.length) {
    const dinHit = tickerMostSharingDins(opts.dins);
    if (dinHit) {
      picked =
        companies.find((c) => c.ticker.toUpperCase() === dinHit) || null;
    }
  }

  let groww: DinFillListing | null = null;
  if (!picked && labels.length) {
    try {
      const queries = listingQueryVariants(labels.join(" "));
      for (const label of labels) {
        for (const v of listingQueryVariants(label)) {
          if (!queries.includes(v)) queries.push(v);
        }
      }
      const remote: Awaited<ReturnType<typeof searchGrowwListings>> = [];
      const seenT = new Set<string>();
      for (const q of queries) {
        for (const hit of await searchGrowwListings(q, 8)) {
          const k = hit.ticker.toUpperCase();
          if (seenT.has(k)) continue;
          seenT.add(k);
          remote.push(hit);
        }
      }
      let g = null as (typeof remote)[number] | null;
      for (const label of [...labels, ...queries]) {
        g = pickUniqueListing(label, remote, hintTicker);
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

  const hintTicker = (
    opts.ticker ||
    parsed.ticker ||
    ""
  ).trim().toUpperCase();
  const labels = [
    parsed.company,
    ...parseCompanyLabelsFromBoardText(ocr),
  ].filter((x): x is string => Boolean(x && x.trim()));
  const { local, groww } = await matchListing({
    labels,
    hintTicker,
    dins: seats.map((s) => s.din),
  });
  const ticker =
    (local?.ticker || groww?.ticker || hintTicker || "").toUpperCase() || null;
  const listing_name = local?.name || groww?.name || null;
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
      name: listingName || ticker,
      market: market || undefined,
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

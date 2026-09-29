/**
 * Research · Fill DIN: one missing board at a time, Zauba screenshot → governance.db
 */
import { pendingWebDinJobs, regexBoardDinsFromText } from "./board-din-web";
import { bootstrapCompanyTicker } from "./company-ticker-bootstrap";
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { invalidateCompanyCache, loadAllCompanies } from "./db";
import { invalidateGovernanceMapCache } from "./governance-map";
import { invalidateBoardIndependenceCache } from "./gov-independence";
import { parseScreenshotBoard } from "./din-screenshot-parse";
import { pickUniqueListing } from "./listing-name-match";
import {
  recordScanAttempt,
  saveCompanyBoard,
} from "./governance-write";
import type { BoardSeat } from "./nse-governance";
import { zaubaCorpGoogleUrl, zaubaCorpSearchQuery, zaubaCorpSiteSearchUrl } from "./links";
import { searchGrowwListings } from "./web-mcap";

const OCR_PROMPT =
  "Transcribe this Current Directors table. Keep company name, each 8-digit DIN, director name, designation. Plain text, one person per line.";

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

export async function applyDinScreenshot(opts: {
  ticker?: string;
  imageDataUrl: string;
}): Promise<{
  ticker: string;
  company_extracted: string | null;
  seats: BoardSeat[];
  saved: number;
  ocr_chars: number;
  why: string;
}> {
  const ocr = await ocrImageWithQianfan(opts.imageDataUrl, OCR_PROMPT);
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

  const companies = loadAllCompanies();
  let picked = parsed.company
    ? pickUniqueListing(parsed.company, companies)
    : null;
  if (!picked && parsed.company) {
    try {
      const remote = await searchGrowwListings(parsed.company, 8);
      const g = pickUniqueListing(parsed.company, remote);
      if (g) {
        await bootstrapCompanyTicker(g.ticker, {
          name: g.name,
          market: g.market,
        });
        invalidateCompanyCache();
        picked = pickUniqueListing(parsed.company, loadAllCompanies());
      }
    } catch {
      /* local listing match still usable */
    }
  }

  let ticker = (picked?.ticker || "").trim().toUpperCase();
  let co = ticker
    ? loadAllCompanies().find((c) => c.ticker.toUpperCase() === ticker) ||
      companies.find((c) => c.ticker.toUpperCase() === ticker)
    : undefined;
  if (!co && ticker) {
    await bootstrapCompanyTicker(ticker, {
      name: parsed.company || ticker,
    });
    invalidateCompanyCache();
    co = loadAllCompanies().find((c) => c.ticker.toUpperCase() === ticker);
  }
  if (!co) {
    const label = (parsed.company || "").trim();
    throw new Error(
      label
        ? `Could not match “${label}” to a ticker. Paste a Zauba page that shows the company name.`
        : "No company name in the screenshot, so nothing was saved.",
    );
  }
  ticker = co.ticker.toUpperCase();

  const saved = saveCompanyBoard({
    ticker,
    name: co.name || parsed.company || ticker,
    market: co.market,
    seats,
    notes: "zauba_screenshot",
    replaceSeats: true,
    protectDinBoard: false,
  });
  recordScanAttempt(ticker, "ok", `zauba screenshot ${seats.length} seats`);
  invalidateGovernanceMapCache();
  invalidateBoardIndependenceCache();

  const matched = parsed.company
    ? ` on ${ticker} (matched “${parsed.company}”)`
    : ` on ${ticker}`;

  return {
    ticker,
    company_extracted: parsed.company,
    seats,
    saved: saved.seats,
    ocr_chars: ocr.length,
    why: saved.skipped
      ? saved.reason || "skipped"
      : `Saved ${saved.seats} DIN seats${matched}`,
  };
}

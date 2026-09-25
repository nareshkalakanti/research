/**
 * Web + Qwen board DIN fill for tickers missing NSE DIN boards.
 * Fetches public evidence (company site, DuckDuckGo snippets, registry pages),
 * extracts Name / Designation / 8-digit DIN — never invents DINs.
 */
import fs from "fs";
import path from "path";
import { loadAllCompanies } from "./db";
import { invalidateGovernanceMapCache } from "./governance-map";
import { completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { normDin, type BoardSeat } from "./nse-governance";
import { lookupCompanyCurrentDirectors } from "./din-mca-lookup";
import {
  dinBoardTickerSet,
  recordScanAttempt,
  saveCompanyBoard,
  snapshotIdentities,
  diffIdentities,
  type NewIdentity,
} from "./governance-write";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function loadSystemPrompt(): string {
  try {
    const p = path.join(process.cwd(), "prompts", "board-din-web.system.txt");
    const t = fs.readFileSync(p, "utf8").trim();
    if (t) return t;
  } catch {
    /* fall through */
  }
  return `Extract Board of Directors and DIN from EVIDENCE only. Return JSON {"directors":[{"name":"","designation":"","din":""}]}. Never invent DINs.`;
}
export type WebDinJob = {
  ticker: string;
  name: string;
  market: string;
  website: string | null;
};

export type WebDinBatchResult = {
  tried: number;
  saved: number;
  skipped_empty: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  new_dins: string[];
  new_directors: NewIdentity[];
  new_seats: number;
  seat_events: number;
  done: boolean;
  source: string;
  details: Array<{
    ticker: string;
    status: "saved" | "empty" | "failed";
    seats: number;
    detail: string;
  }>;
};

function slugCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(limited|ltd|private|pvt)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string, timeoutMs = 18_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (ctype.includes("pdf")) {
      // Skip binary PDFs in the light path — text pages only.
      return null;
    }
    const html = await res.text();
    if (!html || html.length < 80) return null;
    return stripHtml(html).slice(0, 24_000);
  } catch {
    return null;
  }
}

/** Pull Name + DIN pairs from free text when the layout is obvious. */
export function regexBoardDinsFromText(text: string): BoardSeat[] {
  const seats: BoardSeat[] = [];
  const seen = new Set<string>();

  // "Name (DIN: 12345678)" / "Name DIN: 12345678" / "Name DIN 12345678"
  const re =
    /([A-Z][A-Za-z.'\-\s]{2,60}?)\s*(?:\(|\s)(?:DIN|Din|din)\s*[:#]?\s*([0-9]{8})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    const name = m[1]!.replace(/\s+/g, " ").trim().replace(/[,:]$/, "");
    const din = normDin(m[2]!);
    if (!din || din.length !== 8) continue;
    if (/^(mr|mrs|ms|dr|prof|shri|smt)\.?$/i.test(name)) continue;
    if (seen.has(din)) continue;
    seen.add(din);
    seats.push({
      din,
      name,
      designation: "Director",
      category: "",
      source: "web_din_regex",
      as_of: "",
    });
  }

  // Table-ish: Name … 8-digit DIN on same line
  for (const line of text.split(/(?<=[.|;])\s+|\n/)) {
    const dm = line.match(/\b([0-9]{8})\b/);
    if (!dm) continue;
    const din = normDin(dm[1]!);
    if (!din || seen.has(din)) continue;
    const before = line.slice(0, dm.index).trim();
    const nameMatch = before.match(
      /([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,4})\s*$/,
    );
    if (!nameMatch) continue;
    const name = nameMatch[1]!.trim();
    if (name.length < 5) continue;
    seen.add(din);
    seats.push({
      din,
      name,
      designation: "Director",
      category: "",
      source: "web_din_regex",
      as_of: "",
    });
  }

  return seats;
}

async function llmExtractDirectors(
  companyName: string,
  evidence: string,
): Promise<BoardSeat[]> {
  if (evidence.trim().length < 40) return [];
  const cfg = loadLlmConfig();
  const raw = await completeJson(
    cfg,
    loadSystemPrompt(),
    `Company: ${companyName}\n\nEVIDENCE:\n${evidence.slice(0, 14_000)}`,
    {
      temperature: 0.05,
      maxTokens: 1200,
      skipStatusCheck: false,
      jsonSchema: {
        type: "object",
        properties: {
          directors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                designation: { type: "string" },
                din: { type: "string" },
              },
              required: ["name", "designation", "din"],
            },
          },
        },
        required: ["directors"],
      },
    },
  );

  const list = Array.isArray(raw.directors) ? raw.directors : [];
  const seats: BoardSeat[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const name = String(r.name || "").trim();
    const designation = String(r.designation || "Director").trim() || "Director";
    const dinRaw = String(r.din || "").trim();
    if (!name) continue;
    if (/not found|n\/a|na|unknown/i.test(dinRaw)) continue;
    const din = normDin(dinRaw);
    if (!din || din.length !== 8) continue;
    if (seen.has(din)) continue;
    seen.add(din);
    seats.push({
      din,
      name,
      designation,
      category: "",
      source: "web_din_qwen",
      as_of: "",
    });
  }
  return seats;
}

function mergeSeats(...groups: BoardSeat[][]): BoardSeat[] {
  const byDin = new Map<string, BoardSeat>();
  for (const g of groups) {
    for (const s of g) {
      const din = normDin(s.din);
      if (!din || din.length !== 8) continue;
      const prev = byDin.get(din);
      if (!prev) {
        byDin.set(din, { ...s, din });
        continue;
      }
      // Prefer richer designation / better source label.
      if (
        (s.designation || "").length > (prev.designation || "").length ||
        (prev.designation === "Director" && s.designation !== "Director")
      ) {
        byDin.set(din, { ...s, din });
      }
    }
  }
  return [...byDin.values()];
}

export async function gatherBoardDinEvidence(opts: {
  name: string;
  website?: string | null;
}): Promise<{ text: string; sources: string[] }> {
  const name = opts.name.trim();
  const slug = slugCompany(name);
  const sources: string[] = [];
  const chunks: string[] = [];

  const candidates: string[] = [];
  if (opts.website) {
    const base = opts.website.replace(/\/$/, "");
    candidates.push(
      base,
      `${base}/board-of-directors`,
      `${base}/board-of-directors-kmp`,
      `${base}/about-us/board-of-directors`,
      `${base}/investors/board-of-directors`,
      `${base}/corporate-governance`,
    );
  }
  candidates.push(
    `https://qorpiq.com/company/${slug}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
      `"${name}" board directors DIN site:qorpiq.com OR site:tofler.in OR site:sensibook.com`,
    )}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
      `${name} DIN directors board of directors`,
    )}`,
  );

  for (const url of candidates) {
    const text = await fetchText(url);
    if (!text) continue;
    // Skip Cloudflare / empty challenge pages.
    if (/security verification|just a moment|enable javascript/i.test(text)) {
      continue;
    }
    if (!/\bDIN\b|\b[0-9]{8}\b|director/i.test(text)) continue;
    sources.push(url);
    chunks.push(`--- source: ${url} ---\n${text.slice(0, 8_000)}`);
    if (chunks.join("\n").length > 20_000) break;
  }

  return { text: chunks.join("\n\n"), sources };
}

export async function extractBoardDinsForCompany(opts: {
  name: string;
  website?: string | null;
  evidenceText?: string | null;
}): Promise<{ seats: BoardSeat[]; sources: string[]; detail: string }> {
  if (!opts.evidenceText) {
    try {
      const registry = await lookupCompanyCurrentDirectors(opts.name);
      if (registry && registry.seats.length >= 3) {
        return {
          seats: registry.seats,
          sources: [registry.source_url],
          detail: `${registry.seats.length} current directors from registry table`,
        };
      }
    } catch {
      /* fall through to evidence extract */
    }
  }
  let evidence = (opts.evidenceText || "").trim();
  let sources: string[] = [];
  if (!evidence) {
    const gathered = await gatherBoardDinEvidence({
      name: opts.name,
      website: opts.website,
    });
    evidence = gathered.text;
    sources = gathered.sources;
  }

  if (!evidence) {
    return {
      seats: [],
      sources,
      detail: "No web evidence with DIN found",
    };
  }

  const regexSeats = regexBoardDinsFromText(evidence);
  let llmSeats: BoardSeat[] = [];
  try {
    llmSeats = await llmExtractDirectors(opts.name, evidence);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!regexSeats.length) {
      return {
        seats: [],
        sources,
        detail: `Qwen extract failed: ${msg.slice(0, 160)}`,
      };
    }
  }

  const seats = mergeSeats(regexSeats, llmSeats);
  return {
    seats,
    sources,
    detail: seats.length
      ? `${seats.length} DIN seat(s) from ${sources.length || "evidence"} source(s)`
      : "Evidence found but no valid 8-digit DINs extracted",
  };
}

export function pendingWebDinJobs(opts: {
  market?: string;
  tickers?: string[];
  missingOnly?: boolean;
}): WebDinJob[] {
  const missingOnly = opts.missingOnly !== false;
  const dinDone = missingOnly ? dinBoardTickerSet() : new Set<string>();
  let companies = loadAllCompanies().filter((c) => {
    const m = (c.market || "").toUpperCase();
    return m === "NSE" || m === "NSE SME";
  });

  if (opts.market && opts.market !== "All") {
    companies = companies.filter((c) => c.market === opts.market);
  }
  if (opts.tickers?.length) {
    const set = new Set(opts.tickers.map((t) => t.toUpperCase()));
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  const jobs: WebDinJob[] = [];
  for (const c of companies) {
    const ticker = c.ticker.toUpperCase();
    if (missingOnly && dinDone.has(ticker)) continue;
    jobs.push({
      ticker,
      name: c.name || ticker,
      market: c.market.toUpperCase() === "NSE SME" ? "NSE SME" : "NSE",
      website: c.website || null,
    });
  }
  jobs.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return jobs;
}

export async function runWebDinScanBatch(opts: {
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
}): Promise<WebDinBatchResult> {
  const limit = Math.min(12, Math.max(1, opts.limit ?? 5));
  const missingOnly = opts.missingOnly !== false;
  const pending = pendingWebDinJobs({
    market: opts.market,
    tickers: opts.tickers,
    missingOnly,
  });
  const batch = pending.slice(0, limit);

  const empty: WebDinBatchResult = {
    tried: 0,
    saved: 0,
    skipped_empty: 0,
    failed: 0,
    remaining: pending.length,
    saved_tickers: [],
    new_dins: [],
    new_directors: [],
    new_seats: 0,
    seat_events: 0,
    done: pending.length === 0,
    source: "web_din_qwen",
    details: [],
  };
  if (!batch.length) return empty;

  const before = snapshotIdentities();
  let saved = 0;
  let skippedEmpty = 0;
  let failed = 0;
  let seatEvents = 0;
  const savedTickers: string[] = [];
  const details: WebDinBatchResult["details"] = [];

  for (const job of batch) {
    try {
      const { seats, detail } = await extractBoardDinsForCompany({
        name: job.name,
        website: job.website,
      });
      if (!seats.length) {
        skippedEmpty += 1;
        recordScanAttempt(job.ticker, "empty", detail);
        details.push({
          ticker: job.ticker,
          status: "empty",
          seats: 0,
          detail,
        });
        continue;
      }
      const fromRegistry = seats.every(
        (s) => s.source === "registry_current_directors",
      );
      const result = saveCompanyBoard({
        ticker: job.ticker,
        name: job.name,
        market: job.market,
        seats,
        replaceSeats: fromRegistry && seats.length >= 3,
        notes: fromRegistry
          ? "Current directors from public registry table"
          : "Additive DIN seats from web + Qwen extract",
      });
      if (result.skipped) {
        skippedEmpty += 1;
        recordScanAttempt(job.ticker, "protected", result.reason || "");
        details.push({
          ticker: job.ticker,
          status: "empty",
          seats: 0,
          detail: result.reason || "protected",
        });
        continue;
      }
      saved += 1;
      seatEvents += result.events_recorded ?? 0;
      savedTickers.push(job.ticker);
      recordScanAttempt(job.ticker, "saved", detail);
      details.push({
        ticker: job.ticker,
        status: "saved",
        seats: seats.length,
        detail,
      });
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message.slice(0, 200) : "failed";
      recordScanAttempt(job.ticker, "failed", msg);
      details.push({
        ticker: job.ticker,
        status: "failed",
        seats: 0,
        detail: msg,
      });
    }
  }

  const diff = diffIdentities(before);
  invalidateGovernanceMapCache();
  const remaining = Math.max(0, pending.length - batch.length);

  return {
    tried: batch.length,
    saved,
    skipped_empty: skippedEmpty,
    failed,
    remaining,
    saved_tickers: savedTickers,
    new_dins: diff.newDins,
    new_directors: diff.newDirectors,
    new_seats: diff.newSeats,
    seat_events: seatEvents,
    done: remaining === 0,
    source: "web_din_qwen",
    details,
  };
}

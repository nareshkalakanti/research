import type { BuybackMethod, BuybackStatus } from "./types";

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

export function parseNseDate(raw: unknown): string | null {
  const text = safeStr(raw);
  if (!text || text === "-") return null;
  const m = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return text.slice(0, 10);
  const months: Record<string, string> = {
    JAN: "01",
    FEB: "02",
    MAR: "03",
    APR: "04",
    MAY: "05",
    JUN: "06",
    JUL: "07",
    AUG: "08",
    SEP: "09",
    OCT: "10",
    NOV: "11",
    DEC: "12",
  };
  const mo = months[m[2]!.toUpperCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${String(Number(m[1])).padStart(2, "0")}`;
}

export function isBuybackSubject(subject: string): boolean {
  return /buy\s*back|buyback|repurchase/i.test(subject);
}

export function parseMaxPrice(text: string): number | null {
  const patterns = [
    /(?:price|at)\s*(?:of\s*)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)/i,
    /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:\/-|\s*(?:per share|each))/i,
    /(?:buy[- ]?back|buyback)[^\d]{0,40}(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)/i,
    /(?:maximum|max\.?)\s*(?:buyback\s*)?(?:price\s*)?(?:of\s*)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]!.replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && n < 1_000_000) return n;
    }
  }
  return null;
}

export function parsePctEquity(text: string): number | null {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?(?:the\s*)?(?:total\s*)?(?:paid[- ]?up\s*)?(?:equity|share capital)/i,
    /(?:upto|up to|maximum of)\s*(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?(?:the\s*)?(?:total\s*)?(?:paid[- ]?up\s*)?(?:equity|shares)/i,
    /buy[- ]?back[^\d]{0,30}(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?(?:the\s*)?(?:total\s*)?(?:paid[- ]?up\s*)?(?:equity|shares)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n <= 100) return n;
    }
  }
  return null;
}

export function parseShareCount(text: string): number | null {
  const patterns = [
    /(?:up to|upto|buyback of)\s*([\d,]+)\s*(?:\([^)]*\)\s*)?(?:fully paid[- ]?up\s*)?equity shares/i,
    /([\d,]+)\s*(?:\([^)]*\)\s*)?(?:fully paid )?equity shares/i,
    /buy[- ]?back[^\d]{0,20}([\d,]+)\s*(?:\([^)]*\)\s*)?(?:equity shares|shares)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]!.replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

export function classifyBuybackMethod(
  subject: string | null,
  description: string | null,
): BuybackMethod {
  const blob = `${subject ?? ""} ${description ?? ""}`.toLowerCase();
  if (
    blob.includes("tender offer") ||
    blob.includes("through tender") ||
    blob.includes("tender route") ||
    blob.includes("buyback of shares through the tender") ||
    blob.includes("tender offer route")
  ) {
    return "tender";
  }
  if (
    blob.includes("open market") ||
    blob.includes("from the open market") ||
    blob.includes("through the stock exchange") ||
    blob.includes("from the stock exchange") ||
    (blob.includes("stock exchange") && blob.includes("buyback"))
  ) {
    return "open_market";
  }
  return "unknown";
}

export function pickSummaryMethod(
  events: Array<{
    status: BuybackStatus;
    subject: string | null;
    description: string | null;
  }>,
): BuybackMethod {
  const statusOrder: BuybackStatus[] = [
    "open",
    "announced",
    "closed",
    "cancelled",
    "noise",
  ];
  for (const st of statusOrder) {
    for (const e of events) {
      if (e.status !== st) continue;
      const method = classifyBuybackMethod(e.subject, e.description);
      if (method !== "unknown") return method;
    }
  }
  for (const e of events) {
    const method = classifyBuybackMethod(e.subject, e.description);
    if (method !== "unknown") return method;
  }
  return "unknown";
}

export function computeSpreadPct(
  maxPrice: number | null,
  cmp: number | null,
): number | null {
  if (maxPrice == null || cmp == null || cmp <= 0 || maxPrice <= cmp) return null;
  return Math.round(((maxPrice - cmp) / cmp) * 1000) / 10;
}

/** Max age of latest filing for a buyback to count as live (not stale history). */
export const LIVE_BUYBACK_MAX_AGE_DAYS = 120;

export function isRecentBuyback(
  latestDate: string | null | undefined,
  maxAgeDays = LIVE_BUYBACK_MAX_AGE_DAYS,
): boolean {
  if (!latestDate) return false;
  const ts = Date.parse(latestDate.slice(0, 10));
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= maxAgeDays * 86_400_000;
}

/** Stale announced/open filings are treated as closed — not actionable. */
export function effectiveBuybackStatus(
  status: string | null | undefined,
  latestDate: string | null | undefined,
): BuybackStatus | null {
  if (!status) return null;
  if (
    (status === "announced" || status === "open") &&
    !isRecentBuyback(latestDate)
  ) {
    return "closed";
  }
  return status as BuybackStatus;
}

/** Tender buyback where you can still buy on market (announced or open window). */
export function isBuyableBuyback(input: {
  buyback_method: string;
  latest_status: string | null;
  max_price: number | null;
  latest_date?: string | null;
}): boolean {
  if (input.buyback_method !== "tender") return false;
  if (input.max_price == null) return false;
  const st = effectiveBuybackStatus(input.latest_status, input.latest_date);
  return st === "announced" || st === "open";
}

/** Actionable tender: announced/open, max ₹ ≥8% above CMP, filing within last ~4 months. */
export function isLiveTenderSpread8(input: {
  buyback_method: string;
  latest_status: string | null;
  max_price: number | null;
  spread_pct: number | null;
  latest_date: string | null;
}): boolean {
  if (!isBuyableBuyback(input)) return false;
  if (input.spread_pct == null || input.spread_pct < 8) return false;
  return isRecentBuyback(input.latest_date);
}

export function classifyBuybackStatus(
  desc: string,
  text: string,
): BuybackStatus {
  const blob = `${desc} ${text}`.toLowerCase();
  if (
    blob.includes("closure of buy back") ||
    blob.includes("closure of buyback") ||
    blob.includes("completion of") ||
    blob.includes("extinguishment") ||
    blob.includes("closed the buyback") ||
    blob.includes("post buyback")
  ) {
    return "closed";
  }
  if (
    blob.includes("cancel") ||
    blob.includes("not to proceed") ||
    blob.includes("withdrawn")
  ) {
    return "cancelled";
  }
  if (
    blob.includes("buyback window") ||
    blob.includes("commencement") ||
    blob.includes("opening of buyback")
  ) {
    return "open";
  }
  if (
    blob.includes("newspaper publication") &&
    !blob.includes("post buyback") &&
    !blob.includes("closure")
  ) {
    return "noise";
  }
  if (
    blob.includes("board meeting") ||
    blob.includes("intimation") ||
    blob.includes("approval") ||
    blob.includes("public announcement")
  ) {
    return "announced";
  }
  return "announced";
}

export function scoreBuybackSummary(input: {
  events: Array<{
    status: BuybackStatus;
    announced_at: string | null;
    max_price: number | null;
    pct_equity: number | null;
    subject?: string | null;
    description?: string | null;
  }>;
  market_cap_cr: number | null;
}): { score: number; flags: string[]; reason: string } {
  const flags: string[] = [];
  let score = 0;

  const closed = input.events.filter((e) => e.status === "closed");
  const open = input.events.filter((e) => e.status === "open");
  const announced = input.events.filter((e) => e.status === "announced");
  const noise = input.events.filter((e) => e.status === "noise");

  if (closed.length) {
    score += 35;
    flags.push("past_buyback");
  }
  if (open.length) {
    score += 45;
    flags.push("active_buyback");
  }
  const method = pickSummaryMethod(input.events);
  if (method === "tender") {
    score += 5;
    flags.push("tender_offer");
  } else if (method === "open_market") {
    flags.push("open_market_buyback");
  }
  if (announced.length && !open.length && !closed.length) {
    score += 20;
    flags.push("buyback_announced");
  }

  const latestPct = [...input.events]
    .map((e) => e.pct_equity)
    .filter((n): n is number => n != null && n > 0)
    .sort((a, b) => b - a)[0];
  if (latestPct != null) {
    if (latestPct >= 5) {
      score += 15;
      flags.push("sizeable_pct");
    } else if (latestPct >= 2) {
      score += 8;
      flags.push("moderate_pct");
    }
  }

  const mcap = input.market_cap_cr;
  if (mcap != null && mcap > 0 && mcap <= 1500) {
    score += 10;
    flags.push("low_float_proxy");
  }

  if (noise.length >= 3 && closed.length === 0 && open.length === 0) {
    score -= 25;
    flags.push("announcement_noise");
  }
  if (announced.length >= 3 && closed.length === 0 && open.length === 0) {
    score -= 15;
    flags.push("failed_to_close");
  }

  score = Math.max(0, Math.min(100, score));

  let reason = "No buyback signal";
  if (flags.includes("active_buyback") && flags.includes("tender_offer")) {
    reason = "Open tender buyback — check spread vs CMP";
  } else if (flags.includes("active_buyback")) {
    reason = "Open buyback window — capital return in progress";
  } else if (flags.includes("past_buyback") && flags.includes("tender_offer")) {
    reason = "Past tender buyback in history";
  } else if (flags.includes("past_buyback") && flags.includes("low_float_proxy")) {
    reason = "Past buyback in a smaller-cap name — promoter-friendly return";
  } else if (flags.includes("past_buyback")) {
    reason = "Completed buyback in history";
  } else if (flags.includes("announcement_noise")) {
    reason = "Repeated buyback headlines without closure — likely noise";
  } else if (flags.includes("buyback_announced")) {
    reason = "Buyback announced, not yet closed";
  }

  return { score, flags, reason };
}

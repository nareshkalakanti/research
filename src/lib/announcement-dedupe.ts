/**
 * Collapse duplicate corporate filings (same issuer + day + title).
 * Used by MarketIQ / OrderBookIQ feed + discover paths.
 */

import { istDateKey } from "./nse-time";

export function normAnnouncementTitle(title: string): string {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

export function normIssuerKey(
  ticker?: string | null,
  company?: string | null,
): string {
  const t = (ticker || "").trim().toUpperCase();
  if (t && !/^BSE\d{5,6}$/i.test(t)) return t;
  const co = (company || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(limited|ltd\.?|private|pvt\.?|llp|corporation|corp\.?)\b/gi,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return co || t || "";
}

export function announcementDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return istDateKey(s);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s.slice(0, 10);
  return istDateKey(new Date(t).toISOString());
}

/** Stable key: issuer | YYYY-MM-DD | normalized title */
export function announcementDedupeKey(opts: {
  ticker?: string | null;
  company?: string | null;
  title: string;
  day?: string | null;
}): string {
  const who = normIssuerKey(opts.ticker, opts.company);
  const day = announcementDay(opts.day);
  const title = normAnnouncementTitle(opts.title);
  return `${who}|${day}|${title}`;
}

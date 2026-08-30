/**
 * NSE corporate announcements — concall transcripts, PPTs, financial results.
 * Official exchange source (no Screener).
 */
import { createNseBuybackSession } from "./nse-buybacks";
import type { DiscoveredMaterialSource, InvestorMaterialKind } from "./investor-material-types";

const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

const ANNOUNCEMENT_KIND: Array<{ re: RegExp; kind: InvestorMaterialKind; title: string }> = [
  {
    re: /transcript|con\.?\s*call|concall|earning\s+call|investor\s+meet/i,
    kind: "concall",
    title: "Concall transcript",
  },
  {
    re: /investor\s+presentation|earnings\s+presentation|analyst\s+presentation/i,
    kind: "ppt",
    title: "Investor presentation",
  },
  {
    re: /outcome\s+of\s+board\s+meeting|financial\s+result|audited\s+financial|unaudited\s+financial/i,
    kind: "other",
    title: "Financial results",
  },
  {
    re: /annual\s+report|board\s+report/i,
    kind: "other",
    title: "Annual / board report",
  },
];

type NseAnnRow = Record<string, unknown>;

function sourceId(url: string): string {
  return url.trim().toLowerCase();
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function formatPeriod(raw: unknown): string | null {
  const text = safeStr(raw);
  if (!text) return null;
  const d = new Date(text.replace(/(\d{2})-([A-Za-z]{3})-(\d{4})/, "$2 $1, $3"));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-IN", { month: "short", year: "numeric" });
}

function periodSortKey(period: string | null): number {
  if (!period) return 0;
  const m = period.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return 0;
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return Number(m[2]) * 12 + (months[m[1]!.toLowerCase()] ?? 0);
}

function nseAnnIndex(market: string | null | undefined): Array<"sme" | "equities"> {
  const mk = (market || "").trim().toUpperCase();
  if (mk === "NSE SME") return ["sme", "equities"];
  return ["equities", "sme"];
}

function isNoise(desc: string, attachmentText: string): boolean {
  const blob = `${desc} ${attachmentText}`.toLowerCase();
  return (
    /newspaper publication|postal ballot|agm notice|dividend|record date|clarification.*delay|reasons for delayed|non-submission of financial/i.test(
      blob,
    ) && !/financial result|outcome of board|investor presentation|transcript/i.test(blob)
  );
}

function classifyRow(row: NseAnnRow): {
  kind: InvestorMaterialKind;
  title: string;
} | null {
  const desc = safeStr(row.desc);
  const attachmentText = safeStr(row.attchmntText);
  const file = safeStr(row.attchmntFile).toLowerCase();
  const blob = `${desc} ${attachmentText} ${file}`;
  if (isNoise(desc, attachmentText)) return null;

  if (/transcript|earning_call|earnings_call|concall/i.test(file)) {
    return { kind: "concall", title: "Concall transcript" };
  }
  if (/presentation|_ip_|investor_presentation/i.test(file)) {
    return { kind: "ppt", title: "Investor presentation" };
  }

  const match = ANNOUNCEMENT_KIND.find((k) => k.re.test(blob));
  if (!match) return null;
  return { kind: match.kind, title: match.title };
}

async function fetchNseAnnouncements(
  symbol: string,
  index: "sme" | "equities",
): Promise<NseAnnRow[]> {
  const jar = await createNseBuybackSession();
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 3);

  const dd = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

  const u = new URL(CORP_ANN_URL);
  u.searchParams.set("index", index);
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("from_date", dd(from));
  u.searchParams.set("to_date", dd(to));

  const res = await fetch(u.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: NSE_ANN_REF,
      Cookie: jar.cookie,
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as unknown;
  return Array.isArray(rows) ? (rows as NseAnnRow[]) : [];
}

/** NSE corporate announcements for concall / PPT / results PDFs. */
export async function discoverNseInvestorMaterialSources(
  ticker: string,
  market: string | null | undefined,
  importedUrls: Set<string>,
): Promise<DiscoveredMaterialSource[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return [];

  const rows: NseAnnRow[] = [];
  const seenSeq = new Set<string>();
  for (const index of nseAnnIndex(market)) {
    try {
      for (const row of await fetchNseAnnouncements(symbol, index)) {
        const seq = safeStr(row.seq_id);
        if (seq && seenSeq.has(seq)) continue;
        if (seq) seenSeq.add(seq);
        rows.push(row);
      }
    } catch {
      /* try next index */
    }
  }

  const out: DiscoveredMaterialSource[] = [];
  const seenUrl = new Set<string>();

  for (const row of rows) {
    const url = safeStr(row.attchmntFile);
    if (!url.startsWith("http") || url.endsWith("/-")) continue;

    const classified = classifyRow(row);
    if (!classified) continue;

    const id = sourceId(url);
    if (seenUrl.has(id)) continue;
    seenUrl.add(id);

    const period = formatPeriod(row.an_dt || row.sort_date || row.dt);
    out.push({
      id,
      kind: classified.kind,
      title: classified.title,
      period,
      url,
      provider: "nse_announcements",
      imported: importedUrls.has(id),
    });
  }

  out.sort((a, b) => periodSortKey(b.period) - periodSortKey(a.period));
  return out;
}

export { formatPeriod as nseInvestorFormatPeriod };

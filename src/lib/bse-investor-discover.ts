import { BSE_HEADERS } from "./bse-sme";
import { loadBseSmeCacheMap } from "./bse-sme";
import type { DiscoveredMaterialSource, InvestorMaterialKind } from "./investor-material-types";
import { ensureInvestorMaterialsSchema } from "./investor-materials-schema";
import { openSqliteNamed } from "./sqlite-utils";

const BSE_ANN_API =
  "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

const ANNOUNCEMENT_KIND: Array<{ re: RegExp; kind: InvestorMaterialKind; title?: string }> = [
  {
    re: /investor\s+presentation|earnings\s+presentation|analyst\s+presentation/i,
    kind: "ppt",
  },
  {
    re: /transcript|concall|conference\s+call|earnings?\s+call|investor\s+meet|analyst\s+meet/i,
    kind: "concall",
  },
  {
    re: /analyst\s*\/\s*investor\s+meet\s*-\s*outcome|investor\s+meet\s*-\s*outcome|meet\s+outcome/i,
    kind: "concall",
    title: "Concall outcome",
  },
  {
    re: /financial\s+results|^financial\s+results$/i,
    kind: "other",
    title: "Financial results",
  },
  {
    re: /board\s+report|annual\s+report/i,
    kind: "other",
    title: "Annual / board report",
  },
  {
    re: /outcome\s+of\s+the\s+board\s+meeting|unaudited\s+financial\s+results|audited\s+financial/i,
    kind: "other",
    title: "Financial results",
  },
];

/** Reg-30 order / LOI / PO win announcements */
const ORDER_WIN_RE =
  /(?:receives?|secured?|bagged?|won|awarded|gets?)\s+(?:an?\s+)?(?:export\s+)?(?:purchase\s+)?order\b|\border\s+(?:from|worth|valued|for\s+supply|received|secured|bagged)\b|\bletter\s+of\s+intent\b|\bLOI\b|\bpurchase\s+order\b|\bwork\s+order\b|\bcontract\s+(?:awarded|received|secured)\b|Reg(?:ulation)?\.?\s*30.{0,40}\border\b/i;

const ORDER_WIN_EXCLUDE_RE =
  /financial\s+results|board\s+meeting|dividend|AGM|EGM|transcript|investor\s+presentation|buy\s*-?\s*back|preferential\s+issue|postal\s+ballot|newspaper\s+publication|credit\s+rating|related\s+party|scheme\s+of\s+arrangement|amalgamation|forensic\s+audit/i;

export function isOrderWinAnnouncementBlob(blob: string): boolean {
  const t = blob.trim();
  if (!t) return false;
  if (ORDER_WIN_EXCLUDE_RE.test(t) && !ORDER_WIN_RE.test(t)) return false;
  if (
    ORDER_WIN_EXCLUDE_RE.test(t) &&
    /financial\s+results|transcript|investor\s+presentation/i.test(t)
  ) {
    return false;
  }
  return ORDER_WIN_RE.test(t);
}

/**
 * Stricter filter for market-wide “today’s orders” lists.
 * Drops bare “Announcement under Regulation 30 …” without clear order-win language.
 */
export function isOrderWinMarketHit(blob: string): boolean {
  const t = blob.trim();
  if (!t) return false;
  if (
    /^announcement under regulation\s*30\b/i.test(t) &&
    !/bagging|letter of intent|\bLOI\b|purchase order|work order|order worth|order valued|secured.{0,30}order|received.{0,30}order|awarded.{0,30}(order|contract)/i.test(
      t,
    )
  ) {
    return false;
  }
  if (
    /^press release\b/i.test(t) &&
    !/bagging|order|LOI|contract|purchase order|work order/i.test(t)
  ) {
    return false;
  }
  return isOrderWinAnnouncementBlob(t);
}

function sourceId(url: string): string {
  return url.trim().toLowerCase();
}

function bsePdfUrl(attachment: string): string {
  const name = attachment.trim();
  if (!name) return "";
  return `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${encodeURIComponent(name)}`;
}

function formatPeriod(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
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

/** Extract BSE scrip code from Screener/BSE HTML links. */
export function extractBseScripCode(html: string): string | null {
  const m = html.match(
    /bseindia\.com\/stock-share-price\/[^/]+\/[^/]+\/(\d{5,7})\//i,
  );
  return m?.[1] ?? null;
}

function ensureBseScripCacheSchema(): void {
  ensureInvestorMaterialsSchema();
  const db = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_bse_scrip (
        ticker TEXT PRIMARY KEY,
        scrip_code TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

export function getCachedBseScripCode(ticker: string): string | null {
  ensureBseScripCacheSchema();
  const conn = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    const row = conn
      .prepare(`SELECT scrip_code FROM company_bse_scrip WHERE ticker = ?`)
      .get(ticker.toUpperCase()) as { scrip_code: string } | undefined;
    return row?.scrip_code?.trim() || null;
  } finally {
    conn.close();
  }
}

export function cacheBseScripCode(ticker: string, scripCode: string): void {
  const code = scripCode.trim();
  if (!code) return;
  ensureBseScripCacheSchema();
  const conn = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    conn
      .prepare(
        `INSERT INTO company_bse_scrip (ticker, scrip_code, updated_at)
         VALUES (@ticker, @scrip_code, @updated_at)
         ON CONFLICT(ticker) DO UPDATE SET
           scrip_code = excluded.scrip_code,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticker: ticker.toUpperCase(),
        scrip_code: code,
        updated_at: new Date().toISOString(),
      });
  } finally {
    conn.close();
  }
}

export function resolveBseScripCode(ticker: string, htmlHint?: string | null): string | null {
  const key = ticker.toUpperCase();
  const cached = getCachedBseScripCode(key);
  if (cached) return cached;

  const fromSme = loadBseSmeCacheMap().get(key)?.scrip_code?.trim();
  if (fromSme) {
    cacheBseScripCode(key, fromSme);
    return fromSme;
  }

  if (htmlHint) {
    const fromHtml = extractBseScripCode(htmlHint);
    if (fromHtml) {
      cacheBseScripCode(key, fromHtml);
      return fromHtml;
    }
  }

  return null;
}

type BseAnnRow = {
  NEWSSUB?: string;
  HEADLINE?: string;
  ATTACHMENTNAME?: string;
  NEWS_DT?: string;
  DissemDT?: string;
  SCRIP_CD?: string | number;
  SLONGNAME?: string;
  SYMBOL?: string;
  NSURL?: string;
};

function fmtBseDay(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function dayWindowLocal(offset: number): { from: Date; to: Date } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - offset);
  const to = new Date(from);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

export type BseMarketOrderHit = {
  title: string;
  url: string;
  period: string | null;
  announced_at: string | null;
  provider: "bse_announcements";
  ticker: string | null;
  company: string | null;
  scrip_code: string | null;
};

/** Reverse-lookup NSE ticker from cached BSE scrip code. */
function tickerFromBseScrip(scrip: string): string | null {
  const code = scrip.trim();
  if (!code) return null;
  try {
    ensureBseScripCacheSchema();
    const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
    try {
      const row = db
        .prepare(
          `SELECT ticker FROM company_bse_scrip WHERE scrip_code = ? LIMIT 1`,
        )
        .get(code) as { ticker: string } | undefined;
      return row?.ticker?.trim()?.toUpperCase() || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Market-wide BSE Reg-30 order / LOI announcements for the last `daysBack` days
 * (empty scrip, paginated). Best-effort — capped pages + hard timeout.
 */
export async function discoverBseAnnouncedOrders(
  daysBack = 1,
): Promise<BseMarketOrderHit[]> {
  const days = Math.min(7, Math.max(1, daysBack));
  const started = Date.now();
  const HARD_MS = 45_000;
  const out: BseMarketOrderHit[] = [];
  const seen = new Set<string>();

  for (let offset = 0; offset < days; offset += 1) {
    if (Date.now() - started > HARD_MS) break;
    const { from, to } = dayWindowLocal(offset);
    const dayFrom = fmtBseDay(from);
    const dayTo = fmtBseDay(to);
    for (let page = 1; page <= 12; page += 1) {
      if (Date.now() - started > HARD_MS) break;
      const params = new URLSearchParams({
        pageno: String(page),
        strCat: "-1",
        strPrevDate: dayFrom,
        strScrip: "",
        strSearch: "P",
        strToDate: dayTo,
        strType: "C",
        subcategory: "",
      });
      let rows: BseAnnRow[] = [];
      try {
        const res = await fetch(`${BSE_ANN_API}?${params}`, {
          headers: BSE_HEADERS,
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) break;
        const json = (await res.json()) as {
          Table?: BseAnnRow[];
          Table1?: Array<{ ROWCNT?: number }>;
        };
        rows = json.Table ?? [];
        if (!rows.length) break;
      } catch {
        break;
      }

      for (const row of rows) {
        const heading = String(row.NEWSSUB || row.HEADLINE || "").trim();
        const detail = String(row.HEADLINE || "").trim();
        const blob = `${heading} ${detail}`;
        if (!isOrderWinMarketHit(blob)) continue;
        const attachment = String(row.ATTACHMENTNAME || "").trim();
        const url = bsePdfUrl(attachment);
        if (!url) continue;
        const id = sourceId(url);
        if (seen.has(id)) continue;
        seen.add(id);
        const rawDt = row.DissemDT || row.NEWS_DT;
        const parsed = rawDt ? new Date(String(rawDt)) : null;
        const announced_at =
          parsed && !Number.isNaN(parsed.getTime())
            ? parsed.toISOString()
            : null;
        const scrip = String(row.SCRIP_CD || "").trim() || null;
        const symbol = String(row.SYMBOL || "").trim().toUpperCase() || null;
        const company = String(row.SLONGNAME || "").trim() || null;
        out.push({
          title: heading || "Order announcement",
          url,
          period: formatPeriod(announced_at),
          announced_at,
          provider: "bse_announcements",
          ticker: symbol || (scrip ? tickerFromBseScrip(scrip) : null),
          company,
          scrip_code: scrip,
        });
      }

      if (rows.length < 40) break;
    }
  }

  out.sort((a, b) => {
    const at = a.announced_at ? Date.parse(a.announced_at) : 0;
    const bt = b.announced_at ? Date.parse(b.announced_at) : 0;
    return bt - at;
  });
  return out;
}

/** BSE corporate announcements — works when Screener blocks. */
export async function discoverBseInvestorMaterialSources(
  ticker: string,
  scripCode: string,
  importedUrls: Set<string>,
): Promise<DiscoveredMaterialSource[]> {
  const code = scripCode.trim();
  if (!code) return [];

  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 3);

  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    pageno: "1",
    strCat: "-1",
    strPrevDate: fmt(from),
    strScrip: code,
    strSearch: "P",
    strToDate: fmt(to),
    strType: "C",
    subcategory: "",
  });

  const res = await fetch(`${BSE_ANN_API}?${params}`, { headers: BSE_HEADERS });
  if (!res.ok) {
    throw new Error(`BSE announcements failed (${res.status})`);
  }

  const raw = await res.text();
  let json: { Table?: BseAnnRow[] };
  try {
    json = JSON.parse(raw) as { Table?: BseAnnRow[] };
  } catch {
    throw new Error("BSE announcements returned invalid JSON");
  }

  const rows = json.Table ?? [];
  const out: DiscoveredMaterialSource[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const heading = String(row.NEWSSUB || row.HEADLINE || "").trim();
    const detail = String(row.HEADLINE || "").trim();
    const blob = `${heading} ${detail}`;
    if (
      /newspaper publication|board meeting intimation|dividend|postal ballot/i.test(blob) &&
      !/board\s+report|annual\s+report|financial\s+results/i.test(blob)
    ) {
      continue;
    }
    if (/^notice of .*annual general meeting/i.test(heading) && !/board\s+report|annual\s+report/i.test(blob)) {
      continue;
    }
    const match = ANNOUNCEMENT_KIND.find((k) => k.re.test(blob));
    if (!match) continue;

    const attachment = String(row.ATTACHMENTNAME || "").trim();
    const url = bsePdfUrl(attachment);
    if (!url) continue;

    const id = sourceId(url);
    if (seen.has(id)) continue;
    seen.add(id);

    const rawDt = row.DissemDT || row.NEWS_DT;
    const parsed = rawDt ? new Date(String(rawDt)) : null;
    const announced_at =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
    const period = formatPeriod(announced_at);
    out.push({
      id,
      kind: match.kind,
      title:
        heading ||
        match.title ||
        (match.kind === "ppt"
          ? "Investor presentation"
          : match.kind === "other"
            ? "Financial results"
            : "Earnings call transcript"),
      period,
      announced_at,
      url,
      provider: "bse_announcements",
      imported: importedUrls.has(id),
    });
  }

  out.sort((a, b) => {
    const at = a.announced_at ? Date.parse(a.announced_at) : 0;
    const bt = b.announced_at ? Date.parse(b.announced_at) : 0;
    if (bt !== at) return bt - at;
    return periodSortKey(b.period) - periodSortKey(a.period);
  });
  return out;
}


export type OrderAnnHit = {
  title: string;
  url: string;
  period: string | null;
  announced_at: string | null;
  provider: "bse_announcements";
};

/** BSE Reg-30 order / LOI / PO announcements (newest first). */
export async function discoverBseOrderAnnouncements(
  scripCode: string,
): Promise<OrderAnnHit[]> {
  const code = scripCode.trim();
  if (!code) return [];

  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 2);

  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    pageno: "1",
    strCat: "-1",
    strPrevDate: fmt(from),
    strScrip: code,
    strSearch: "P",
    strToDate: fmt(to),
    strType: "C",
    subcategory: "",
  });

  const res = await fetch(`${BSE_ANN_API}?${params}`, { headers: BSE_HEADERS });
  if (!res.ok) {
    throw new Error(`BSE announcements failed (${res.status})`);
  }

  const raw = await res.text();
  let json: { Table?: BseAnnRow[] };
  try {
    json = JSON.parse(raw) as { Table?: BseAnnRow[] };
  } catch {
    throw new Error("BSE announcements returned invalid JSON");
  }

  const rows = json.Table ?? [];
  const out: OrderAnnHit[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const heading = String(row.NEWSSUB || row.HEADLINE || "").trim();
    const detail = String(row.HEADLINE || "").trim();
    const blob = `${heading} ${detail}`;
    if (!isOrderWinAnnouncementBlob(blob)) continue;

    const attachment = String(row.ATTACHMENTNAME || "").trim();
    const url = bsePdfUrl(attachment);
    if (!url) continue;
    const id = sourceId(url);
    if (seen.has(id)) continue;
    seen.add(id);

    const rawDt = row.DissemDT || row.NEWS_DT;
    const parsed = rawDt ? new Date(String(rawDt)) : null;
    const announced_at =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
    out.push({
      title: heading || "Order announcement",
      url,
      period: formatPeriod(announced_at),
      announced_at,
      provider: "bse_announcements",
    });
  }

  out.sort((a, b) => {
    const at = a.announced_at ? Date.parse(a.announced_at) : 0;
    const bt = b.announced_at ? Date.parse(b.announced_at) : 0;
    return bt - at;
  });
  return out;
}


import { BSE_HEADERS } from "./bse-sme";
import { loadBseSmeCacheMap } from "./bse-sme";
import type { DiscoveredMaterialSource, InvestorMaterialKind } from "./investor-material-types";
import { ensureInvestorMaterialsSchema } from "./investor-materials-schema";
import { openSqliteNamed } from "./sqlite-utils";

const BSE_ANN_API =
  "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

const ANNOUNCEMENT_KIND: Array<{ re: RegExp; kind: InvestorMaterialKind; title?: string }> = [
  {
    re: /earnings\s+call\s+transcript|concall\s+transcript|conference\s+call\s+transcript/i,
    kind: "concall",
  },
  {
    re: /investor\s+presentation|earnings\s+presentation|analyst\s+presentation|investor\s+meet/i,
    kind: "ppt",
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
};

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

    const period = formatPeriod(row.DissemDT || row.NEWS_DT);
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
      url,
      provider: "bse_announcements",
      imported: importedUrls.has(id),
    });
  }

  out.sort((a, b) => periodSortKey(b.period) - periodSortKey(a.period));
  return out;
}

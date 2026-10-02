/**
 * NSE official equity universes from nsearchives CSVs.
 * Main board: EQUITY_L.csv. SME/Emerge: SME_EQUITY_L.csv.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const NSE_EQUITY_L_URL =
  "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
export const NSE_SME_EQUITY_L_URL =
  "https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv";

export type NseEquityListRow = {
  ticker: string;
  name: string;
  series: string;
  listing_date: string | null;
  isin: string | null;
  paid_up_value: string | null;
};

const RIGHTS_TICKER = /-[Rr][Ee]\d*$/;

export function isNseRightsEntitlement(row: {
  ticker: string;
  name?: string | null;
  series?: string | null;
}): boolean {
  const ticker = (row.ticker || "").trim().toUpperCase();
  if (!ticker) return true;
  if (RIGHTS_TICKER.test(ticker)) return true;
  const series = (row.series || "").trim().toUpperCase();
  if (series === "RE" || series === "R1") return true;
  const name = (row.name || "").trim().toUpperCase();
  if (/\bLTD-RE\b/.test(name) || /RIGHTS\s+ENTITLEMENT/.test(name)) return true;
  return false;
}

function headerKey(raw: string): string {
  return raw.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
}

function pick(
  row: Record<string, string>,
  keys: string[],
): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

export function parseNseEquityListCsv(text: string): NseEquityListRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]!).map(headerKey);
  const out: NseEquityListRow[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = cells[i] ?? "";
    });
    const ticker = pick(rec, ["symbol", "ticker"]).toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const isin = pick(rec, ["isin_number", "isin", "isin_code"]).toUpperCase() || null;
    out.push({
      ticker,
      name: pick(rec, ["name_of_company", "name_of_the_company", "name"]) || ticker,
      series: pick(rec, ["series"]),
      listing_date: pick(rec, ["date_of_listing"]) || null,
      isin: isin && isin.startsWith("IN") ? isin : null,
      paid_up_value: pick(rec, ["paid_up_value"]) || null,
    });
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      q = !q;
      continue;
    }
    if (ch === "," && !q) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/csv,text/plain,*/*",
      Referer: "https://www.nseindia.com/",
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`NSE list fetch failed ${res.status} ${url}`);
  return await res.text();
}

export async function fetchNseMainEquityList(): Promise<NseEquityListRow[]> {
  return parseNseEquityListCsv(await fetchCsv(NSE_EQUITY_L_URL));
}

export async function fetchNseSmeEquityList(): Promise<NseEquityListRow[]> {
  return parseNseEquityListCsv(await fetchCsv(NSE_SME_EQUITY_L_URL));
}

export function nseSmeIssuers(rows: NseEquityListRow[]): NseEquityListRow[] {
  return rows.filter((r) => !isNseRightsEntitlement(r));
}

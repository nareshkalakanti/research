const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Official NSE index CSV (no cookies required). */
const NIFTY500_CSV =
  "https://archives.nseindia.com/content/indices/ind_nifty500list.csv";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      q = !q;
      continue;
    }
    if (ch === "," && !q) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Nifty 500 symbols from NSE index CSV (symbol column). */
export async function fetchNifty500Tickers(): Promise<string[]> {
  const res = await fetch(NIFTY500_CSV, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    throw new Error(`Nifty 500 CSV fetch failed (${res.status})`);
  }
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const tickers: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]!);
    const sym = (cols[2] || cols.find((c) => /^[A-Z0-9&-]+$/.test(c)) || "")
      .trim()
      .toUpperCase();
    if (sym && sym !== "SYMBOL") tickers.push(sym);
  }
  const uniq = [...new Set(tickers)].sort();
  if (uniq.length < 400) {
    throw new Error(`Nifty 500 list too short (${uniq.length})`);
  }
  return uniq;
}

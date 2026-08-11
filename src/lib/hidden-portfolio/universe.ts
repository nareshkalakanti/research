/**
 * SME / microcap universe loader — CSV + optional company DB SME names.
 */
import fs from "fs";
import path from "path";
import { loadAllCompanies } from "@/lib/db";
import { loadMetricsMap } from "@/lib/metrics";
import {
  MARKET_CAP_RANGE_INR,
  type HiddenUniverseRow,
} from "./config";

const DATA_DIR = path.join(process.cwd(), "data");
const CSV_PATH = path.join(DATA_DIR, "sme_universe.csv");

const SAMPLE_CSV = `symbol,name,sector
ATAM.NS,Atam Valves,Industrial Valves
PATELENG.NS,Patel Engineering,Infrastructure
PREMEXPLN.NS,Premier Explosives,Defense / Explosives
KALYANIFRG.NS,Kalyani Forge,Auto Forgings
DIAMINESQ.NS,Diamines & Chemicals,Specialty Chemicals
`;

function ensureSampleCsv(): void {
  if (fs.existsSync(CSV_PATH)) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CSV_PATH, SAMPLE_CSV, "utf8");
}

function parseCsv(text: string): HiddenUniverseRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0]!.toLowerCase().split(",").map((h) => h.trim());
  const iSym = header.indexOf("symbol");
  const iName = header.indexOf("name");
  const iSec = header.indexOf("sector");
  if (iSym < 0) return [];

  const out: HiddenUniverseRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const symbol = (cols[iSym] || "").toUpperCase();
    if (!symbol) continue;
    out.push({
      symbol,
      name: iName >= 0 ? cols[iName] || symbol : symbol,
      sector: iSec >= 0 ? cols[iSec] || "" : "",
      market: symbol.includes("-SM")
        ? "NSE SME"
        : symbol.endsWith(".NS")
          ? "NSE"
          : null,
    });
  }
  return out;
}

/** Minimal CSV split (handles quoted commas). */
function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cols.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

/** Load curated CSV universe (creates sample if missing). */
export function loadSmeUniverseCsv(): HiddenUniverseRow[] {
  ensureSampleCsv();
  try {
    return parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Build scan universe:
 * 1) CSV seed names
 * 2) Plus local companies on NSE SME / with mcap in ₹20–200 Cr when metrics exist
 */
export function loadHiddenUniverse(opts?: {
  includeDbSme?: boolean;
  limit?: number;
}): HiddenUniverseRow[] {
  const includeDb = opts?.includeDbSme !== false;
  const bySym = new Map<string, HiddenUniverseRow>();

  for (const row of loadSmeUniverseCsv()) {
    bySym.set(row.symbol.toUpperCase(), row);
  }

  if (includeDb) {
    const metrics = loadMetricsMap();
    const [lo, hi] = MARKET_CAP_RANGE_INR;
    const loCr = lo / 1e7;
    const hiCr = hi / 1e7;

    for (const c of loadAllCompanies()) {
      const market = (c.market || "").toUpperCase();
      const isSme = market.includes("SME") || market.includes("EMERGE");
      const m = metrics.get(c.ticker.toUpperCase());
      const mcap = m?.market_cap_cr ?? c.mcap_cr;
      const inRange =
        mcap != null && Number.isFinite(mcap) && mcap >= loCr && mcap <= hiCr;

      if (!isSme && !inRange) continue;

      const sym = toYahooish(c.ticker, c.market);
      if (bySym.has(sym)) continue;
      bySym.set(sym, {
        symbol: sym,
        name: c.name || c.ticker,
        sector: c.sector || c.sub_sector || "",
        market: c.market,
      });
    }
  }

  let rows = [...bySym.values()].sort((a, b) =>
    a.symbol.localeCompare(b.symbol),
  );
  if (opts?.limit != null && opts.limit > 0) {
    rows = rows.slice(0, opts.limit);
  }
  return rows;
}

function toYahooish(ticker: string, market?: string | null): string {
  const t = ticker.trim().toUpperCase();
  if (t.endsWith(".NS") || t.endsWith(".BO")) return t;
  const mk = (market || "").toUpperCase();
  if (mk.includes("SME") || mk.includes("EMERGE")) {
    if (t.endsWith("-SM")) return `${t}.NS`;
    return `${t}-SM.NS`;
  }
  return `${t}.NS`;
}

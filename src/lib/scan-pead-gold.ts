/**
 * Compare Scan PEAD / quarter panels to screenshot gold under test/.
 * Gold lists sample rows; production scoring stays generic.
 */
import fs from "fs";
import path from "path";
import {
  loadFundamentalsScanMap,
  loadQuarterOverlayMap,
  type ChipBand,
} from "./fundamentals-scan";
import { buildQuarterPanel } from "./quarter-panel";

export type PeadGoldRow = {
  ticker: string;
  sales_yoy: number;
  np_yoy: number;
  rev_growth: ChipBand;
  margin_exp: ChipBand;
  roce_impr: ChipBand;
};

export type PeadGoldQuarters = {
  ticker: string;
  labels: string[];
  sales: number[];
  op: number[];
  opm_pct: number[];
  net_profit: number[];
};

export type PeadGoldFile = {
  source?: string;
  rows: PeadGoldRow[];
  quarters?: PeadGoldQuarters[];
};

export type GoldCheck = {
  id: string;
  ticker: string;
  kind: "pead" | "quarters";
  ok: boolean;
  detail: string;
  want: Record<string, unknown>;
  got: Record<string, unknown> | null;
};

const GOLD_PATH = path.join(process.cwd(), "test", "scan-pead-hhh.gold.json");

export function loadPeadHhhGold(): PeadGoldFile {
  const raw = fs.readFileSync(GOLD_PATH, "utf8");
  const json = JSON.parse(raw) as PeadGoldFile;
  if (!Array.isArray(json.rows) || !json.rows.length) {
    throw new Error("PEAD gold file has no rows");
  }
  return json;
}

function near(got: number | null | undefined, want: number, slack: number): boolean {
  if (got == null || !Number.isFinite(got)) return false;
  const pad = Math.max(slack, Math.abs(want) * 0.02);
  return Math.abs(got - want) <= pad;
}

/** Screenshot PAT Gr. is NP YoY; some rows print EPS YoY instead. */
function nearProfit(
  np: number | null | undefined,
  eps: number | null | undefined,
  want: number,
): boolean {
  return near(np, want, 8) || near(eps, want, 8);
}

function normQuarterLabel(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z]{3})\s*'?(\d{2,4})$/);
  if (!m) return raw.trim().toLowerCase();
  const mon = m[1]!.slice(0, 3).toLowerCase();
  let y = m[2]!;
  if (y.length === 2) y = `${Number(y) >= 70 ? "19" : "20"}${y}`;
  return `${mon}-${y}`;
}

function rowValues(
  panel: { rows: Array<{ label: string; values: Array<number | null> }> },
  label: string,
): Array<number | null> {
  return panel.rows.find((r) => r.label === label)?.values ?? [];
}

function checkRow(gold: PeadGoldRow): GoldCheck {
  const ticker = gold.ticker.trim().toUpperCase();
  const want = {
    sales_yoy: gold.sales_yoy,
    np_yoy: gold.np_yoy,
    rev_growth: gold.rev_growth,
    margin_exp: gold.margin_exp,
    roce_impr: gold.roce_impr,
  };
  const gotRow = loadFundamentalsScanMap().get(ticker);
  if (!gotRow) {
    return {
      id: ticker,
      ticker,
      kind: "pead",
      ok: false,
      detail: "no fundamentals row",
      want,
      got: null,
    };
  }
  const got = {
    sales_yoy: gotRow.sales_yoy,
    np_yoy: gotRow.np_yoy,
    eps_yoy: gotRow.eps_yoy,
    rev_growth: gotRow.rev_growth,
    margin_exp: gotRow.margin_exp,
    roce_impr: gotRow.roce_impr,
    latest_date: gotRow.latest_date,
  };
  const bits: string[] = [];
  if (!near(gotRow.sales_yoy, gold.sales_yoy, 3)) {
    bits.push(`sales_yoy ${gotRow.sales_yoy} ≠ ${gold.sales_yoy}`);
  }
  if (!nearProfit(gotRow.np_yoy, gotRow.eps_yoy, gold.np_yoy)) {
    bits.push(
      `pat_yoy np=${gotRow.np_yoy} eps=${gotRow.eps_yoy} ≠ ${gold.np_yoy}`,
    );
  }
  if (gotRow.rev_growth !== gold.rev_growth) {
    bits.push(`rev_growth ${gotRow.rev_growth} ≠ ${gold.rev_growth}`);
  }
  if (gotRow.margin_exp !== gold.margin_exp) {
    bits.push(`margin_exp ${gotRow.margin_exp} ≠ ${gold.margin_exp}`);
  }
  if (gotRow.roce_impr !== gold.roce_impr) {
    bits.push(`roce_impr ${gotRow.roce_impr} ≠ ${gold.roce_impr}`);
  }
  return {
    id: ticker,
    ticker,
    kind: "pead",
    ok: bits.length === 0,
    detail: bits.length ? bits.join("; ") : "match",
    want,
    got,
  };
}

function checkQuarters(gold: PeadGoldQuarters): GoldCheck {
  const ticker = gold.ticker.trim().toUpperCase();
  const overlay = loadQuarterOverlayMap().get(ticker);
  const panel = overlay?.quarters?.length
    ? buildQuarterPanel(overlay.quarters)
    : null;
  if (!panel) {
    return {
      id: `${ticker}-q`,
      ticker,
      kind: "quarters",
      ok: false,
      detail: "no quarter panel",
      want: { labels: gold.labels },
      got: null,
    };
  }
  const bits: string[] = [];
  const gotLabels = panel.labels.map(normQuarterLabel);
  const wantLabels = gold.labels.map(normQuarterLabel);
  if (gotLabels.join("|") !== wantLabels.join("|")) {
    bits.push(`labels ${panel.labels.join(",")} ≠ ${gold.labels.join(",")}`);
  }
  const pairs: Array<[string, number[]]> = [
    ["Sales", gold.sales],
    ["Operating Profit", gold.op],
    ["OPM %", gold.opm_pct],
    ["Net Profit", gold.net_profit],
  ];
  for (const [label, want] of pairs) {
    const got = rowValues(panel, label);
    if (got.length !== want.length) {
      bits.push(`${label} len ${got.length} ≠ ${want.length}`);
      continue;
    }
    const slack = label === "OPM %" ? 0.2 : 0.6;
    for (let i = 0; i < want.length; i++) {
      const g = got[i];
      const w = want[i]!;
      if (g == null || !Number.isFinite(g) || Math.abs(g - w) > slack) {
        bits.push(`${label}[${i}] ${g} ≠ ${w}`);
      }
    }
  }
  return {
    id: `${ticker}-q`,
    ticker,
    kind: "quarters",
    ok: bits.length === 0,
    detail: bits.length ? bits.join("; ") : "match",
    want: {
      labels: gold.labels,
      sales: gold.sales,
      op: gold.op,
      opm_pct: gold.opm_pct,
      net_profit: gold.net_profit,
    },
    got: {
      labels: panel.labels,
      sales: rowValues(panel, "Sales"),
      op: rowValues(panel, "Operating Profit"),
      opm_pct: rowValues(panel, "OPM %"),
      net_profit: rowValues(panel, "Net Profit"),
    },
  };
}

export function runPeadHhhGold(): {
  source: string | null;
  matched: number;
  total: number;
  ok: boolean;
  checks: GoldCheck[];
} {
  const gold = loadPeadHhhGold();
  const checks = [
    ...gold.rows.map(checkRow),
    ...(gold.quarters ?? []).map(checkQuarters),
  ];
  const matched = checks.filter((c) => c.ok).length;
  return {
    source: gold.source ?? null,
    matched,
    total: checks.length,
    ok: matched === checks.length,
    checks,
  };
}

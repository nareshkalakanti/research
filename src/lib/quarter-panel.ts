/**
 * Screener-style quarterly panel (PEAD2 `build_quarter_panel`).
 * Last 5 quarters, ₹ → Cr when Yahoo amounts look like rupees.
 * Keep this module browser-safe (no yahoo-finance2 / node builtins).
 */
export type QuarterPoint = {
  date: string; // YYYY-MM-DD period end
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  /** Operating profit (EBIDT / operating income). */
  ebit: number | null;
  otherIncome?: number | null;
};

export type QuarterRow = {
  label: string;
  values: Array<number | null>;
  good_up: boolean;
  decimals: number;
};

export type QuarterPanel = {
  labels: string[];
  rows: QuarterRow[];
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** PEAD2_QUARTER_PANEL */
export const PEAD2_QUARTER_PANEL = 5;

function toDateStr(d: Date | string | number): string {
  const x = new Date(d);
  if (!Number.isFinite(x.getTime())) return "";
  return x.toISOString().slice(0, 10);
}

/**
 * Drop Yahoo placeholder quarters whose period-end is still in the future
 * (PEAD `trim_reported_quarters` — allow +5 days grace).
 */
export function trimReportedQuarters(
  quarters: QuarterPoint[],
  asOf = new Date(),
): QuarterPoint[] {
  const cutoff = new Date(asOf);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() + 5);
  const cut = toDateStr(cutoff);
  return quarters
    .filter((q) => q.date && q.date <= cut)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function quarterLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return dateStr;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** PEAD `_inr_crore_divisor`. */
export function inrCroreDivisor(values: Array<number | null>): number {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!nums.length) return 1;
  if (Math.max(...nums.map(Math.abs)) >= 1e5) return 1e7;
  return 1;
}

function scaleValues(
  values: Array<number | null>,
  decimals: number,
): Array<number | null> {
  if (decimals === 2) {
    return values.map((v) => (v == null ? null : Math.round(v * 100) / 100));
  }
  const div = inrCroreDivisor(values);
  return values.map((v) => (v == null ? null : Math.round(v / div)));
}

/**
 * Build last N quarters panel — oldest → newest.
 * Build quarter comparison panel rows.
 */
export function buildQuarterPanel(
  quarters: QuarterPoint[],
  maxQuarters = PEAD2_QUARTER_PANEL,
): QuarterPanel | null {
  const qs = trimReportedQuarters(
    quarters.filter(
      (q) => q.revenue != null || q.netIncome != null || q.eps != null,
    ),
  );
  if (qs.length < 2) return null;

  const slice = qs.slice(-maxQuarters);
  const labels = slice.map((q) => quarterLabel(q.date));

  const sales = scaleValues(
    slice.map((q) => q.revenue),
    0,
  );
  const op = scaleValues(
    slice.map((q) => q.ebit),
    0,
  );
  const np = scaleValues(
    slice.map((q) => q.netIncome),
    0,
  );
  const eps = scaleValues(
    slice.map((q) => q.eps),
    2,
  );

  const rows: QuarterRow[] = [
    { label: "Sales", values: sales, good_up: true, decimals: 0 },
    { label: "Operating Profit", values: op, good_up: true, decimals: 0 },
  ];

  const oiRaw = slice.map((q) => q.otherIncome ?? null);
  if (oiRaw.some((v) => v != null && v !== 0)) {
    rows.push({
      label: "Other Income",
      values: scaleValues(oiRaw, 0),
      good_up: true,
      decimals: 0,
    });
  }

  rows.push(
    { label: "Net Profit", values: np, good_up: true, decimals: 0 },
    { label: "EPS in Rs", values: eps, good_up: true, decimals: 2 },
  );

  return { labels, rows };
}

export function qCellClass(
  row: QuarterRow,
  i: number,
): "q-up" | "q-down" | "q-flat" | "" {
  if (i <= 0) return "";
  const cur = row.values[i];
  const prev = row.values[i - 1];
  if (cur == null || prev == null) return "";
  if (cur > prev) return row.good_up ? "q-up" : "q-down";
  if (cur < prev) return row.good_up ? "q-down" : "q-up";
  return "q-flat";
}

export function fmtQVal(v: number | null, decimals: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (decimals === 2) {
    return v.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

const MONTH_ORDER: Record<string, number> = {
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

export function parseQuarterLabel(
  label: string,
): { month: number; year: number } | null {
  const parts = label.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const month = MONTH_ORDER[parts[0]!.slice(0, 3).toLowerCase()];
  const year = Number(parts[1]);
  if (!month || !Number.isFinite(year)) return null;
  return { month, year };
}

/** Latest column vs same fiscal quarter one year earlier (by label, not first column). */
export function yoyPairFromPanel(
  values: Array<number | null>,
  labels: string[],
): [number | null, number | null] {
  if (values.length < 2 || labels.length !== values.length) return [null, null];
  const latestIdx = values.length - 1;
  const latest = parseQuarterLabel(labels[latestIdx]!);
  if (!latest) return [null, null];

  for (let i = latestIdx - 1; i >= 0; i -= 1) {
    const prior = parseQuarterLabel(labels[i]!);
    if (
      prior &&
      prior.month === latest.month &&
      prior.year === latest.year - 1
    ) {
      return [values[latestIdx] ?? null, values[i] ?? null];
    }
  }
  return [null, null];
}

export function yoyPct(
  latest: number | null,
  prior: number | null,
): number | null {
  if (latest == null || prior == null || !Number.isFinite(latest)) return null;
  if (!Number.isFinite(prior) || prior <= 0) return null;
  return Math.round(((latest / prior) - 1) * 1000) / 10;
}

export type PanelYoY = {
  sales_yoy: number | null;
  np_yoy: number | null;
  eps_yoy: number | null;
};

export function yoyFromPanel(panel: QuarterPanel): PanelYoY | null {
  if (panel.labels.length < 2) return null;
  const byLabel = new Map(panel.rows.map((r) => [r.label, r.values]));
  const salesRow = byLabel.get("Sales") ?? [];
  const npRow = byLabel.get("Net Profit") ?? [];
  const epsRow = byLabel.get("EPS in Rs") ?? [];
  const sales = yoyPct(...yoyPairFromPanel(salesRow, panel.labels));
  const np = yoyPct(...yoyPairFromPanel(npRow, panel.labels));
  const eps = yoyPct(...yoyPairFromPanel(epsRow, panel.labels));
  if (sales == null && np == null && eps == null) return null;
  return { sales_yoy: sales, np_yoy: np, eps_yoy: eps };
}

export function fmtYoYPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/M";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

export function yoyClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "yoy-na";
  if (v > 0) return "yoy-up";
  if (v < 0) return "yoy-down";
  return "yoy-flat";
}

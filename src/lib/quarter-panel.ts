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
 * Mirrors stocks-ai `build_quarter_panel`.
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

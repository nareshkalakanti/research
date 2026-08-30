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
  ebidt_yoy: number | null;
};

export type PanelQoQ = {
  sales_qoq: number | null;
  np_qoq: number | null;
  eps_qoq: number | null;
  ebidt_qoq: number | null;
};

export type QuarterExtraMetrics = PanelQoQ &
  Pick<PanelYoY, "ebidt_yoy"> & {
    cf_profit: number | null;
  };

function rowValues(
  panel: QuarterPanel,
  label: string,
): Array<number | null> {
  return panel.rows.find((r) => r.label === label)?.values ?? [];
}

/** Latest quarter vs previous quarter (sequential). */
export function qoqPairFromPanel(
  values: Array<number | null>,
): [number | null, number | null] {
  if (values.length < 2) return [null, null];
  return [values[values.length - 1] ?? null, values[values.length - 2] ?? null];
}

export function qoqFromPanel(panel: QuarterPanel): PanelQoQ | null {
  if (panel.labels.length < 2) return null;
  const sales = yoyPct(...qoqPairFromPanel(rowValues(panel, "Sales")));
  const np = yoyPct(...qoqPairFromPanel(rowValues(panel, "Net Profit")));
  const eps = yoyPct(...qoqPairFromPanel(rowValues(panel, "EPS in Rs")));
  const ebidt = yoyPct(...qoqPairFromPanel(rowValues(panel, "Operating Profit")));
  if (sales == null && np == null && eps == null && ebidt == null) return null;
  return { sales_qoq: sales, np_qoq: np, eps_qoq: eps, ebidt_qoq: ebidt };
}

/** Operating cash flow ÷ latest net profit (Fisher-style quality). */
export function computeCfProfit(
  cfo: number | null | undefined,
  netProfit: number | null | undefined,
): number | null {
  if (cfo == null || netProfit == null || !Number.isFinite(cfo)) return null;
  if (!Number.isFinite(netProfit) || netProfit === 0) return null;
  return Math.round((cfo / netProfit) * 100) / 100;
}

export function cfProfitClass(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "cf-na";
  if (ratio >= 1.2) return "cf-good";
  if (ratio >= 0.5) return "cf-mid";
  return "cf-bad";
}

export function extraMetricsFromPanel(
  panel: QuarterPanel,
  cfProfit?: number | null,
): QuarterExtraMetrics | null {
  const qoq = qoqFromPanel(panel);
  const ebidtRow = rowValues(panel, "Operating Profit");
  const ebidt_yoy = yoyPct(...yoyPairFromPanel(ebidtRow, panel.labels));
  const cf_profit = cfProfit ?? null;
  if (
    !qoq &&
    ebidt_yoy == null &&
    cf_profit == null
  ) {
    return null;
  }
  return {
    sales_qoq: qoq?.sales_qoq ?? null,
    np_qoq: qoq?.np_qoq ?? null,
    eps_qoq: qoq?.eps_qoq ?? null,
    ebidt_qoq: qoq?.ebidt_qoq ?? null,
    ebidt_yoy,
    cf_profit,
  };
}

export function yoyFromPanel(panel: QuarterPanel): PanelYoY | null {
  if (panel.labels.length < 2) return null;
  const sales = yoyPct(...yoyPairFromPanel(rowValues(panel, "Sales"), panel.labels));
  const np = yoyPct(...yoyPairFromPanel(rowValues(panel, "Net Profit"), panel.labels));
  const eps = yoyPct(...yoyPairFromPanel(rowValues(panel, "EPS in Rs"), panel.labels));
  const ebidt = yoyPct(
    ...yoyPairFromPanel(rowValues(panel, "Operating Profit"), panel.labels),
  );
  if (sales == null && np == null && eps == null && ebidt == null) return null;
  return { sales_yoy: sales, np_yoy: np, eps_yoy: eps, ebidt_yoy: ebidt };
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

export type QuarterBriefInput = {
  forward_pe?: number | null;
  yoy?: PanelYoY | null;
  extras?: QuarterExtraMetrics | null;
  price?: number | null;
};

/** Text block for LLM — matches what the QTR tab shows. */
export function formatQuarterBriefBlock(
  panel: QuarterPanel,
  input: QuarterBriefInput = {},
): string {
  const latest = panel.labels.at(-1) ?? null;
  const lines: string[] = [];
  if (latest) lines.push(`Latest quarter: ${latest}`);
  lines.push("Quarterly financials (Rs Cr except EPS in Rs):");
  lines.push(`Quarters (oldest → newest): ${panel.labels.join(" | ")}`);
  for (const row of panel.rows) {
    const vals = row.values
      .map((v) => fmtQVal(v, row.decimals))
      .join(" | ");
    lines.push(`${row.label}: ${vals}`);
  }

  const metrics: string[] = [];
  const yoy = input.yoy;
  if (yoy?.sales_yoy != null) {
    metrics.push(`Sales YoY ${fmtYoYPct(yoy.sales_yoy)}`);
  }
  if (yoy?.np_yoy != null) {
    metrics.push(`NP YoY ${fmtYoYPct(yoy.np_yoy)}`);
  }
  if (yoy?.eps_yoy != null) {
    metrics.push(`EPS YoY ${fmtYoYPct(yoy.eps_yoy)}`);
  }
  const ex = input.extras;
  if (ex?.ebidt_yoy != null) {
    metrics.push(`Op profit YoY ${fmtYoYPct(ex.ebidt_yoy)}`);
  }
  if (ex?.sales_qoq != null) {
    metrics.push(`Sales QoQ ${fmtYoYPct(ex.sales_qoq)}`);
  }
  if (ex?.np_qoq != null) {
    metrics.push(`NP QoQ ${fmtYoYPct(ex.np_qoq)}`);
  }
  if (ex?.eps_qoq != null) {
    metrics.push(`EPS QoQ ${fmtYoYPct(ex.eps_qoq)}`);
  }
  if (input.forward_pe != null && Number.isFinite(input.forward_pe)) {
    metrics.push(`Fwd PE ${input.forward_pe.toFixed(1)}x`);
  }
  if (ex?.cf_profit != null) {
    metrics.push(`CF/Profit ${ex.cf_profit.toFixed(2)}x`);
  }

  if (metrics.length) {
    lines.push(`Key metrics: ${metrics.join(", ")}`);
  } else {
    lines.push("Key metrics: none computed");
  }

  const hasYoY =
    yoy?.sales_yoy != null ||
    yoy?.np_yoy != null ||
    yoy?.eps_yoy != null ||
    ex?.ebidt_yoy != null;
  if (!hasYoY) lines.push("YoY: not available (insufficient prior-year quarter)");

  const price = input.price;
  if (price != null && Number.isFinite(price) && price > 0) {
    lines.push(`Share price: ₹${price.toLocaleString("en-IN")}`);
  }

  return lines.join("\n");
}

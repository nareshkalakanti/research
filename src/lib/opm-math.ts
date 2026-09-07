/**
 * Operating-margin (OPM %) math — browser-safe (no Node / SQLite).
 *
 * Scan screens:
 * - Stable OPM: margin range ≤2.5pp (established 4Q+ / new listing 2–3Q)
 * - Operating Metrics: Stable OPM **and** Sales YoY ≥5% (together = quality growth)
 */

export type OpmConsistency =
  | "Stable"
  | "Expanding"
  | "Compressing"
  | "Volatile";

export type StableOpmPass = {
  pass: boolean;
  kind: "established" | "new_listing" | null;
  usable: number;
  periods: number;
};

export type OperatingMetricsPass = StableOpmPass & {
  sales_ok: boolean;
  sales_yoy: number | null;
};

/** Minimum Sales YoY % for Operating Metrics (with Stable OPM). */
export const OPERATING_METRICS_MIN_SALES_YOY = 5;

type QuarterLike = {
  date?: string;
  revenue?: number | null;
  ebit?: number | null;
};

/** OPM % = EBIT / Sales × 100 (1 decimal). */
export function opmPctSeries(
  sales: Array<number | null | undefined>,
  ebit: Array<number | null | undefined>,
): Array<number | null> {
  const n = Math.max(sales.length, ebit.length);
  const out: Array<number | null> = [];
  for (let i = 0; i < n; i++) {
    const s = sales[i];
    const e = ebit[i];
    if (
      s == null ||
      e == null ||
      !Number.isFinite(s) ||
      !Number.isFinite(e) ||
      s === 0
    ) {
      out.push(null);
      continue;
    }
    out.push(Math.round((e / s) * 1000) / 10);
  }
  return out;
}

export function opmPctFromQuarters(
  quarters: Array<{ revenue?: number | null; ebit?: number | null }>,
): Array<number | null> {
  return opmPctSeries(
    quarters.map((q) => q.revenue ?? null),
    quarters.map((q) => q.ebit ?? null),
  );
}

function sequentialMoves(values: Array<number | null>): {
  up: number;
  down: number;
} {
  let up = 0;
  let down = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (prev == null || cur == null) continue;
    if (cur > prev) up += 1;
    else if (cur < prev) down += 1;
  }
  return { up, down };
}

/** Same rules as Quarters OPM trend chip. */
export function classifyOpmConsistency(
  opm: Array<number | null>,
): OpmConsistency | null {
  const nums = opm.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) return null;

  const first = nums[0]!;
  const last = nums[nums.length - 1]!;
  const { up, down } = sequentialMoves(opm);
  const range = Math.max(...nums) - Math.min(...nums);

  if (range <= 2.5) return "Stable";
  if (up > 0 && down > 0 && range > 5) return "Volatile";
  if (last >= first + 1 && up >= down) return "Expanding";
  if (last <= first - 1 && down >= up) return "Compressing";
  return "Volatile";
}

export function isStableOpm(opm: Array<number | null>): boolean {
  return classifyOpmConsistency(opm) === "Stable";
}

/**
 * Scan eligibility for Stable OPM.
 * Short history (2–3Q) only when the whole series is short — not sparse fills.
 */
export function passesStableOpmScreen(
  quarters: Array<{ revenue?: number | null; ebit?: number | null }>,
): StableOpmPass {
  const fail: StableOpmPass = {
    pass: false,
    kind: null,
    usable: 0,
    periods: 0,
  };
  if (!Array.isArray(quarters) || quarters.length < 2) return fail;

  const periods = quarters.length;
  const slice = quarters.slice(-5);
  const opm = opmPctFromQuarters(slice);
  const usable = opm.filter((v) => v != null).length;
  if (usable < 2) return { ...fail, usable, periods };

  if (usable >= 4) {
    return {
      pass: isStableOpm(opm),
      kind: "established",
      usable,
      periods,
    };
  }

  // New / young listing: fewer than 4 reported periods in the series.
  if (periods < 4 && usable >= 2) {
    return {
      pass: isStableOpm(opm),
      kind: "new_listing",
      usable,
      periods,
    };
  }

  // Longer series but <4 usable OPM points → incomplete data, skip.
  return { ...fail, usable, periods };
}

function parsePeriodEnd(date: string | undefined): { y: number; m: number } | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})/.exec(date.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
  return { y, m: mo };
}

function yoyPct(latest: number, prior: number): number | null {
  if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior <= 0) {
    return null;
  }
  return Math.round((latest / prior - 1) * 1000) / 10;
}

/**
 * Latest quarter Sales vs same calendar month one year earlier.
 * Quarters may be any order; we sort by date ascending.
 */
export function salesYoyFromQuarters(quarters: QuarterLike[]): number | null {
  if (!Array.isArray(quarters) || quarters.length < 2) return null;
  const sorted = quarters
    .map((q) => ({
      date: q.date,
      rev: q.revenue,
      key: parsePeriodEnd(q.date),
    }))
    .filter(
      (q) =>
        q.key &&
        q.rev != null &&
        Number.isFinite(q.rev) &&
        (q.rev as number) > 0,
    )
    .sort((a, b) => {
      const ak = a.key!;
      const bk = b.key!;
      return ak.y !== bk.y ? ak.y - bk.y : ak.m - bk.m;
    });
  if (sorted.length < 2) return null;
  const latest = sorted[sorted.length - 1]!;
  const prior = [...sorted]
    .reverse()
    .find(
      (q) =>
        q.key!.m === latest.key!.m && q.key!.y === latest.key!.y - 1,
    );
  if (!prior) return null;
  return yoyPct(latest.rev as number, prior.rev as number);
}

/** QoQ sales % on the two newest quarters with revenue (for short histories). */
export function salesQoqFromQuarters(quarters: QuarterLike[]): number | null {
  if (!Array.isArray(quarters) || quarters.length < 2) return null;
  const sorted = quarters
    .map((q) => ({
      date: q.date,
      rev: q.revenue,
      key: parsePeriodEnd(q.date),
    }))
    .filter(
      (q) =>
        q.key &&
        q.rev != null &&
        Number.isFinite(q.rev) &&
        (q.rev as number) > 0,
    )
    .sort((a, b) => {
      const ak = a.key!;
      const bk = b.key!;
      return ak.y !== bk.y ? ak.y - bk.y : ak.m - bk.m;
    });
  if (sorted.length < 2) return null;
  const latest = sorted[sorted.length - 1]!;
  const prev = sorted[sorted.length - 2]!;
  return yoyPct(latest.rev as number, prev.rev as number);
}

/**
 * Operating Metrics screen: Stable OPM **and** sales growth.
 * Established: Sales YoY ≥ 5%. New listing (no YoY yet): Sales QoQ > 0.
 */
export function passesOperatingMetricsScreen(
  quarters: QuarterLike[],
): OperatingMetricsPass {
  const opm = passesStableOpmScreen(quarters);
  const salesYoy = salesYoyFromQuarters(quarters);
  let salesOk = false;
  if (salesYoy != null && salesYoy >= OPERATING_METRICS_MIN_SALES_YOY) {
    salesOk = true;
  } else if (opm.kind === "new_listing" && salesYoy == null) {
    const qoq = salesQoqFromQuarters(quarters);
    salesOk = qoq != null && qoq > 0;
  }

  return {
    ...opm,
    pass: opm.pass && salesOk,
    sales_ok: salesOk,
    sales_yoy: salesYoy,
  };
}

import {
  fmtYoYPct,
  qoqFromPanel,
  type PanelYoY,
  type QuarterPanel,
} from "./quarter-panel";
import { classifyOpmConsistency } from "./opm-math";

export type QtrTrendSignal = "Growing" | "Inconsistent" | "Declining";

function rowValues(
  panel: QuarterPanel,
  label: string,
): Array<number | null> {
  return panel.rows.find((r) => r.label === label)?.values ?? [];
}

function sequentialMoves(values: Array<number | null>): {
  up: number;
  down: number;
  pairs: number;
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
  return { up, down, pairs: up + down };
}

/** True when the last two sequential moves are both down (recent fade). */
function recentTwoDown(values: Array<number | null>): boolean {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 3) return false;
  const a = nums[nums.length - 3]!;
  const b = nums[nums.length - 2]!;
  const c = nums[nums.length - 1]!;
  return b < a && c < b;
}

function firstLast(values: Array<number | null>): [number | null, number | null] {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!nums.length) return [null, null];
  return [nums[0]!, nums[nums.length - 1]!];
}

/** Latest NP vs prior quarter — works when both are losses (QoQ % is undefined). */
function npImprovingLatest(
  np: Array<number | null>,
  npQ: number | null,
): boolean {
  if (npQ != null && npQ >= 0) return true;
  if (np.length < 2) return false;
  const latest = np[np.length - 1];
  const prior = np[np.length - 2];
  return latest != null && prior != null && latest > prior;
}

/** Classify sequential pattern for one panel row (Trend column). */
export function trendLabelForRow(row: {
  label: string;
  values: Array<number | null>;
  good_up: boolean;
}): { text: string; tone: "good" | "bad" | "neutral" } | null {
  const nums = row.values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) return null;

  const first = nums[0]!;
  const last = nums[nums.length - 1]!;
  const { up, down } = sequentialMoves(row.values);

  if (row.label === "OPM %" || row.label.startsWith("OPM")) {
    const signal = classifyOpmConsistency(row.values);
    if (!signal) return null;
    const tone =
      signal === "Stable" || signal === "Expanding"
        ? "good"
        : signal === "Compressing"
          ? "bad"
          : "neutral";
    return { text: signal, tone };
  }

  if (row.good_up) {
    // First→last up but last two quarters both down → Mixed, not Growing.
    if (recentTwoDown(row.values)) {
      return last > first
        ? { text: "Inconsistent", tone: "neutral" }
        : { text: "Declining", tone: "bad" };
    }
    if (last > first && up > down) return { text: "Growing", tone: "good" };
    if (last < first && down > up) return { text: "Declining", tone: "bad" };
    if (up > 0 && down > 0) return { text: "Inconsistent", tone: "neutral" };
    return last >= first
      ? { text: "Growing", tone: "good" }
      : { text: "Declining", tone: "bad" };
  }

  const peLabel = row.label.toLowerCase();
  const cheaperHint = peLabel.includes("forward")
    ? "Future Cheaper"
    : peLabel.includes("pe")
      ? "Stock Cheaper"
      : "Cheaper";

  if (last < first && down >= up) {
    return { text: `Decreasing (${cheaperHint})`, tone: "good" };
  }
  if (last > first && up >= down) {
    return { text: "Increasing", tone: "bad" };
  }
  return { text: "Flat", tone: "neutral" };
}

/** Compact trend chip for the table column. */
export function trendShortLabel(text: string): string {
  if (text.startsWith("Decreasing")) return "Cheaper";
  if (text === "Increasing") return "Rising";
  if (text === "Inconsistent") return "Mixed";
  return text;
}

/** Overall badge label — Inconsistent → Mixed for UI. */
export function overallTrendLabel(signal: QtrTrendSignal): string {
  return signal === "Inconsistent" ? "Mixed" : signal;
}

/**
 * Plain-language read of the quarter table — what changed lately vs last year.
 * Prefer this over raw YoY/QoQ % strips.
 */
export function describeQuarterTable(
  panel: QuarterPanel,
  yoy?: PanelYoY | null,
): string | null {
  const sales = rowValues(panel, "Sales");
  const np = rowValues(panel, "Net Profit");
  if (sales.filter((v) => v != null).length < 2) return null;

  const qoq = qoqFromPanel(panel);
  const salesQ = qoq?.sales_qoq ?? null;
  const npQ = qoq?.np_qoq ?? null;
  const salesY = yoy?.sales_yoy ?? null;
  const npY = yoy?.np_yoy ?? null;
  const salesFade = recentTwoDown(sales);
  const npFade = recentTwoDown(np);
  const labels = panel.labels;
  const latest = labels[labels.length - 1] ?? "latest quarter";

  const yoyBits: string[] = [];
  if (salesY != null && npY != null) {
    if (salesY >= 10 && npY >= 10) {
      yoyBits.push("sales and profit are both higher than the same quarter last year");
    } else if (salesY >= 10 && npY < 0) {
      yoyBits.push("sales are up vs last year, but profit is down");
    } else if (salesY < 0 && npY < 0) {
      yoyBits.push("sales and profit are both below the same quarter last year");
    } else if (salesY >= 10) {
      yoyBits.push(`sales are up vs last year (${fmtYoYPct(salesY)})`);
    } else if (npY >= 10) {
      yoyBits.push(`profit is up vs last year (${fmtYoYPct(npY)})`);
    } else if (salesY < 0) {
      yoyBits.push("sales are softer than last year");
    } else if (npY < 0) {
      yoyBits.push("profit is softer than last year");
    }
  } else if (salesY != null && salesY >= 10) {
    yoyBits.push(`sales are up vs last year (${fmtYoYPct(salesY)})`);
  } else if (salesY != null && salesY < 0) {
    yoyBits.push("sales are softer than last year");
  }

  const recentBits: string[] = [];
  if (salesFade && npFade) {
    recentBits.push("the last two quarters both slipped on sales and profit");
  } else if (salesFade) {
    recentBits.push("sales slipped in each of the last two quarters");
  } else if (
    salesQ != null &&
    npQ != null &&
    salesQ < 0 &&
    npQ < 0
  ) {
    recentBits.push(
      `${latest} stepped down from the prior quarter on both sales and profit`,
    );
  } else if (salesQ != null && salesQ < -5 && npQ != null && npQ >= 0) {
    recentBits.push(`${latest} sales eased while profit held up`);
  } else if (salesQ != null && salesQ >= 5 && npQ != null && npQ >= 5) {
    recentBits.push(`${latest} improved again on sales and profit`);
  } else if (salesQ != null && salesQ < -5) {
    recentBits.push(`${latest} sales stepped down from the prior quarter`);
  } else if (npQ != null && npQ < -10) {
    recentBits.push(`${latest} profit stepped down from the prior quarter`);
  }

  if (!yoyBits.length && !recentBits.length) {
    const [firstS, lastS] = firstLast(sales);
    if (firstS != null && lastS != null && lastS > firstS * 1.05) {
      return "Sales built over the span, though the path was uneven.";
    }
    if (firstS != null && lastS != null && lastS < firstS * 0.95) {
      return "Sales drifted lower across the span.";
    }
    return "Quarterly sales and profit moved mixed — no clean one-way trend.";
  }

  if (yoyBits.length && recentBits.length) {
    const yoyPart = yoyBits[0]!;
    const head = yoyPart.charAt(0).toUpperCase() + yoyPart.slice(1);
    const join = yoyPart.includes(" but ") ? ", and " : ", but ";
    return `${head}${join}${recentBits[0]}.`;
  }
  if (yoyBits.length) {
    const yoyPart = yoyBits[0]!;
    return yoyPart.charAt(0).toUpperCase() + yoyPart.slice(1) + ".";
  }
  const r = recentBits[0]!;
  return r.charAt(0).toUpperCase() + r.slice(1) + ".";
}

/** Classify 5-quarter sales/NP pattern. */
export function classifyQuarterTrend(
  panel: QuarterPanel,
  yoy?: PanelYoY | null,
): {
  signal: QtrTrendSignal;
  reason: string;
} | null {
  const sales = rowValues(panel, "Sales");
  const np = rowValues(panel, "Net Profit");
  if (sales.filter((v) => v != null).length < 2) return null;

  const sm = sequentialMoves(sales);
  const nm = sequentialMoves(np);
  const qoq = qoqFromPanel(panel);
  const salesQ = qoq?.sales_qoq ?? null;
  const npQ = qoq?.np_qoq ?? null;

  const salesUp = sm.up > sm.down;
  const salesDown = sm.down > sm.up;
  const npUp = nm.up > nm.down;
  const npDown = nm.down > nm.up;

  const latestOpp =
    salesQ != null &&
    npQ != null &&
    ((salesQ > 0 && npQ < 0) || (salesQ < 0 && npQ > 0));
  const trendSplit =
    sm.pairs > 0 && nm.pairs > 0 && salesUp !== npUp && salesDown !== npDown;
  const bigGap =
    salesQ != null &&
    npQ != null &&
    Math.abs(salesQ - npQ) >= 35 &&
    Math.sign(salesQ) !== Math.sign(npQ);

  const [firstSales, lastSales] = firstLast(sales);
  const op = rowValues(panel, "Operating Profit");
  const opMoves = sequentialMoves(op);
  const opUp = opMoves.up > opMoves.down;
  const salesSpike = salesQ != null && salesQ >= 25;
  const salesRecovering =
    firstSales != null &&
    lastSales != null &&
    lastSales > firstSales &&
    salesSpike;
  const strongSalesYoy = yoy?.sales_yoy != null && yoy.sales_yoy >= 20;
  const npLatestUp = npImprovingLatest(np, npQ);
  const salesFading = recentTwoDown(sales);
  const npFading = recentTwoDown(np);
  // Strong Sales YoY alone must not mask a soft latest print (QoQ red + NP YoY red).
  const recentSoft =
    (salesQ != null && salesQ < 0 && npQ != null && npQ < 0) ||
    (salesFading && (yoy?.np_yoy == null || yoy.np_yoy < 0)) ||
    (npFading && salesFading);

  let signal: QtrTrendSignal;
  if (recentSoft && (strongSalesYoy || salesRecovering)) {
    // Medium-term sales up, but last stretch / profits soft → Mixed.
    signal = "Inconsistent";
  } else if (salesRecovering || strongSalesYoy) {
    if (npLatestUp && (opUp || salesRecovering || strongSalesYoy)) {
      signal = "Growing";
    } else if (opUp && npLatestUp) {
      signal = "Growing";
    } else if (strongSalesYoy && !npFading && (npLatestUp || (yoy?.np_yoy != null && yoy.np_yoy >= 0))) {
      signal = "Growing";
    } else if (strongSalesYoy && opUp && !salesFading) {
      signal = "Growing";
    } else {
      signal = "Inconsistent";
    }
  } else if (latestOpp || trendSplit || bigGap) {
    signal = "Inconsistent";
  } else if (salesUp && npUp && !recentSoft) {
    signal = "Growing";
  } else if (salesDown && npDown) {
    signal = "Declining";
  } else if ((salesUp || npUp) && !(salesDown && npDown) && !recentSoft) {
    signal = "Growing";
  } else if ((salesDown || npDown) && !(salesUp && npUp)) {
    signal = "Declining";
  } else {
    signal = "Inconsistent";
  }

  const story = describeQuarterTable(panel, yoy);
  return {
    signal,
    reason: story || `${signal} trend across the quarter table.`,
  };
}

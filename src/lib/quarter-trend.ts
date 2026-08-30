import {
  fmtYoYPct,
  qoqFromPanel,
  type QuarterPanel,
} from "./quarter-panel";

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

  if (row.good_up) {
    if (last > first && up >= down) return { text: "Growing", tone: "good" };
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

/** Classify 5-quarter sales/NP pattern. */
export function classifyQuarterTrend(panel: QuarterPanel): {
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

  let signal: QtrTrendSignal;
  if (latestOpp || trendSplit || bigGap) {
    signal = "Inconsistent";
  } else if (salesUp && npUp) {
    signal = "Growing";
  } else if (salesDown && npDown) {
    signal = "Declining";
  } else if ((salesUp || npUp) && !(salesDown && npDown)) {
    signal = "Growing";
  } else if ((salesDown || npDown) && !(salesUp && npUp)) {
    signal = "Declining";
  } else {
    signal = "Inconsistent";
  }

  const parts: string[] = [];
  if (sm.pairs > 0) {
    parts.push(`Sales up in ${sm.up} of ${sm.pairs} sequential quarters`);
  }
  if (nm.pairs > 0) {
    parts.push(`NP up in ${nm.up} of ${nm.pairs}`);
  }
  if (salesQ != null) parts.push(`Sales QoQ ${fmtYoYPct(salesQ)}`);
  if (npQ != null) parts.push(`NP QoQ ${fmtYoYPct(npQ)}`);

  return {
    signal,
    reason: parts.length ? `${parts.join("; ")}.` : `${signal} trend across panel.`,
  };
}

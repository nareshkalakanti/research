/**
 * Napkin Tech — Price>200 · Trend EMA · TQ RS · Momentum RSI · Strong · Exit.
 * Aligns with Scan: EMA stack idea, TQ weekly RS>0, monthly RSI M / 85–90.
 */
import {
  alignBars,
  ema,
  relativeStrength,
  rollingMean,
  type Bar,
} from "@/lib/indicators";
import {
  fetchDailyBars,
  fetchMonthlyBarsForRsi,
  fetchNiftyWeeklyBars,
  fetchWeeklyBars,
} from "@/lib/ohlc";
import { analyzeMonthlyRsi } from "@/lib/signals";

export type TechCheckStatus = "pass" | "fail" | "unknown";

export type TechGroupId =
  | "price_200"
  | "trend"
  | "tq"
  | "momentum"
  | "strong_momentum"
  | "exit";

export type TechGroup = {
  id: TechGroupId;
  label: string;
  status: TechCheckStatus;
  /** Pass / Fail / N/A, or RSI value for Exit. */
  statusText: string;
  detail: string | null;
};

export type NapkinTechSignals = {
  ticker: string;
  groups: TechGroup[];
};

function lastMean(
  closes: number[],
  period: number,
  kind: "sma" | "ema",
): number | null {
  if (closes.length < period) return null;
  const series = kind === "ema" ? ema(closes, period) : rollingMean(closes, period);
  const v = series[series.length - 1];
  return v != null && Number.isFinite(v) ? v : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Weekly TQ strength: 52W and 13W Relative Strength vs Nifty both > 0. */
function weeklyTqStrength(
  weekly: Bar[],
  nifty: Bar[],
): TechGroup {
  if (!nifty.length) {
    return {
      id: "tq",
      label: "TQ",
      status: "unknown",
      statusText: "N/A",
      detail: "Nifty unavailable",
    };
  }
  const aligned = alignBars(weekly, nifty, 65);
  if (!aligned) {
    return {
      id: "tq",
      label: "TQ",
      status: "unknown",
      statusText: "N/A",
      detail: "Need history",
    };
  }
  const closes = aligned.stock.map((b) => b.close);
  const niftyCloses = aligned.nifty.map((b) => b.close);
  const longRs = relativeStrength(closes, niftyCloses, 52);
  const shortRs = relativeStrength(closes, niftyCloses, 13);
  const i = closes.length - 1;
  const rs52 = longRs[i];
  const rs13 = shortRs[i];
  if (rs52 == null || rs13 == null) {
    return {
      id: "tq",
      label: "TQ",
      status: "unknown",
      statusText: "N/A",
      detail: "RS unavailable",
    };
  }
  const ok = rs52 > 0 && rs13 > 0;
  return {
    id: "tq",
    label: "TQ",
    status: ok ? "pass" : "fail",
    statusText: ok ? "Pass" : "Fail",
    detail: `Weekly RS 52W ${round4(rs52)} · 13W ${round4(rs13)} (need both > 0)`,
  };
}

export async function loadNapkinTechSignals(
  ticker: string,
  market?: string | null,
): Promise<NapkinTechSignals> {
  const t = ticker.trim().toUpperCase();
  const mk = (market || "").trim() || null;

  const [daily, weekly, monthlyRsi, nifty] = await Promise.all([
    fetchDailyBars(t, mk, 3).catch(() => [] as Bar[]),
    fetchWeeklyBars(t, mk, 2).catch(() => [] as Bar[]),
    fetchMonthlyBarsForRsi(t, mk, 5, 16).catch(() => [] as Bar[]),
    fetchNiftyWeeklyBars().catch(() => [] as Bar[]),
  ]);

  const closes = daily.map((b) => b.close).filter((n) => Number.isFinite(n));
  const px = closes.length ? closes[closes.length - 1]! : null;
  const sma200 = lastMean(closes, 200, "sma");
  const mrsi = monthlyRsi.length ? analyzeMonthlyRsi(monthlyRsi) : null;

  // 1. Price > 200 DMA (Scan / tape style daily SMA)
  let price200: TechGroup;
  if (px == null || sma200 == null) {
    price200 = {
      id: "price_200",
      label: "Price > 200 DMA",
      status: "unknown",
      statusText: "N/A",
      detail: "Need history",
    };
  } else {
    const ok = px > sma200;
    price200 = {
      id: "price_200",
      label: "Price > 200 DMA",
      status: ok ? "pass" : "fail",
      statusText: ok ? "Pass" : "Fail",
      detail: `Px ${round2(px)} · 200 DMA ${round2(sma200)}`,
    };
  }

  // 2. Trend — EMA 20 > 50 > 200 (Scan EMA family, stacked)
  let trend: TechGroup;
  const e20 = lastMean(closes, 20, "ema");
  const e50 = lastMean(closes, 50, "ema");
  const e200 = lastMean(closes, 200, "ema");
  if (e20 == null || e50 == null || e200 == null) {
    trend = {
      id: "trend",
      label: "Trend",
      status: "unknown",
      statusText: "N/A",
      detail: "Need history",
    };
  } else {
    const ok = e20 > e50 && e50 > e200;
    trend = {
      id: "trend",
      label: "Trend",
      status: ok ? "pass" : "fail",
      statusText: ok ? "Pass" : "Fail",
      detail: `EMA 20 ${round2(e20)} > 50 ${round2(e50)} > 200 ${round2(e200)}`,
    };
  }

  // 3. TQ — weekly Relative Strength vs Nifty both > 0 (Scan TQ gate)
  const tq = weeklyTqStrength(weekly, nifty);

  // 4. Momentum — Monthly RSI cross >70 (Scan RSI M)
  let momentum: TechGroup;
  if (!mrsi) {
    momentum = {
      id: "momentum",
      label: "Momentum",
      status: monthlyRsi.length < 16 ? "unknown" : "fail",
      statusText: monthlyRsi.length < 16 ? "N/A" : "Fail",
      detail: monthlyRsi.length < 16 ? "Need history" : "No RSI",
    };
  } else {
    const ok = mrsi.crossed_above_70;
    momentum = {
      id: "momentum",
      label: "Momentum",
      status: ok ? "pass" : "fail",
      statusText: ok ? "Pass" : "Fail",
      detail: ok
        ? `RSI ${mrsi.rsi} · crossed above 70`
        : `RSI ${mrsi.rsi} · no cross >70`,
    };
  }

  // 5. Strong Momentum — Monthly RSI 85–90 (Scan 85–90)
  let strong: TechGroup;
  if (!mrsi) {
    strong = {
      id: "strong_momentum",
      label: "Strong Momentum",
      status: monthlyRsi.length < 16 ? "unknown" : "fail",
      statusText: monthlyRsi.length < 16 ? "N/A" : "Fail",
      detail: monthlyRsi.length < 16 ? "Need history" : "No RSI",
    };
  } else {
    const ok = mrsi.rsi >= 85 && mrsi.rsi < 90;
    strong = {
      id: "strong_momentum",
      label: "Strong Momentum",
      status: ok ? "pass" : "fail",
      statusText: ok ? "Pass" : "Fail",
      detail: `RSI ${mrsi.rsi}${ok ? " · 85–90" : ""}`,
    };
  }

  // 6. Exit — monthly RSI ≥ 90 (Scan RSI M red / overbought)
  let exit: TechGroup;
  if (!mrsi) {
    exit = {
      id: "exit",
      label: "Exit",
      status: "unknown",
      statusText: "N/A",
      detail: monthlyRsi.length < 16 ? "Need history" : "No RSI",
    };
  } else {
    const hot = mrsi.rsi >= 90;
    exit = {
      id: "exit",
      label: "Exit",
      status: hot ? "fail" : "pass",
      statusText: hot ? `Fail · ${mrsi.rsi}` : `Pass · ${mrsi.rsi}`,
      detail: hot
        ? `Monthly RSI ${mrsi.rsi} ≥ 90 — extended / overbought (Scan red)`
        : `Monthly RSI ${mrsi.rsi} < 90`,
    };
  }

  return {
    ticker: t,
    groups: [price200, trend, tq, momentum, strong, exit],
  };
}

import { fetchDailyBars } from "../ohlc";
import type { LiquidityScore } from "./types";

function avgValueLakh(bars: Array<{ close: number; volume: number }>): number | null {
  if (!bars.length) return null;
  let sum = 0;
  for (const b of bars) {
    sum += b.close * b.volume;
  }
  return sum / bars.length / 100_000;
}

export function scoreLiquidity(input: {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  price: number | null;
  avg20: number | null;
  avg60: number | null;
  avg120: number | null;
}): LiquidityScore {
  const flags: string[] = [];
  let score = 0;

  const rampRatio =
    input.avg20 != null && input.avg60 != null && input.avg60 > 0
      ? input.avg20 / input.avg60
      : null;

  const lowThreshold = 25;
  const isLow =
    input.avg60 != null &&
    input.avg60 > 0 &&
    input.avg60 <= lowThreshold;
  const isRamping =
    rampRatio != null &&
    rampRatio >= 1.25 &&
    input.avg120 != null &&
    input.avg60 != null &&
    input.avg120 > 0 &&
    input.avg60 / input.avg120 >= 1.08;

  if (isLow) {
    score += 35;
    flags.push("low_liquidity");
  }
  if (isRamping) {
    score += 40;
    flags.push("liquidity_ramp");
  }
  if (isLow && isRamping) {
    score += 20;
    flags.push("micro_monopoly_liquidity");
  }

  const mcap = input.market_cap_cr;
  if (mcap != null && mcap > 0 && mcap <= 1500 && isLow) {
    score += 10;
    flags.push("small_cap");
  }
  if (rampRatio != null && rampRatio >= 1.5) {
    score += 8;
    flags.push("strong_ramp");
  }

  score = Math.max(0, Math.min(100, score));

  let reason = "No liquidity ramp signal";
  if (isLow && isRamping) {
    reason = "Low daily turnover with 20d/60d volume ramp — attention may be building";
  } else if (isLow) {
    reason = "Low liquidity — thin float / quiet tape";
  } else if (isRamping) {
    reason = "Turnover rising vs prior months";
  }

  return {
    ticker: input.ticker,
    name: input.name,
    market: input.market,
    market_cap_cr: input.market_cap_cr,
    price: input.price,
    avg_value_20d_lakh: input.avg20,
    avg_value_60d_lakh: input.avg60,
    avg_value_120d_lakh: input.avg120,
    ramp_ratio: rampRatio,
    is_low_liquidity: !!isLow,
    is_ramping: !!isRamping,
    liquidity_score: score,
    flags,
    reason,
  };
}

export async function computeLiquidityScore(
  ticker: string,
  market: string,
  name: string,
  market_cap_cr: number | null,
  price: number | null,
): Promise<LiquidityScore> {
  const bars = await fetchDailyBars(ticker, market, 1);
  const tail = bars.slice(-130);
  const avg20 = avgValueLakh(tail.slice(-20));
  const avg60 = avgValueLakh(tail.slice(-60));
  const avg120 = avgValueLakh(tail.slice(-120));

  return scoreLiquidity({
    ticker: ticker.toUpperCase(),
    name,
    market,
    market_cap_cr,
    price,
    avg20,
    avg60,
    avg120,
  });
}

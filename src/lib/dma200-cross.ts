/**
 * Moved above 200 DMA on the latest session: last close above the 200-day
 * SMA, and the prior close strictly below its own 200-day SMA.
 */

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** SMA(200) ending at inclusive index `endIdx`. */
function sma200At(closes: number[], endIdx: number): number | null {
  if (endIdx < 199 || endIdx >= closes.length) return null;
  return mean(closes.slice(endIdx - 199, endIdx + 1));
}

/** Prior sessions that must close below their 200 DMA (filters whipsaws). */
export const DMA200_MIN_DAYS_BELOW = 5;
/** Today's close must clear the 200 DMA by this % (filters 1-paisa crosses). */
export const DMA200_MIN_CLEAR_PCT = 1;

/**
 * Fresh breakout above the 200 DMA: today's close ≥ DMA × (1 + minClearPct%)
 * and each of the previous `minDaysBelow` closes strictly below its own DMA.
 * Defaults stop sideways names chopping around the line (e.g. INFOMEDIA
 * 5.55 → 5.52 → 5.40 → 5.48 vs DMA 5.47) from flagging every wiggle.
 */
export function crossedAbove200DmaFromCloses(
  closes: number[],
  opts?: { minDaysBelow?: number; minClearPct?: number },
): boolean {
  const minDaysBelow = Math.max(1, opts?.minDaysBelow ?? DMA200_MIN_DAYS_BELOW);
  const minClear = Math.max(0, opts?.minClearPct ?? DMA200_MIN_CLEAR_PCT) / 100;
  const i = closes.length - 1;
  if (i < 199 + minDaysBelow) return false;
  const price = closes[i]!;
  const dmaToday = sma200At(closes, i);
  if (dmaToday == null || !(price >= dmaToday * (1 + minClear))) return false;
  for (let k = 1; k <= minDaysBelow; k++) {
    const j = i - k;
    const dma = sma200At(closes, j);
    if (dma == null || !(closes[j]! < dma)) return false;
  }
  return true;
}

/**
 * Tape-only fallback (price / prev_close / dma200). Prefer
 * `crossedAbove200DmaFromCloses` when daily bars are available.
 */
export function crossedAbove200Dma(tape: {
  price: number | null;
  dma200: number | null;
  prev_close: number | null;
} | null): boolean {
  if (!tape) return false;
  if (tape.price == null || tape.dma200 == null || tape.prev_close == null) {
    return false;
  }
  return tape.prev_close < tape.dma200 && tape.price > tape.dma200;
}

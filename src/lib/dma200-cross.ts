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

/**
 * @param minDaysBelow how many prior closes must be strictly below their DMA
 *   (default 1 = “moved above today”).
 */
export function crossedAbove200DmaFromCloses(
  closes: number[],
  opts?: { minDaysBelow?: number },
): boolean {
  const minDaysBelow = Math.max(1, opts?.minDaysBelow ?? 1);
  const i = closes.length - 1;
  if (i < 199 + minDaysBelow) return false;
  const price = closes[i]!;
  const dmaToday = sma200At(closes, i);
  if (dmaToday == null || !(price > dmaToday)) return false;
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

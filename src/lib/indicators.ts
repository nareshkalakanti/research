/** OHLCV bar used by BB / TQ scanners. */
export type Bar = {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function rollingMean(
  values: number[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average (SMA seed at index period-1). */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period < 1) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Pandas rolling.std() equivalent (sample std, ddof=1). */
export function rollingStd(
  values: number[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += values[j];
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = values[j] - mean;
      sq += d * d;
    }
    out[i] = Math.sqrt(sq / (period - 1));
  }
  return out;
}

export function rollingSum(
  values: number[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum;
  }
  return out;
}

export function bollingerBands(
  closes: number[],
  period = 50,
  width = 2,
): { upper: (number | null)[]; mid: (number | null)[]; lower: (number | null)[] } {
  const mid = rollingMean(closes, period);
  const std = rollingStd(closes, period);
  const upper = mid.map((m, i) =>
    m == null || std[i] == null ? null : m + width * (std[i] as number),
  );
  const lower = mid.map((m, i) =>
    m == null || std[i] == null ? null : m - width * (std[i] as number),
  );
  return { upper, mid, lower };
}

export function rsi(closes: number[], period = 21): (number | null)[] {
  const gains: number[] = new Array(closes.length).fill(0);
  const losses: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const avgGain = rollingMean(gains, period);
  const avgLoss = rollingMean(losses, period);
  return avgGain.map((g, i) => {
    const l = avgLoss[i];
    if (g == null || l == null) return null;
    if (l === 0) return 100;
    const rs = g / l;
    return 100 - 100 / (1 + rs);
  });
}

function trueRange(bars: Bar[]): number[] {
  const out: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i += 1) {
    const h = bars[i].high;
    const l = bars[i].low;
    if (i === 0) {
      out[i] = h - l;
      continue;
    }
    const prev = bars[i - 1].close;
    out[i] = Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
  }
  return out;
}

export function atr(bars: Bar[], period = 10): (number | null)[] {
  return rollingMean(trueRange(bars), period);
}

export function supertrend(
  bars: Bar[],
  atrPeriod = 10,
  factor = 3,
): { line: (number | null)[]; direction: number[] } {
  const n = bars.length;
  const atrVals = atr(bars, atrPeriod);
  const basicUpper: (number | null)[] = new Array(n).fill(null);
  const basicLower: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const a = atrVals[i];
    if (a == null) continue;
    const hl2 = (bars[i].high + bars[i].low) / 2;
    basicUpper[i] = hl2 + factor * a;
    basicLower[i] = hl2 - factor * a;
  }

  const finalUpper: (number | null)[] = [...basicUpper];
  const finalLower: (number | null)[] = [...basicLower];
  for (let i = 1; i < n; i += 1) {
    const bu = basicUpper[i];
    const bl = basicLower[i];
    const pu = finalUpper[i - 1];
    const pl = finalLower[i - 1];
    if (bu == null) finalUpper[i] = null;
    else if (pu == null || bu < pu || bars[i - 1].close > pu) finalUpper[i] = bu;
    else finalUpper[i] = pu;

    if (bl == null) finalLower[i] = null;
    else if (pl == null || bl > pl || bars[i - 1].close < pl) finalLower[i] = bl;
    else finalLower[i] = pl;
  }

  const line: (number | null)[] = new Array(n).fill(null);
  const direction: number[] = new Array(n).fill(-1);
  line[0] = finalUpper[0];
  direction[0] = -1;
  for (let i = 1; i < n; i += 1) {
    const pu = finalUpper[i - 1];
    const pl = finalLower[i - 1];
    if (pu != null && bars[i].close > pu) direction[i] = 1;
    else if (pl != null && bars[i].close < pl) direction[i] = -1;
    else direction[i] = direction[i - 1];
    line[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i];
  }
  return { line, direction };
}

export function adx(
  bars: Bar[],
  period = 13,
): {
  adx: (number | null)[];
  diPlus: (number | null)[];
  diMinus: (number | null)[];
} {
  const n = bars.length;
  const tr = trueRange(bars);
  const dmPlus: number[] = new Array(n).fill(0);
  const dmMinus: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    dmPlus[i] = up > down && up > 0 ? up : 0;
    dmMinus[i] = down > up && down > 0 ? down : 0;
  }
  const trSmooth = rollingSum(tr, period);
  const plusSmooth = rollingSum(dmPlus, period);
  const minusSmooth = rollingSum(dmMinus, period);
  const diPlus: (number | null)[] = new Array(n).fill(null);
  const diMinus: (number | null)[] = new Array(n).fill(null);
  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const trs = trSmooth[i];
    const ps = plusSmooth[i];
    const ms = minusSmooth[i];
    if (trs == null || ps == null || ms == null || trs === 0) continue;
    const p = (100 * ps) / trs;
    const m = (100 * ms) / trs;
    diPlus[i] = p;
    diMinus[i] = m;
    const den = p + m;
    dx[i] = den === 0 ? 0 : (100 * Math.abs(p - m)) / den;
  }
  const dxNums = dx.map((v) => (v == null ? 0 : v));
  // Only average when we have full windows of defined DX — use rolling mean on dx with nulls as skip
  const adxOut: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (i < period * 2 - 2) continue;
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (dx[j] == null) {
        ok = false;
        break;
      }
      sum += dx[j] as number;
    }
    if (ok) adxOut[i] = sum / period;
  }
  void dxNums;
  return { adx: adxOut, diPlus, diMinus };
}

/** Relative strength vs benchmark over `period` bars. */
export function relativeStrength(
  stockCloses: number[],
  benchCloses: number[],
  period: number,
): (number | null)[] {
  const n = Math.min(stockCloses.length, benchCloses.length);
  const out: (number | null)[] = new Array(n).fill(null);
  const ratio: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    ratio[i] =
      benchCloses[i] !== 0 ? stockCloses[i] / benchCloses[i] : Number.NaN;
  }
  for (let i = period; i < n; i += 1) {
    const now = ratio[i];
    const ago = ratio[i - period];
    if (!isNum(now) || !isNum(ago) || ago === 0) {
      out[i] = null;
    } else {
      out[i] = now / ago - 1;
    }
  }
  return out;
}

/** Align stock + nifty bars on shared dates (sorted asc). */
export function alignBars(
  stock: Bar[],
  nifty: Bar[],
  minBars: number,
): { stock: Bar[]; nifty: Bar[] } | null {
  const nMap = new Map(nifty.map((b) => [b.date, b]));
  const stockAligned: Bar[] = [];
  const niftyAligned: Bar[] = [];
  for (const b of stock) {
    const nb = nMap.get(b.date);
    if (!nb) continue;
    stockAligned.push(b);
    niftyAligned.push(nb);
  }
  if (stockAligned.length < minBars) return null;
  return { stock: stockAligned, nifty: niftyAligned };
}

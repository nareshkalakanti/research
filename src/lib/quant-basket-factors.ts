/** Pure factor math for Scan · Basket. No I/O. */

export function opmPct(
  revenue: number | null | undefined,
  ebit: number | null | undefined,
): number | null {
  if (
    revenue == null ||
    ebit == null ||
    !Number.isFinite(revenue) ||
    !Number.isFinite(ebit) ||
    revenue === 0
  ) {
    return null;
  }
  return ebit / revenue;
}

export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const varSum = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(varSum / (values.length - 1));
}

export function opmStd(opm: Array<number | null>): number | null {
  const xs = opm.filter((v): v is number => v != null && Number.isFinite(v));
  return stdev(xs);
}

/** Coefficient of variation; null if |mean| is too small. */
export function patCv(pats: Array<number | null>): number | null {
  const xs = pats.filter((v): v is number => v != null && Number.isFinite(v));
  if (xs.length < 2) return null;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  if (Math.abs(mean) < 1e-9) return null;
  const s = stdev(xs);
  if (s == null) return null;
  return s / Math.abs(mean);
}

export function winsorize(values: number[], loP = 0.01, hiP = 0.99): number[] {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[Math.floor((sorted.length - 1) * loP)]!;
  const hi = sorted[Math.floor((sorted.length - 1) * hiP)]!;
  return values.map((v) => Math.min(hi, Math.max(lo, v)));
}

export function zScores(values: Array<number | null>): Array<number | null> {
  const idx: number[] = [];
  const xs: number[] = [];
  values.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) {
      idx.push(i);
      xs.push(v);
    }
  });
  const out: Array<number | null> = values.map(() => null);
  if (xs.length < 2) return out;
  const w = winsorize(xs);
  const mean = w.reduce((s, v) => s + v, 0) / w.length;
  const sd = stdev(w);
  if (sd == null || sd === 0) return out;
  idx.forEach((orig, j) => {
    out[orig] = (w[j]! - mean) / sd;
  });
  return out;
}

/** Higher EBIT/mcap = cheaper. Negative EBIT ranks last. */
export function earningsYield(
  ebitTtm: number | null,
  mcapCr: number | null,
): number | null {
  if (ebitTtm == null || mcapCr == null || mcapCr <= 0) return null;
  if (!Number.isFinite(ebitTtm) || !Number.isFinite(mcapCr)) return null;
  if (ebitTtm <= 0) return null;
  return ebitTtm / mcapCr;
}

export function combineWeighted(
  parts: Array<{ z: number | null; weight: number }>,
): number | null {
  let wsum = 0;
  let x = 0;
  for (const p of parts) {
    if (p.z == null || !Number.isFinite(p.z) || p.weight === 0) continue;
    wsum += Math.abs(p.weight);
    x += p.z * p.weight;
  }
  if (wsum <= 0) return null;
  return x / wsum;
}

/**
 * Walk score order; keep at most floor(n * maxSectorShare) names per sector.
 * Equal-weight book of up to n names.
 */
export function pickSectorCappedBook<T extends { sector: string; score: number }>(
  ranked: T[],
  n: number,
  maxSectorShare: number,
): T[] {
  const cap = Math.max(1, Math.floor(n * maxSectorShare));
  const per = new Map<string, number>();
  const out: T[] = [];
  for (const row of ranked) {
    if (out.length >= n) break;
    const sec = row.sector || "_";
    const used = per.get(sec) ?? 0;
    if (used >= cap) continue;
    per.set(sec, used + 1);
    out.push(row);
  }
  return out;
}

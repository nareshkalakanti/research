/** Mean-variance: L = α·P − (λ/2) Pᵀ F P. No issuer lists. */

export function logReturnsFromCloses(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (!(a > 0) || !(b > 0)) continue;
    out.push(Math.log(b / a));
  }
  return out;
}

export function meanVec(series: number[][]): number[] {
  const n = series[0]?.length ?? 0;
  const m = series.length;
  const mu = new Array(n).fill(0);
  if (!m || !n) return mu;
  for (const row of series) {
    for (let j = 0; j < n; j++) mu[j] += row[j]!;
  }
  for (let j = 0; j < n; j++) mu[j]! /= m;
  return mu;
}

export function covMatrix(series: number[][]): number[][] {
  const n = series[0]?.length ?? 0;
  const m = series.length;
  const mu = meanVec(series);
  const F = Array.from({ length: n }, () => new Array(n).fill(0));
  if (m < 2 || !n) return F;
  for (const row of series) {
    for (let i = 0; i < n; i++) {
      const di = row[i]! - mu[i]!;
      for (let j = i; j < n; j++) {
        const v = di * (row[j]! - mu[j]!);
        F[i]![j] += v;
        if (j !== i) F[j]![i] += v;
      }
    }
  }
  const den = m - 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) F[i]![j] /= den;
  }
  return F;
}

export function ridge(F: number[][], eps: number): number[][] {
  const n = F.length;
  return F.map((row, i) => row.map((v, j) => v + (i === j ? eps : 0)));
}

/** Solve A x = b for SPD-ish A (Gaussian elimination with partial pivot). */
export function solveLinear(A0: number[][], b0: number[]): number[] | null {
  const n = b0.length;
  if (!n || A0.length !== n) return null;
  const A = A0.map((row) => row.slice());
  const b = b0.slice();
  for (let k = 0; k < n; k++) {
    let piv = k;
    let best = Math.abs(A[k]![k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i]![k]!);
      if (v > best) {
        best = v;
        piv = i;
      }
    }
    if (best < 1e-14) return null;
    if (piv !== k) {
      [A[k], A[piv]] = [A[piv]!, A[k]!];
      [b[k], b[piv]] = [b[piv]!, b[k]!];
    }
    const akk = A[k]![k]!;
    for (let i = k + 1; i < n; i++) {
      const f = A[i]![k]! / akk;
      b[i]! -= f * b[k]!;
      for (let j = k; j < n; j++) A[i]![j]! -= f * A[k]![j]!;
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]!;
    const d = A[i]![i]!;
    if (Math.abs(d) < 1e-14) return null;
    x[i] = s / d;
  }
  return x;
}

export function projectSimplex(w: number[]): number[] {
  const clipped = w.map((x) => Math.max(0, x));
  const s = clipped.reduce((a, b) => a + b, 0);
  if (s > 1e-12) return clipped.map((x) => x / s);
  const n = w.length;
  return n ? new Array(n).fill(1 / n) : [];
}

/** Pull extreme α toward the cross-section so one spike cannot take 100%. */
export function shrinkAlpha(alpha: number[]): number[] {
  const n = alpha.length;
  if (!n) return [];
  const mu = alpha.reduce((s, x) => s + x, 0) / n;
  const var_ =
    alpha.reduce((s, x) => s + (x - mu) * (x - mu), 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(Math.max(var_, 1e-12));
  return alpha.map((x) => {
    const z = Math.max(-2, Math.min(2, (x - mu) / sd));
    return mu + 0.5 * z * sd;
  });
}

/** Long-only, sum 1, no name above maxW. */
export function capWeights(w: number[], maxW: number): number[] {
  const n = w.length;
  if (!n) return [];
  const cap = Math.min(1, Math.max(1 / n, maxW));
  let x = projectSimplex(w);
  for (let k = 0; k < n + 2; k++) {
    const over = x.map((v, i) => (v > cap + 1e-12 ? i : -1)).filter((i) => i >= 0);
    if (!over.length) return x;
    let leftover = 0;
    const y = x.slice();
    for (const i of over) {
      leftover += y[i]! - cap;
      y[i] = cap;
    }
    const free = y
      .map((v, i) => (over.includes(i) ? -1 : i))
      .filter((i) => i >= 0);
    const room = free.reduce((s, i) => s + Math.max(0, cap - y[i]!), 0);
    if (room < 1e-12) return projectSimplex(y);
    for (const i of free) {
      const r = Math.max(0, cap - y[i]!);
      y[i]! += leftover * (r / room);
    }
    x = projectSimplex(y);
  }
  return x;
}

export function utility(
  alpha: number[],
  P: number[],
  F: number[][],
  lambda: number,
): number {
  let a = 0;
  let q = 0;
  const n = P.length;
  for (let i = 0; i < n; i++) {
    a += alpha[i]! * P[i]!;
    let Fi = 0;
    for (let j = 0; j < n; j++) Fi += F[i]![j]! * P[j]!;
    q += P[i]! * Fi;
  }
  return a - (lambda / 2) * q;
}

export function gradient(
  alpha: number[],
  P: number[],
  F: number[][],
  lambda: number,
): number[] {
  const n = P.length;
  const g = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let Fi = 0;
    for (let j = 0; j < n; j++) Fi += F[i]![j]! * P[j]!;
    g[i] = alpha[i]! - lambda * Fi;
  }
  return g;
}

export function ones(n: number): number[] {
  return new Array(n).fill(1);
}

function subMatrix(F: number[][], idx: number[]): number[][] {
  return idx.map((i) => idx.map((j) => F[i]![j]!));
}

/** Budget 1ᵀP = 1, then drop negative weights and re-solve (active set). */
export function optimalWeights(
  alpha: number[],
  F: number[][],
  lambda: number,
): number[] | null {
  const n = alpha.length;
  if (!n || lambda <= 0) return null;
  let active = [...Array(n).keys()];
  const w = new Array(n).fill(0);
  for (let it = 0; it < n + 2; it++) {
    if (!active.length) return projectSimplex(alpha.slice());
    const Fa = subMatrix(F, active);
    const aa = active.map((i) => alpha[i]!);
    const Fia = solveLinear(Fa, aa);
    const Fi1 = solveLinear(Fa, ones(active.length));
    if (!Fia || !Fi1) return projectSimplex(aa);
    const oneTFia = Fia.reduce((s, x) => s + x, 0);
    const oneTFi1 = Fi1.reduce((s, x) => s + x, 0);
    if (Math.abs(oneTFi1) < 1e-12) return projectSimplex(aa);
    const gamma = (oneTFia - lambda) / oneTFi1;
    const raw = Fia.map((x, k) => (x - gamma * Fi1[k]!) / lambda);
    const neg = active.filter((_, k) => raw[k]! < -1e-9);
    for (let k = 0; k < active.length; k++) w[active[k]!] = raw[k]!;
    if (!neg.length) {
      for (let i = 0; i < n; i++) if (!active.includes(i)) w[i] = 0;
      const s = w.reduce((a, b) => a + b, 0);
      if (s > 1e-12) return w.map((x) => Math.max(0, x) / s);
      return projectSimplex(w);
    }
    active = active.filter((i) => !neg.includes(i));
    for (const i of neg) w[i] = 0;
  }
  return projectSimplex(w);
}

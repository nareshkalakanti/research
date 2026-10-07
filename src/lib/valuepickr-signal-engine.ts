/**
 * Deterministic ValuePickr Activity Signal.
 * Same snapshot → same numbers. No LLM. No invented counts.
 *
 * Weights (documented, not per-stock):
 *   30% recent discussion (30D post count)
 *   25% discussion momentum ((cur-prev)/prev)
 *   20% contributor breadth (distinct authors, 30D)
 *   15% new contributor growth (first company post in 30D)
 *   10% discussion persistence (active months in last 12 / 12)
 *
 * Normalization: empirical percentile rank among companies in the same
 * snapshot that have a numeric component (mid-rank for ties). Rank 0…1
 * then × 100. Weighted sum is the Activity Signal (0–100), rounded.
 *
 * Insufficient: fewer than MIN_POSTS dated posts → no score.
 */

export const VP_MIN_POSTS = 3;

export const VP_WEIGHTS = {
  recent: 0.3,
  momentum: 0.25,
  breadth: 0.2,
  newContributors: 0.15,
  persistence: 0.1,
} as const;

export type VpPost = {
  post_id: string;
  company_id: string | null;
  author_id: string;
  posted_at: string | null;
};

export type VpWindow = { current: number; previous: number };

export type VpMomentum = {
  current: number;
  previous: number;
  pct: number | null;
  label: "OK" | "NEW ACTIVITY" | "NO ACTIVITY";
};

export type VpPersistence = {
  active_months_all: number;
  active_months_12: number;
  consecutive: number;
  longest_streak: number;
  months: string[];
};

export type VpComponents = {
  mentions_1d: number;
  mentions_30d: number;
  mentions_90d: number;
  mentions_12m: number;
  mentions_all: number;
  momentum_30d: VpMomentum;
  contributors_30d: number;
  contributors_90d: number;
  contributors_12m: number;
  new_contributors_30d: number;
  new_contributors_90d: number;
  returning_30d: number;
  posts_per_contributor_30d: number | null;
  persistence: VpPersistence;
};

export type VpQuality = {
  grade: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT DATA";
  posts: number;
  contributors: number;
  months: number;
  mapping_confidence: number | null;
  dated_share: number;
  why: string;
};

export type VpSignalRow = {
  company_id: string;
  components: VpComponents;
  quality: VpQuality;
  signal: number | null;
  signal_label: "INSUFFICIENT DATA" | "VERY STRONG" | "STRONG" | "BUILDING";
  parts: {
    recent: number | null;
    momentum: number | null;
    breadth: number | null;
    newContributors: number | null;
    persistence: number | null;
  };
};

function dayMs(n: number): number {
  return n * 24 * 60 * 60 * 1000;
}

export function parsePostedAt(iso: string | null | undefined): Date | null {
  if (!iso || !String(iso).trim()) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function countInWindow(
  posts: VpPost[],
  asOf: Date,
  days: number,
): number {
  const end = asOf.getTime();
  const start = end - dayMs(days);
  let n = 0;
  for (const p of posts) {
    const d = parsePostedAt(p.posted_at);
    if (!d) continue;
    const t = d.getTime();
    if (t > end) continue;
    if (t > start) n += 1;
  }
  return n;
}

export function priorWindowCount(
  posts: VpPost[],
  asOf: Date,
  days: number,
): VpWindow {
  return {
    current: countInWindow(posts, asOf, days),
    previous: countInWindow(posts, new Date(asOf.getTime() - dayMs(days)), days),
  };
}

export function calculateMentionMomentum(win: VpWindow): VpMomentum {
  const { current, previous } = win;
  if (previous === 0 && current === 0) {
    return { current, previous, pct: null, label: "NO ACTIVITY" };
  }
  if (previous === 0) {
    return { current, previous, pct: null, label: "NEW ACTIVITY" };
  }
  return {
    current,
    previous,
    pct: ((current - previous) / previous) * 100,
    label: "OK",
  };
}

export function uniqueAuthors(posts: VpPost[]): number {
  const s = new Set<string>();
  for (const p of posts) {
    if (p.author_id) s.add(p.author_id);
  }
  return s.size;
}

export function authorsInWindow(
  posts: VpPost[],
  asOf: Date,
  days: number,
): Set<string> {
  const end = asOf.getTime();
  const start = end - dayMs(days);
  const s = new Set<string>();
  for (const p of posts) {
    const d = parsePostedAt(p.posted_at);
    if (!d) continue;
    const t = d.getTime();
    if (t > end || t <= start) continue;
    if (p.author_id) s.add(p.author_id);
  }
  return s;
}

function firstPostByAuthor(posts: VpPost[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of posts) {
    const d = parsePostedAt(p.posted_at);
    if (!d || !p.author_id) continue;
    const t = d.getTime();
    const prev = m.get(p.author_id);
    if (prev == null || t < prev) m.set(p.author_id, t);
  }
  return m;
}

export function calculateNewContributors(
  posts: VpPost[],
  asOf: Date,
  days: number,
): number {
  const end = asOf.getTime();
  const start = end - dayMs(days);
  const first = firstPostByAuthor(posts);
  let n = 0;
  for (const t of first.values()) {
    if (t > start && t <= end) n += 1;
  }
  return n;
}

function ym(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function calculatePersistence(
  posts: VpPost[],
  asOf: Date,
): VpPersistence {
  const months = new Set<string>();
  for (const p of posts) {
    const d = parsePostedAt(p.posted_at);
    if (!d) continue;
    months.add(ym(d));
  }
  const sorted = [...months].sort();
  const last12: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(
      Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1),
    );
    last12.push(ym(d));
  }
  const active12 = last12.filter((m) => months.has(m)).length;
  let consecutive = 0;
  for (const m of last12) {
    if (!months.has(m)) break;
    consecutive += 1;
  }
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const m of sorted) {
    if (prev) {
      const [py, pm] = prev.split("-").map(Number);
      const [y, mo] = m.split("-").map(Number);
      const next =
        pm === 12 ? `${py + 1}-01` : `${py}-${String(pm! + 1).padStart(2, "0")}`;
      const cur = `${y}-${String(mo).padStart(2, "0")}`;
      run = next === cur ? run + 1 : 1;
    } else {
      run = 1;
    }
    longest = Math.max(longest, run);
    prev = m;
  }
  return {
    active_months_all: sorted.length,
    active_months_12: active12,
    consecutive,
    longest_streak: longest,
    months: sorted,
  };
}

export function calculateRecentMentions(
  posts: VpPost[],
  asOf: Date,
): Pick<
  VpComponents,
  | "mentions_1d"
  | "mentions_30d"
  | "mentions_90d"
  | "mentions_12m"
  | "mentions_all"
> {
  return {
    mentions_1d: countInWindow(posts, asOf, 1),
    mentions_30d: countInWindow(posts, asOf, 30),
    mentions_90d: countInWindow(posts, asOf, 90),
    mentions_12m: countInWindow(posts, asOf, 365),
    mentions_all: posts.length,
  };
}

export function calculateContributorBreadth(
  posts: VpPost[],
  asOf: Date,
): Pick<
  VpComponents,
  "contributors_30d" | "contributors_90d" | "contributors_12m"
> {
  return {
    contributors_30d: authorsInWindow(posts, asOf, 30).size,
    contributors_90d: authorsInWindow(posts, asOf, 90).size,
    contributors_12m: authorsInWindow(posts, asOf, 365).size,
  };
}

export function componentsForPosts(posts: VpPost[], asOf: Date): VpComponents {
  const recent = calculateRecentMentions(posts, asOf);
  const breadth = calculateContributorBreadth(posts, asOf);
  const mom = calculateMentionMomentum(priorWindowCount(posts, asOf, 30));
  const new30 = calculateNewContributors(posts, asOf, 30);
  const new90 = calculateNewContributors(posts, asOf, 90);
  const ret30 = Math.max(0, breadth.contributors_30d - new30);
  const ppc =
    breadth.contributors_30d > 0
      ? recent.mentions_30d / breadth.contributors_30d
      : null;
  return {
    ...recent,
    ...breadth,
    momentum_30d: mom,
    new_contributors_30d: new30,
    new_contributors_90d: new90,
    returning_30d: ret30,
    posts_per_contributor_30d: ppc,
    persistence: calculatePersistence(posts, asOf),
  };
}

export function calculateDataQuality(
  posts: VpPost[],
  asOf: Date,
  mappingConfidence: number | null,
): VpQuality {
  const dated = posts.filter((p) => parsePostedAt(p.posted_at)).length;
  const contributors = uniqueAuthors(posts);
  const pers = calculatePersistence(posts, asOf);
  const datedShare = posts.length ? dated / posts.length : 0;
  if (dated < VP_MIN_POSTS) {
    return {
      grade: "INSUFFICIENT DATA",
      posts: posts.length,
      contributors,
      months: pers.active_months_all,
      mapping_confidence: mappingConfidence,
      dated_share: datedShare,
      why: "Not enough ValuePickr history to calculate this signal.",
    };
  }
  const mapOk = mappingConfidence == null ? 0 : mappingConfidence;
  let grade: VpQuality["grade"] = "LOW";
  if (dated >= 40 && contributors >= 8 && pers.active_months_12 >= 6 && mapOk >= 0.7) {
    grade = "HIGH";
  } else if (
    dated >= 10 &&
    contributors >= 3 &&
    pers.active_months_all >= 2 &&
    mapOk >= 0.5
  ) {
    grade = "MEDIUM";
  }
  return {
    grade,
    posts: dated,
    contributors,
    months: pers.active_months_all,
    mapping_confidence: mappingConfidence,
    dated_share: datedShare,
    why: `${dated} dated posts · ${contributors} contributors · ${pers.active_months_all} active months`,
  };
}

/** Mid-rank percentile 0…1. Empty → []. */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (!n) return [];
  if (n === 1) return [1];
  const idx = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v || a.i - b.i);
  const out = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1]!.v === idx[i]!.v) j += 1;
    const mid = (i + j) / 2;
    const p = mid / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k]!.i] = p;
    i = j + 1;
  }
  return out;
}

function momentumRaw(m: VpMomentum): number | null {
  if (m.label === "NO ACTIVITY") return 0;
  if (m.label === "NEW ACTIVITY") return 100;
  return m.pct;
}

function signalLabel(score: number | null): VpSignalRow["signal_label"] {
  if (score == null) return "INSUFFICIENT DATA";
  if (score >= 80) return "VERY STRONG";
  if (score >= 60) return "STRONG";
  return "BUILDING";
}

export function calculateActivitySignal(
  byCompany: Map<string, VpPost[]>,
  asOf: Date,
  mappingConfidence: Map<string, number | null>,
): VpSignalRow[] {
  const ids = [...byCompany.keys()].sort();
  const comps = ids.map((id) =>
    componentsForPosts(byCompany.get(id) ?? [], asOf),
  );
  const quality = ids.map((id, i) =>
    calculateDataQuality(
      byCompany.get(id) ?? [],
      asOf,
      mappingConfidence.get(id) ?? null,
    ),
  );
  const usable = ids.map((_, i) => quality[i]!.grade !== "INSUFFICIENT DATA");
  const col = (pick: (c: VpComponents) => number | null): (number | null)[] => {
    const raw = comps.map((c, i) => (usable[i] ? pick(c) : null));
    const nums = raw
      .map((v, i) => ({ v, i }))
      .filter((x): x is { v: number; i: number } => x.v != null);
    const ranks = percentileRanks(nums.map((x) => x.v));
    const out: (number | null)[] = raw.map(() => null);
    nums.forEach((x, k) => {
      out[x.i] = ranks[k]! * 100;
    });
    return out;
  };
  const recent = col((c) => c.mentions_30d);
  const momentum = col((c) => momentumRaw(c.momentum_30d));
  const breadth = col((c) => c.contributors_30d);
  const newer = col((c) => c.new_contributors_30d);
  const persist = col((c) => c.persistence.active_months_12 / 12);
  return ids.map((id, i) => {
    const parts = {
      recent: recent[i] ?? null,
      momentum: momentum[i] ?? null,
      breadth: breadth[i] ?? null,
      newContributors: newer[i] ?? null,
      persistence: persist[i] ?? null,
    };
    let signal: number | null = null;
    if (usable[i]) {
      const w = VP_WEIGHTS;
      const s =
        (parts.recent ?? 0) * w.recent +
        (parts.momentum ?? 0) * w.momentum +
        (parts.breadth ?? 0) * w.breadth +
        (parts.newContributors ?? 0) * w.newContributors +
        (parts.persistence ?? 0) * w.persistence;
      signal = Math.round(s);
    }
    return {
      company_id: id,
      components: comps[i]!,
      quality: quality[i]!,
      signal,
      signal_label: signalLabel(signal),
      parts,
    };
  });
}

export function monthlyMentionBars(
  posts: VpPost[],
  asOf: Date,
  tagOf: (p: VpPost) => "pos" | "neg" | "neu" | "q",
): {
  month: string;
  pos: number;
  neg: number;
  neu: number;
  q: number;
  total: number;
}[] {
  const dated = posts
    .map((p) => ({ p, d: parsePostedAt(p.posted_at) }))
    .filter((x): x is { p: VpPost; d: Date } => x.d != null);
  if (!dated.length) return [];
  const first = dated.reduce(
    (m, x) => (x.d < m ? x.d : m),
    dated[0]!.d,
  );
  const startY = first.getUTCFullYear();
  const startM = first.getUTCMonth();
  const endY = asOf.getUTCFullYear();
  const endM = asOf.getUTCMonth();
  const months: string[] = [];
  let y = startY;
  let mo = startM;
  while (y < endY || (y === endY && mo <= endM)) {
    months.push(`${y}-${String(mo + 1).padStart(2, "0")}`);
    mo += 1;
    if (mo > 11) {
      mo = 0;
      y += 1;
    }
  }
  const by = new Map<string, { pos: number; neg: number; neu: number; q: number }>();
  for (const m of months) by.set(m, { pos: 0, neg: 0, neu: 0, q: 0 });
  for (const { p, d } of dated) {
    const key = ym(d);
    const bucket = by.get(key);
    if (!bucket) continue;
    bucket[tagOf(p)] += 1;
  }
  return months.map((month) => {
    const b = by.get(month)!;
    return {
      month,
      ...b,
      total: b.pos + b.neg + b.neu + b.q,
    };
  });
}

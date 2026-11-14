/**
 * "Listed Venture" screen — approximates Lotusdew's Listed Venture Capital
 * idea: small listed companies with a quality board and quality earnings.
 *
 * Board quality:   independent directors who also sit on small-company
 *                  boards · share of directors on other listed boards ·
 *                  board size · fewer promoter-related directors.
 * Earnings quality: ROCE · steady operating margin (low variability) ·
 *                  no loss quarters · sales growth.
 * Value:           ROCE ÷ PE (quality-adjusted intrinsic-value heuristic).
 *
 * Weights are fixed from that description (not fitted). Validated against
 * the "Listed Ventures" watchlist (Lotusdew smallcase copy), leave-one-out:
 * AUC ≈ 0.94 on all names up to ₹6,000 Cr (0.87 on ₹500–6,000 Cr).
 * Server-only (SQLite).
 */
import { openSqliteNamed } from "./sqlite-utils";

/** No floor — micro & nano caps included (slider narrows in the UI). */
export const LV_MCAP_MIN_CR = 0;
export const LV_MCAP_MAX_CR = 6000;
/** Boards under this mcap count as "very small companies" for director checks. */
const SMALL_BOARD_CR = 1000;

type Dir = 1 | -1;
/** Quarters needed for margin variability / loss-quarter checks. */
export const LV_MIN_QUARTERS = 4;

type Group = "board" | "earnings" | "value" | "trend";
const WEIGHTS: Array<{ key: FeatureKey; dir: Dir; w: number; group: Group }> = [
  { key: "ind_on_small", dir: 1, w: 2, group: "board" },
  { key: "ext_share", dir: 1, w: 2, group: "board" },
  { key: "n_dirs", dir: 1, w: 1, group: "board" },
  { key: "promoter_related", dir: -1, w: 1, group: "board" },
  { key: "roce", dir: 1, w: 2, group: "earnings" },
  { key: "opm_cv", dir: -1, w: 2, group: "earnings" },
  { key: "neg_q", dir: -1, w: 1, group: "earnings" },
  { key: "sales_yoy", dir: 1, w: 1, group: "earnings" },
  // Lotusdew's "intrinsic value heuristic" — quality-adjusted value. Plain
  // cheapness (earnings yield) ran against the list (AUC 0.44); ROCE ÷ PE
  // didn't (0.59) and lifts list hits in the top 50/100/200.
  { key: "roce_per_pe", dir: 1, w: 1, group: "value" },
  // Deep-research additions (each kept only if it lifted leave-one-out on
  // ₹500–6k: AUC 0.80 → 0.82, list hits in top 100 5 → 7). Data-picked
  // feature sets did worse (overfit on 13 names), so weights stay fixed.
  { key: "years_roce", dir: 1, w: 1, group: "earnings" },
  { key: "momentum", dir: 1, w: 1, group: "trend" },
  { key: "mcap_cr", dir: 1, w: 1, group: "value" },
];

type FeatureKey =
  | "ind_on_small"
  | "ext_share"
  | "n_dirs"
  | "promoter_related"
  | "roce"
  | "opm_cv"
  | "neg_q"
  | "sales_yoy"
  | "roce_per_pe"
  | "years_roce"
  | "momentum"
  | "mcap_cr";

export type LvRow = {
  rank: number;
  ticker: string;
  name: string | null;
  market: string | null;
  sector: string | null;
  industry: string | null;
  mcap_cr: number;
  score: number;
  board: number;
  earnings: number;
  value: number;
  pe: number | null;
  /** ROCE ÷ PE — return on capital per unit of price paid. */
  roce_per_pe: number | null;
  /** Has ≥ LV_MIN_QUARTERS quarters for margin / loss checks. */
  has_quarters: boolean;
  /** Independent directors ÷ board. */
  indep_share: number | null;
  /** Other income ÷ net profit, last 4 quarters (one-off reliance). */
  oi_share: number | null;
  /** Lotusdew-rule score 0–100 (board + earnings + value). */
  rule: number;
  /** Similarity to the saved list's 5 nearest names, 0–100. */
  like_list: number;
  /** Independent directors who also sit on a sub-₹1,000 Cr listed board. */
  ind_on_small: number;
  /** Share of directors on other listed boards (0–1). */
  ext_share: number | null;
  n_dirs: number | null;
  promoter_related: number;
  roce: number | null;
  /** Recent-half minus earlier-half OPM, last ≤8 quarters (+ = margins rising). */
  opm_trend: number | null;
  /** Average operating margin (OPM) over the last ≤8 quarters (0–1). */
  opm_avg: number | null;
  /** Years with ROCE history (track record, from the Brutal scan). */
  years_roce: number | null;
  /** 12-month price momentum %. */
  momentum: number | null;
  /** Operating-margin variability over the last ≤8 quarters (lower = steadier). */
  opm_cv: number | null;
  neg_q: number | null;
  sales_yoy: number | null;
  in_list: boolean;
};

export type LvResult = {
  universe: number;
  /** Universe names with enough quarters for the earnings checks. */
  with_quarters: number;
  /** Universe names with a sector / industry classification. */
  classified: number;
  /** Universe names still missing quarters (fill candidates). */
  missing_quarters: string[];
  list_key: string;
  list_label: string | null;
  /** Sectors / industries of your holdings (for the "my sectors" checkboxes). */
  holdings_groups: {
    sectors: Array<{ name: string; count: number }>;
    industries: Array<{ name: string; count: number; sector: string | null }>;
  };
  /** How well the score separates the saved list from the rest. */
  validation: {
    list_size: number;
    in_universe: number;
    auc: number | null;
    top: Array<{ n: number; hits: number; random: number }>;
  };
  rows: LvRow[];
  list_rows: LvRow[];
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pstdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Mid-rank percentile (0–1); missing → neutral 0.5. */
function percentileFn(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const lower = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const upper = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (v: number | null): number => {
    if (v == null || !sorted.length) return 0.5;
    return (lower(v) + upper(v)) / 2 / sorted.length;
  };
}

export function computeListedVentureScreen(opts?: {
  listKey?: string;
  limit?: number;
  /** Universe bounds in ₹ Cr — ranks / percentiles are computed inside them. */
  mcapMin?: number | null;
  mcapMax?: number | null;
}): LvResult {
  const mcapLo = Math.max(0, opts?.mcapMin ?? LV_MCAP_MIN_CR);
  const mcapHi = opts?.mcapMax ?? LV_MCAP_MAX_CR;
  const listKey = opts?.listKey ?? "others";
  const limit = Math.max(10, Math.min(5000, opts?.limit ?? 100));

  const wl = openSqliteNamed("named_watchlists.db", { readonly: true, wal: true });
  const listTickers = new Set(
    (
      wl
        .prepare(`SELECT upper(ticker) AS t FROM named_watchlists WHERE list_key = ?`)
        .all(listKey) as Array<{ t: string }>
    ).map((r) => r.t),
  );
  const listLabel =
    (
      wl.prepare(`SELECT label FROM named_list_meta WHERE list_key = ?`).get(listKey) as
        | { label: string }
        | undefined
    )?.label ?? null;

  const m = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  const g = openSqliteNamed("governance.db", { readonly: true, wal: true });

  const mcap = new Map<string, number>();
  const marketBy = new Map<string, string | null>();
  for (const r of m
    .prepare(`SELECT ticker, market, market_cap_cr FROM stock_metrics`)
    .all() as Array<{ ticker: string; market: string | null; market_cap_cr: number | null }>) {
    const v = num(r.market_cap_cr);
    if (v != null) mcap.set(r.ticker.toUpperCase(), v);
    marketBy.set(r.ticker.toUpperCase(), r.market);
  }
  const universe = [...mcap.entries()]
    .filter(([, v]) => v >= mcapLo && v <= mcapHi)
    .map(([t]) => t);

  const quarters = new Map<string, Array<Record<string, number | null>>>();
  for (const r of m
    .prepare(`SELECT ticker, quarters_json FROM screener_quarters_cache`)
    .all() as Array<{ ticker: string; quarters_json: string | null }>) {
    try {
      const q = JSON.parse(r.quarters_json || "[]");
      if (Array.isArray(q)) quarters.set(r.ticker.toUpperCase(), q);
    } catch {
      /* skip bad cache row */
    }
  }
  const yearsRoce = new Map<string, number | null>();
  for (const r of openSqliteNamed("brutal.db", { readonly: true, wal: true })
    .prepare(`SELECT ticker, years_roce FROM brutal_scan`)
    .all() as Array<{ ticker: string; years_roce: number | null }>) {
    yearsRoce.set(r.ticker.toUpperCase(), num(r.years_roce));
  }
  const momentum = new Map<string, number | null>();
  for (const r of openSqliteNamed("signals.db", { readonly: true, wal: true })
    .prepare(`SELECT ticker, momentum_pct FROM mom_signals`)
    .all() as Array<{ ticker: string; momentum_pct: number | null }>) {
    momentum.set(r.ticker.toUpperCase(), num(r.momentum_pct));
  }
  const salesYoy = new Map<string, number | null>();
  for (const r of m
    .prepare(`SELECT ticker, sales_yoy FROM quarter_metrics`)
    .all() as Array<{ ticker: string; sales_yoy: number | null }>) {
    salesYoy.set(r.ticker.toUpperCase(), num(r.sales_yoy));
  }

  const roce = new Map<string, number | null>();
  const peBy = new Map<string, number | null>();
  for (const r of g
    .prepare(`SELECT ticker, roce, pe FROM company_metrics`)
    .all() as Array<{ ticker: string; roce: number | null; pe: number | null }>) {
    roce.set(r.ticker.toUpperCase(), num(r.roce));
    peBy.set(r.ticker.toUpperCase(), num(r.pe));
  }
  const conn = new Map<string, { total: number; ext: number }>();
  for (const r of g
    .prepare(
      `SELECT ticker, total_directors AS total, externally_connected_directors AS ext FROM company_connectivity`,
    )
    .all() as Array<{ ticker: string; total: number; ext: number }>) {
    conn.set(r.ticker.toUpperCase(), { total: r.total, ext: r.ext });
  }
  const names = new Map<string, string>();
  for (const r of g.prepare(`SELECT ticker, name FROM companies`).all() as Array<{
    ticker: string;
    name: string | null;
  }>) {
    if (r.name) names.set(r.ticker.toUpperCase(), r.name);
  }

  const cls = new Map<string, { sector: string | null; industry: string | null }>();
  const cdb = openSqliteNamed("classifications.db", { readonly: true, wal: true });
  for (const r of cdb
    .prepare(`SELECT ticker, sector, industry FROM classifications`)
    .all() as Array<{ ticker: string; sector: string | null; industry: string | null }>) {
    cls.set(r.ticker.toUpperCase(), {
      sector: r.sector?.trim() || null,
      industry: r.industry?.trim() || null,
    });
  }

  type Seat = { pid: string; des: string; cat: string };
  const seats = new Map<string, Seat[]>();
  const boardsOf = new Map<string, Set<string>>();
  for (const r of g
    .prepare(`SELECT ticker, person_id, designation, category FROM board_seats`)
    .all() as Array<{ ticker: string; person_id: string; designation: string | null; category: string | null }>) {
    const t = r.ticker.toUpperCase();
    const list = seats.get(t) ?? [];
    list.push({ pid: r.person_id, des: r.designation || "", cat: r.category || "" });
    seats.set(t, list);
    const b = boardsOf.get(r.person_id) ?? new Set<string>();
    b.add(t);
    boardsOf.set(r.person_id, b);
  }

  const isIndependent = (s: Seat) =>
    s.cat === "Independent" ||
    (s.des.includes("Independent") && !s.des.includes("Non Independent"));

  type Feat = Omit<
    LvRow,
    | "rank"
    | "score"
    | "board"
    | "earnings"
    | "value"
    | "rule"
    | "like_list"
  >;
  const feats: Feat[] = universe.map((t) => {
    const s = seats.get(t) ?? [];
    const dirs = new Set(s.map((x) => x.pid));
    const ind = s.filter(isIndependent);
    let indOnSmall = 0;
    for (const x of ind) {
      const others = boardsOf.get(x.pid) ?? new Set<string>();
      for (const o of others) {
        if (o !== t && (mcap.get(o) ?? Infinity) < SMALL_BOARD_CR) {
          indOnSmall += 1;
          break;
        }
      }
    }
    const c = conn.get(t);
    const q = (quarters.get(t) ?? [])
      .filter((x) => num(x.revenue) != null && (x.revenue as number) !== 0)
      .slice(-8);
    let opmCv: number | null = null;
    let opmAvg: number | null = null;
    let opmTrend: number | null = null;
    let negQ: number | null = null;
    let oiShare: number | null = null;
    if (q.length >= LV_MIN_QUARTERS) {
      negQ = q.filter((x) => (num(x.netIncome) ?? 0) < 0).length;
      // Only quarters that report operating profit — Yahoo / Groww fills
      // often omit it; treating that as 0% margin faked "volatile" names.
      const opm = q
        .filter((x) => num(x.ebit) != null)
        .map((x) => (num(x.ebit) as number) / (x.revenue as number));
      if (opm.length >= LV_MIN_QUARTERS) {
        const mu = mean(opm);
        opmAvg = mu;
        opmCv = mu ? pstdev(opm) / Math.abs(mu) : null;
        const half = Math.floor(opm.length / 2);
        opmTrend = mean(opm.slice(half)) - mean(opm.slice(0, half));
      }
      const last4 = q.slice(-4);
      const np4 = last4.reduce((a, x) => a + (num(x.netIncome) ?? 0), 0);
      const ois = last4.map((x) => num(x.otherIncome));
      if (np4 > 0 && ois.every((v) => v != null)) {
        oiShare = (ois as number[]).reduce((a, v) => a + v, 0) / np4;
      }
    }
    return {
      ticker: t,
      name: names.get(t) ?? null,
      market: marketBy.get(t) ?? null,
      sector: cls.get(t)?.sector ?? null,
      industry: cls.get(t)?.industry ?? null,
      mcap_cr: mcap.get(t)!,
      ind_on_small: indOnSmall,
      ext_share: c && c.total ? c.ext / c.total : null,
      n_dirs: dirs.size || null,
      promoter_related: s.filter((x) => x.des.includes("related to Promoter")).length,
      roce: roce.get(t) ?? null,
      opm_cv: opmCv,
      opm_avg: opmAvg,
      opm_trend: opmTrend,
      years_roce: yearsRoce.get(t) ?? null,
      momentum: momentum.get(t) ?? null,
      neg_q: negQ,
      sales_yoy: salesYoy.get(t) ?? null,
      pe: peBy.get(t) ?? null,
      roce_per_pe: (() => {
        const p = peBy.get(t);
        const r = roce.get(t);
        return p != null && p > 0 && r != null ? r / p : null;
      })(),
      has_quarters: q.length >= LV_MIN_QUARTERS,
      indep_share: dirs.size ? new Set(ind.map((x) => x.pid)).size / dirs.size : null,
      oi_share: oiShare,
      in_list: listTickers.has(t),
    };
  });

  const pct = new Map<FeatureKey, (v: number | null) => number>();
  for (const { key } of WEIGHTS) {
    pct.set(
      key,
      percentileFn(
        feats.map((f) => f[key]).filter((v): v is number => v != null && Number.isFinite(v)),
      ),
    );
  }
  const part = (f: Feat, group: Group | null) => {
    let s = 0;
    let tw = 0;
    for (const { key, dir, w, group: gp } of WEIGHTS) {
      if (group && gp !== group) continue;
      const p = pct.get(key)!(f[key] as number | null);
      s += w * (dir > 0 ? p : 1 - p);
      tw += w;
    }
    return Math.round((s / tw) * 1000) / 10;
  };

  // ── "Like my list" similarity ────────────────────────────────────────
  // Percentile profile on board / earnings / value / size features; a name's
  // similarity = mean closeness to its 5 nearest saved-list names.
  const SIM_KEYS = [
    "ind_on_small",
    "ext_share",
    "n_dirs",
    "promoter_related",
    "roce",
    "opm_cv",
    "neg_q",
    "sales_yoy",
    "roce_per_pe",
    "mcap_cr",
    "pe",
    "indep_share",
    "oi_share",
  ] as const;
  type SimKey = (typeof SIM_KEYS)[number];
  const simPct = new Map<SimKey, (v: number | null) => number>();
  for (const k of SIM_KEYS) {
    simPct.set(
      k,
      percentileFn(
        feats
          .map((f) => f[k] as number | null)
          .filter((v): v is number => v != null && Number.isFinite(v)),
      ),
    );
  }
  const vecs = new Map(
    feats.map((f) => [
      f.ticker,
      SIM_KEYS.map((k) => {
        const v = f[k] as number | null;
        return v == null || !Number.isFinite(v) ? null : simPct.get(k)!(v);
      }),
    ]),
  );
  const closeness = (a: (number | null)[], b: (number | null)[]) => {
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] == null || b[i] == null) continue;
      sum += (a[i]! - b[i]!) ** 2;
      cnt += 1;
    }
    return cnt >= 5 ? 1 - Math.sqrt(sum / cnt) : null;
  };
  const SIM_NEAREST = 5;
  const similarity = (t: string, refs: string[]) => {
    const a = vecs.get(t)!;
    const cs = refs
      .filter((r) => r !== t)
      .map((r) => closeness(a, vecs.get(r)!))
      .filter((v): v is number => v != null)
      .sort((x, y) => y - x)
      .slice(0, SIM_NEAREST);
    return cs.length ? cs.reduce((x, y) => x + y, 0) / cs.length : 0;
  };
  const listRefs = feats.filter((f) => f.in_list).map((f) => f.ticker);
  // Ranking weight for similarity. It helped the first rule set (+1 top-100
  // hit) but after the deep-research features it hurt leave-one-out (top-100
  // 7 → 3 at 0.3), so it is shown as "Like list" only, not blended in.
  const SIM_WEIGHT = 0;

  const ruleBy = new Map(feats.map((f) => [f.ticker, part(f, null)]));
  const blend = (refs: string[], pool: Feat[]) => {
    const sims = new Map(
      pool.map((f) => [f.ticker, refs.length ? similarity(f.ticker, refs) : 0]),
    );
    const pr = percentileFn(pool.map((f) => ruleBy.get(f.ticker)!));
    const ps = percentileFn([...sims.values()]);
    return new Map(
      pool.map((f) => [
        f.ticker,
        {
          score:
            (1 - SIM_WEIGHT) * pr(ruleBy.get(f.ticker)!) +
            SIM_WEIGHT * ps(sims.get(f.ticker)!),
          sim: sims.get(f.ticker)!,
        },
      ]),
    );
  };

  const full = blend(listRefs, feats);
  const scored: LvRow[] = feats
    .map((f) => ({
      ...f,
      rank: 0,
      rule: ruleBy.get(f.ticker)!,
      like_list: Math.round(full.get(f.ticker)!.sim * 1000) / 10,
      score: Math.round(full.get(f.ticker)!.score * 1000) / 10,
      board: part(f, "board"),
      earnings: part(f, "earnings"),
      value: part(f, "value"),
    }))
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  scored.forEach((r, i) => (r.rank = i + 1));

  // Honest validation: leave-one-out — hide each list name, rebuild the
  // similarity from the others, rank it against every non-list name.
  const others = feats.filter((f) => !f.in_list);
  const looRanks: number[] = [];
  for (const held of feats.filter((f) => f.in_list)) {
    const refs = listRefs.filter((t) => t !== held.ticker);
    const b = blend(refs, [...others, held]);
    const mine = b.get(held.ticker)!.score;
    looRanks.push(1 + others.filter((o) => b.get(o.ticker)!.score > mine).length);
  }
  const n = scored.length;
  const pos = looRanks;
  const auc = pos.length
    ? Math.round(
        (pos.reduce((a, r) => a + (others.length - (r - 1)), 0) /
          (pos.length * Math.max(1, others.length))) *
          100,
      ) / 100
    : null;
  const top = [50, 100, 200, 300].map((k) => ({
    n: k,
    hits: pos.filter((r) => r <= k).length,
    random: Math.round(((pos.length * k) / Math.max(1, n)) * 10) / 10,
  }));

  return {
    universe: n,
    with_quarters: scored.filter((r) => r.has_quarters).length,
    classified: scored.filter((r) => r.industry).length,
    missing_quarters: scored.filter((r) => !r.has_quarters).map((r) => r.ticker),
    list_key: listKey,
    list_label: listLabel,
    holdings_groups: (() => {
      const hdb = openSqliteNamed("holdings.db", { readonly: true, wal: true });
      const held = (hdb.prepare(`SELECT upper(ticker) AS t FROM holdings`).all() as Array<{
        t: string;
      }>).map((r) => r.t);
      const sec = new Map<string, number>();
      const ind = new Map<string, { count: number; sector: string | null }>();
      for (const t of held) {
        const c = cls.get(t);
        if (c?.sector) sec.set(c.sector, (sec.get(c.sector) ?? 0) + 1);
        if (c?.industry) {
          const cur = ind.get(c.industry) ?? { count: 0, sector: c.sector };
          cur.count += 1;
          ind.set(c.industry, cur);
        }
      }
      return {
        sectors: [...sec.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        industries: [...ind.entries()]
          .map(([name, v]) => ({ name, count: v.count, sector: v.sector }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      };
    })(),
    validation: {
      list_size: listTickers.size,
      in_universe: pos.length,
      auc,
      top,
    },
    rows: scored.slice(0, limit),
    list_rows: scored.filter((r) => r.in_list),
  };
}

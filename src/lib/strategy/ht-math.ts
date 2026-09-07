import type { HtSectorRow, HtStockRow } from "./ht-types";

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Rank within universe: higher growth & ROCE, lower P/B → lower total score (best). */
export function rankIntrinsicValue(rows: HtStockRow[]): HtStockRow[] {
  const work = rows.filter(
    (r) =>
      Number.isFinite(r.sales_growth_3y) &&
      Number.isFinite(r.roce_3y) &&
      Number.isFinite(r.pb) &&
      r.pb > 0,
  );
  if (!work.length) return [];

  const byGrowth = [...work].sort(
    (a, b) => b.sales_growth_3y - a.sales_growth_3y,
  );
  const byRoce = [...work].sort((a, b) => b.roce_3y - a.roce_3y);
  const byPb = [...work].sort((a, b) => a.pb - b.pb);

  const growthRank = new Map<string, number>();
  const roceRank = new Map<string, number>();
  const pbRank = new Map<string, number>();

  // method=min style ties
  for (let i = 0; i < byGrowth.length; i += 1) {
    const t = byGrowth[i]!.ticker;
    if (i > 0 && byGrowth[i]!.sales_growth_3y === byGrowth[i - 1]!.sales_growth_3y) {
      growthRank.set(t, growthRank.get(byGrowth[i - 1]!.ticker)!);
    } else {
      growthRank.set(t, i + 1);
    }
  }
  for (let i = 0; i < byRoce.length; i += 1) {
    const t = byRoce[i]!.ticker;
    if (i > 0 && byRoce[i]!.roce_3y === byRoce[i - 1]!.roce_3y) {
      roceRank.set(t, roceRank.get(byRoce[i - 1]!.ticker)!);
    } else {
      roceRank.set(t, i + 1);
    }
  }
  for (let i = 0; i < byPb.length; i += 1) {
    const t = byPb[i]!.ticker;
    if (i > 0 && byPb[i]!.pb === byPb[i - 1]!.pb) {
      pbRank.set(t, pbRank.get(byPb[i - 1]!.ticker)!);
    } else {
      pbRank.set(t, i + 1);
    }
  }

  const ranked = work.map((r) => {
    const g = growthRank.get(r.ticker) ?? work.length;
    const o = roceRank.get(r.ticker) ?? work.length;
    const p = pbRank.get(r.ticker) ?? work.length;
    return {
      ...r,
      growth_rank: g,
      roce_rank: o,
      pb_rank: p,
      total_score: g + o + p,
    };
  });

  ranked.sort((a, b) => {
    const ts = (a.total_score ?? 0) - (b.total_score ?? 0);
    if (ts !== 0) return ts;
    const g = (a.growth_rank ?? 0) - (b.growth_rank ?? 0);
    if (g !== 0) return g;
    const o = (a.roce_rank ?? 0) - (b.roce_rank ?? 0);
    if (o !== 0) return o;
    return (a.pb_rank ?? 0) - (b.pb_rank ?? 0);
  });

  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Sector tailwind vs market medians on growth, ROCE, P/B.
 * Positive score → tailwind (sector stronger than market).
 */
export function sectorHeadwindTailwind(
  ranked: HtStockRow[],
  opts?: { minCompanies?: number },
): HtSectorRow[] {
  const minCompanies = opts?.minCompanies ?? 2;
  if (!ranked.length) return [];

  const marketG = median(ranked.map((r) => r.sales_growth_3y));
  const marketR = median(ranked.map((r) => r.roce_3y));
  const marketPb = median(ranked.map((r) => r.pb));

  const groups = new Map<string, HtStockRow[]>();
  for (const r of ranked) {
    const sec = (r.sector || "").trim();
    if (!sec) continue;
    const list = groups.get(sec) ?? [];
    list.push(r);
    groups.set(sec, list);
  }

  const rows: HtSectorRow[] = [];
  for (const [sector, grp] of groups) {
    if (grp.length < minCompanies) continue;
    const sg = median(grp.map((r) => r.sales_growth_3y));
    const sr = median(grp.map((r) => r.roce_3y));
    const sp = median(grp.map((r) => r.pb));
    if (sg == null || sr == null || sp == null) continue;

    const growthRatio =
      marketG != null && marketG > 0 ? sg / marketG : 1;
    const roceRatio =
      marketR != null && marketR > 0 ? sr / marketR : 1;
    const pbRatio =
      marketPb != null && marketPb > 0 && sp > 0 ? marketPb / sp : 1;

    const composite = (growthRatio + roceRatio + pbRatio) / 3;
    const score = Math.round((composite - 1) * 10000) / 10000;
    let indicator: HtSectorRow["indicator"] = "NEUTRAL";
    if (score >= 0.05) indicator = "TAILWIND";
    else if (score <= -0.05) indicator = "HEADWIND";

    const avgScore =
      grp.reduce((a, r) => a + (r.total_score ?? 0), 0) / grp.length;

    rows.push({
      sector,
      companies: grp.length,
      score,
      indicator,
      median_growth_3y: Math.round(sg * 100) / 100,
      median_roce_3y: Math.round(sr * 100) / 100,
      median_pb: Math.round(sp * 100) / 100,
      avg_total_score: Math.round(avgScore * 10) / 10,
    });
  }

  rows.sort((a, b) => b.score - a.score);
  return rows;
}

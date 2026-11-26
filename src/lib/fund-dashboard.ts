import { listFundCatalog } from "./fund-watchlists";
import { readPicks } from "./picks-tracker";
import { fundHistoryForList, peopleListKeys, peopleListLabels } from "./screener-people";
import { loadStockMaster } from "./stock-master";

/**
 * Fund dashboard: two followed investors (fund watchlists fed by Screener people pages) side by side,
 * by sector. "Now" = stake in the latest filing (or the one before, filings come in late); moves compare
 * that with the stake two filings back. Only 1%+ stakes are disclosed, so "entered" means crossed 1%.
 */

export type Move = "entered" | "added" | "cut" | "exited" | "held";
export type DashStock = { ticker: string; name: string | null; sector: string; now: number | null; before: number | null; move: Move };
export type DashSector = {
  sector: string;
  held: number;
  entered: number;
  added: number;
  cut: number;
  exited: number;
  /** Building (+) or leaving (−): entries and exits count double. */
  score: number;
  stocks: DashStock[];
};
export type DashInvestor = {
  key: string;
  label: string;
  /** Latest filing quarter and the one moves are measured from ("2026-Q3", "2026-Q1"). */
  latest: string | null;
  since: string | null;
  holdings: number;
  sectors: DashSector[];
  /** Sectors of this investor's picks in the latest picks quarter (Picks tracker source with the same name), if any. */
  picks: { quarter: string; sectors: Array<{ sector: string; n: number; tickers: string[] }> } | null;
};
export type FundDashboard = { investors: DashInvestor[]; options: Array<{ key: string; label: string }> };

const qIdx = (k: string) => Number(k.slice(0, 4)) * 4 + Number(k.slice(6)) - 1;
const qKey = (i: number) => `${Math.floor(i / 4)}-Q${(i % 4) + 1}`;

function investor(key: string, label: string, master: ReturnType<typeof loadStockMaster>): DashInvestor {
  const h = fundHistoryForList(key);
  const latest = h.quarters[h.quarters.length - 1] ?? null;
  const out: DashInvestor = { key, label, latest, since: null, holdings: 0, sectors: [], picks: null };
  if (!latest) return out;
  const L = qIdx(latest);
  out.since = qKey(L - 2);
  // Sum of all the investor's pages, per ticker and quarter.
  const total = (t: string, q: string) => {
    let s = 0;
    let any = false;
    for (const f of Object.values(h.byTicker[t] ?? {}))
      if (f[q] != null) {
        s += f[q]!;
        any = true;
      }
    return any ? Math.round(s * 100) / 100 : null;
  };
  const bySector = new Map<string, DashSector>();
  for (const t of Object.keys(h.byTicker)) {
    const now = total(t, qKey(L)) ?? total(t, qKey(L - 1));
    const before = total(t, qKey(L - 2)) ?? total(t, qKey(L - 3));
    if (now == null && before == null) continue;
    const move: Move =
      before == null ? "entered" : now == null ? "exited" : now > before + 0.05 ? "added" : now < before - 0.05 ? "cut" : "held";
    const m = master.get(t);
    const sector = m?.sector || m?.industry || "Unclassified";
    const s = bySector.get(sector) ?? { sector, held: 0, entered: 0, added: 0, cut: 0, exited: 0, score: 0, stocks: [] };
    if (now != null) s.held++;
    if (move === "entered") s.entered++;
    else if (move === "exited") s.exited++;
    else if (move === "added") s.added++;
    else if (move === "cut") s.cut++;
    s.stocks.push({ ticker: t, name: m?.name ?? null, sector, now, before, move });
    bySector.set(sector, s);
  }
  for (const s of bySector.values()) {
    s.score = 2 * s.entered + s.added - s.cut - 2 * s.exited;
    s.stocks.sort((a, b) => (b.now ?? 0) - (a.now ?? 0));
  }
  out.sectors = [...bySector.values()].sort((a, b) => b.score - a.score || b.held - a.held || a.sector.localeCompare(b.sector));
  out.holdings = out.sectors.reduce((n, s) => n + s.held, 0);

  // The investor's own recommendations, if they are a Picks tracker source (e.g. Niveshaay).
  try {
    const pk = readPicks();
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const alias = new Set([norm(label), norm(key), ...peopleListLabels().filter((p) => p.key === key).map((p) => norm(p.label))]);
    const src = pk.sources.find((x) => alias.has(norm(x)));
    if (src) {
      const mine = pk.picks.filter((p) => p.source === src);
      const q = mine.map((p) => p.quarter).sort().pop();
      if (q) {
        const m = new Map<string, string[]>();
        for (const p of mine.filter((x) => x.quarter === q)) {
          const sec = p.sector || p.industry || "Unclassified";
          m.set(sec, [...(m.get(sec) ?? []), p.ticker]);
        }
        out.picks = {
          quarter: q,
          sectors: [...m].map(([sector, tickers]) => ({ sector, n: tickers.length, tickers })).sort((a, b) => b.n - a.n || a.sector.localeCompare(b.sector)),
        };
      }
    }
  } catch {
    /* no picks */
  }
  return out;
}

export function fundDashboard(keys: string[]): FundDashboard {
  const catalog = listFundCatalog();
  const followed = new Set(peopleListKeys());
  const options = catalog.filter((c) => followed.has(c.key)).map((c) => ({ key: c.key, label: c.label }));
  const master = loadStockMaster();
  const investors = keys
    .map((k) => catalog.find((c) => c.key === k))
    .filter((c): c is (typeof catalog)[number] => !!c)
    .map((c) => investor(c.key, c.label, master));
  return { investors, options };
}

"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { ReviewPlusButton } from "@/components/ReviewPlusButton";
import { StockNetworkSearch } from "@/components/StockNetworkSearch";
import { governancePersonUrl, napkinUrl, tradingviewUrl } from "@/lib/links";
import type {
  MicrocapBoardFilter,
  MicrocapSectorBoard,
  MicrocapSectorReturn,
  MicrocapStockList,
  MicrocapStockRow,
} from "@/lib/microcap-sector-returns";

type Data = (MicrocapSectorBoard & { ok: true }) | { ok: false; error: string };
type StocksData = (MicrocapStockList & { ok: true }) | { ok: false; error: string };

type ViewId = "pockets" | "sectors" | "board";
type RankSide = "top" | "mid" | "bot";
type Sel = { sector: string; industry: string | null; side: RankSide };

const MIN_N_OPTS = [1, 2, 3, 5, 10] as const;
const MAX_MCAP_OPTS = [1000, 2000, 5000, 10000, 25000] as const;
const RANK_N = 20;

const VIEWS: { id: ViewId; label: string; hint: string }[] = [
  { id: "pockets", label: "Pockets", hint: "Top / Mid / Bot industry & sub_sector — click a bar for the stocks" },
  { id: "sectors", label: "Sectors", hint: "Top / Mid / Bot sector averages — click a bar for every name" },
  { id: "board", label: "Board", hint: "Multi-column sector cards with High / Low" },
];

/**
 * Middle cohort: drop Top N and Bot N, then take N rows around the median,
 * ordered weakest → strongest (bottom → up).
 */
function midRankRows<T>(
  all: T[],
  topKeys: Set<string>,
  botKeys: Set<string>,
  keyOf: (row: T) => string,
  retOf: (row: T) => number,
  n = RANK_N,
): T[] {
  const rest = all
    .filter((row) => {
      const k = keyOf(row);
      return !topKeys.has(k) && !botKeys.has(k);
    })
    .sort((a, b) => retOf(a) - retOf(b) || keyOf(a).localeCompare(keyOf(b)));
  if (rest.length <= n) return rest;
  const start = Math.max(0, Math.floor((rest.length - n) / 2));
  return rest.slice(start, start + n);
}

function toPocketRank(p: PocketRow): RankRow {
  return {
    key: `${p.sector}/${p.industry}`,
    label: p.industry,
    sub: p.sector,
    sector: p.sector,
    industry: p.industry,
    n: p.n,
    avg_ret_1y: p.avg_ret_1y,
  };
}

function toSectorRank(s: MicrocapSectorReturn): RankRow {
  return {
    key: s.sector,
    label: s.sector,
    sector: s.sector,
    industry: null,
    n: s.n,
    avg_ret_1y: s.avg_ret_1y,
  };
}

type PocketRow = {
  sector: string;
  industry: string;
  n: number;
  avg_ret_1y: number;
};

type RankRow = {
  key: string;
  label: string;
  sub?: string;
  sector: string;
  industry: string | null;
  n: number;
  avg_ret_1y: number;
};

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(0)}%`;
}

function cr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
}

function DivYieldBubble({ n }: { n: number | null | undefined }) {
  if (n == null || !Number.isFinite(n)) {
    return (
      <span className="mcs-pill mcs-pill--div empty" title="Dividend yield not on file">
        <b>-</b>
        <em>dy</em>
      </span>
    );
  }
  const label = Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
  return (
    <span className="mcs-pill mcs-pill--div" title={`Dividend yield ${n.toFixed(1)}%`}>
      <b>{label}%</b>
      <em>dy</em>
    </span>
  );
}

function BoardLinksBubble({
  n,
  open,
  onClick,
}: {
  n: number;
  open: boolean;
  onClick: () => void;
}) {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return (
    <button
      type="button"
      className={`mcs-pill mcs-pill--board${open ? " on" : ""}${count ? "" : " empty"}`}
      aria-expanded={open}
      title={
        count
          ? `${count} connected board${count === 1 ? "" : "s"} — click for directors & outside nodes`
          : "No connected boards on file — click for directors if any"
      }
      onClick={onClick}
    >
      {count ? (
        <>
          <b>{count}</b>
          <em>{count === 1 ? "link" : "links"}</em>
        </>
      ) : (
        <>
          <b>-</b>
          <em>bd</em>
        </>
      )}
    </button>
  );
}

function Ret({ n, light }: { n: number; light?: boolean }) {
  const cls = light ? "mcs-ret mcs-ret--light" : n > 0 ? "mcs-ret up" : n < 0 ? "mcs-ret down" : "mcs-ret";
  return <span className={cls}>{pct(n)}</span>;
}

function selKey(s: Sel | null): string {
  if (!s) return "";
  return `${s.side}::${s.sector}::${s.industry ?? ""}`;
}

function sameSel(a: Sel | null, b: Sel | null): boolean {
  return selKey(a) === selKey(b);
}

/** Value-style bar list (Top = under/teal, Mid = slate, Bottom = over/warm). */
function Bars({
  title,
  side,
  rows,
  sel,
  onPick,
  scaleMax,
}: {
  title: string;
  side: RankSide;
  rows: RankRow[];
  sel: Sel | null;
  onPick: (next: Sel) => void;
  /** Absolute return used to scale the fill (same scale both columns). */
  scaleMax: number;
}) {
  const tone = side === "top" ? "under" : side === "bot" ? "over" : "mid";
  return (
    <div className={`vx-card vx-bars vx-bars--${tone}`}>
      <span className="vx-label vx-label--title">{title}</span>
      {!rows.length ? <p className="vx-empty">No rows.</p> : null}
      {rows.map((r) => {
        const next: Sel = { sector: r.sector, industry: r.industry, side };
        const on = sameSel(sel, next);
        const width = scaleMax > 0 ? Math.min(100, (Math.abs(r.avg_ret_1y) / scaleMax) * 100) : 0;
        return (
          <button
            key={r.key}
            type="button"
            className={`vx-bar-row${on ? " on" : ""}`}
            onClick={() => onPick(next)}
            title={`${r.n} companies · click for the list`}
          >
            <span className="vx-bar-name" title={r.sub ? `${r.label} · ${r.sub}` : r.label}>
              {r.label}
              {r.sub ? <em className="mcs-bar-sub">{r.sub}</em> : null}
            </span>
            <span className="vx-bar-track" aria-hidden>
              <span className="vx-bar-fill" style={{ width: `${Math.max(width ? 4 : 0, width)}%` }} />
            </span>
            <span className={`vx-bar-pct${r.avg_ret_1y < 0 ? " neg" : ""}`}>{pct(r.avg_ret_1y)}</span>
            <span className="vx-bar-k">{r.n}</span>
          </button>
        );
      })}
    </div>
  );
}

function SectorColumn({
  s,
  sel,
  onPick,
}: {
  s: MicrocapSectorReturn;
  sel: Sel | null;
  onPick: (next: Sel) => void;
}) {
  const showBand = !!(s.low && s.high);
  const showIndustries = s.industries.length > 1;
  const sectorOn = sameSel(sel, { sector: s.sector, industry: null, side: "top" });

  return (
    <article className={`mcs-col${sectorOn ? " mcs-col--on" : ""}`}>
      <header className="mcs-col-head">
        <button
          type="button"
          className="mcs-col-title mcs-pick"
          title="Show all stocks in this sector"
          onClick={() => onPick({ sector: s.sector, industry: null, side: "top" })}
        >
          <h3>{s.sector}</h3>
          <span>{s.n.toLocaleString("en-IN")} cos</span>
        </button>
        <b>
          <Ret n={s.avg_ret_1y} light />
        </b>
      </header>

      {showBand ? (
        <div className="mcs-col-band">
          <button
            type="button"
            className={`mcs-band-btn high${sameSel(sel, { sector: s.sector, industry: s.high!.industry, side: "top" }) ? " on" : ""}`}
            title={`${s.high!.n} stocks · click for list`}
            onClick={() => onPick({ sector: s.sector, industry: s.high!.industry, side: "top" })}
          >
            <em>High</em>
            <span className="mcs-ind">{s.high!.industry}</span>
            <Ret n={s.high!.avg_ret_1y} />
          </button>
          <button
            type="button"
            className={`mcs-band-btn low${sameSel(sel, { sector: s.sector, industry: s.low!.industry, side: "bot" }) ? " on" : ""}`}
            title={`${s.low!.n} stocks · click for list`}
            onClick={() => onPick({ sector: s.sector, industry: s.low!.industry, side: "bot" })}
          >
            <em>Low</em>
            <span className="mcs-ind">{s.low!.industry}</span>
            <Ret n={s.low!.avg_ret_1y} />
          </button>
        </div>
      ) : null}

      {showIndustries ? (
        <ul className="mcs-col-list">
          {s.industries.map((i) => {
            const on = sameSel(sel, { sector: s.sector, industry: i.industry, side: "top" });
            return (
              <li key={i.industry}>
                <button
                  type="button"
                  className={`mcs-ind-btn${on ? " on" : ""}`}
                  title={`${i.n} stocks · click for list`}
                  onClick={() => onPick({ sector: s.sector, industry: i.industry, side: "top" })}
                >
                  <span className="mcs-ind">
                    {i.industry}
                    <small className="mcs-n">{i.n}</small>
                  </span>
                  <Ret n={i.avg_ret_1y} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

function StocksBelow({
  sel,
  board,
  minN,
  maxMcap,
  onClose,
}: {
  sel: Sel;
  board: MicrocapBoardFilter;
  minN: number;
  maxMcap: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<StocksData | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [boardOpen, setBoardOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setBoardOpen(null);
    const sp = new URLSearchParams({
      view: "stocks",
      sector: sel.sector,
      board,
      minN: String(minN),
      maxMcap: String(maxMcap),
    });
    if (sel.industry != null) sp.set("industry", sel.industry);
    void fetch(`/api/microcap?${sp}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: StocksData) => {
        if (live) setData(j);
      })
      .catch((e) => {
        if (live) setData({ ok: false, error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [sel.sector, sel.industry, board, minN, maxMcap, reloadToken]);

  // Parent board-wide div fill bumps this so open pocket lists refresh.
  useEffect(() => {
    const onFilled = () => setReloadToken((n) => n + 1);
    window.addEventListener("mcs-div-filled", onFilled);
    return () => window.removeEventListener("mcs-div-filled", onFilled);
  }, []);

  const title =
    sel.industry == null
      ? sel.sector
      : sel.industry === "Other"
        ? `${sel.sector} · Other`
        : `${sel.industry} · ${sel.sector}`;

  return (
    <div className="vx-card vx-table-card mcs-stocks" id="mcs-stocks">
      <div className="vx-table-head">
        <span className="vx-label vx-label--title">
          {title}
          {data?.ok ? (
            <span className="vx-hint">
              {" "}
              · {data.stocks.length.toLocaleString("en-IN")} companies · sorted by 12M return
            </span>
          ) : null}
        </span>
        <button type="button" className="link-btn" onClick={onClose}>
          Close
        </button>
      </div>
      {!data ? (
        <p className="vx-empty">Loading stocks…</p>
      ) : !data.ok ? (
        <p className="vx-empty vx-msg--err">Could not load: {data.error}</p>
      ) : !data.stocks.length ? (
        <p className="vx-empty">No companies with 1Y prices in this pocket.</p>
      ) : (
        <div className="vx-scroll">
          <table className="vx-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Industry / sub_sector</th>
                <th className="num">Market cap</th>
                <th className="num">Div yield</th>
                <th className="num" title="Connected boards sharing a director">
                  Board
                </th>
                <th className="num">12M return</th>
              </tr>
            </thead>
            <tbody>
              {data.stocks.map((s: MicrocapStockRow) => {
                const open = boardOpen === s.ticker;
                return (
                  <Fragment key={s.ticker}>
                    <tr className={open ? "mcs-board-row-on" : undefined}>
                      <td>
                        <a className="vx-co" href={tradingviewUrl(s.ticker, s.market)} target="_blank" rel="noopener noreferrer">
                          {s.name}
                        </a>
                        <span className="vx-sub">
                          {s.ticker}
                          {s.market && s.market !== "NSE" ? <em>{s.market}</em> : null}
                          <ReviewPlusButton ticker={s.ticker} />
                          <a className="np-chip" href={napkinUrl(s.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                            NP
                          </a>
                        </span>
                      </td>
                      <td className="mcs-rank-sec">{s.industry}</td>
                      <td className="num">{cr(s.mcap_cr)}</td>
                      <td className="num mcs-div-cell">
                        <DivYieldBubble n={s.div_yield_pct} />
                      </td>
                      <td className="num mcs-div-cell">
                        <BoardLinksBubble
                          n={s.board_links ?? 0}
                          open={open}
                          onClick={() => setBoardOpen((cur) => (cur === s.ticker ? null : s.ticker))}
                        />
                      </td>
                      <td className="num">
                        <Ret n={s.ret_1y} />
                      </td>
                    </tr>
                    {open ? (
                      <tr className="mcs-board-detail-row">
                        <td colSpan={6}>
                          <div className="mcs-board-detail" id={`mcs-board-${s.ticker}`}>
                            <StockNetworkSearch
                              hideSearch
                              initialTicker={s.ticker}
                              onPerson={(id) => window.open(governancePersonUrl(id), "_blank", "noopener,noreferrer")}
                            />
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Micro Monopolies — Value-style Top/Bottom bars; pick the average name in the best pocket. */
export function MicrocapSectorsPanel() {
  const [board, setBoard] = useState<MicrocapBoardFilter>("all");
  const [minN, setMinN] = useState(2);
  const [maxMcap, setMaxMcap] = useState<(typeof MAX_MCAP_OPTS)[number]>(1000);
  const [view, setView] = useState<ViewId>("pockets");
  /** Pockets / sectors: show Top 20 or Bot 20 alone (full width). */
  const [rankSide, setRankSide] = useState<RankSide>("top");
  const [data, setData] = useState<Data | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Sel | null>(null);
  const [limit, setLimit] = useState(7);
  const [missingDivN, setMissingDivN] = useState<number | null>(null);
  const [fillingDiv, setFillingDiv] = useState(false);
  const [fillDivMsg, setFillDivMsg] = useState<string | null>(null);
  /** Hide board fill after a full run finishes (even if Tickertape left some blank). */
  const [divFillDone, setDivFillDone] = useState(false);

  const refreshMissingDiv = () => {
    void fetch(`/api/microcap?view=missing-div&board=${board}&maxMcap=${maxMcap}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok?: boolean; missing?: unknown[] }) => {
        if (j?.ok && Array.isArray(j.missing)) setMissingDivN(j.missing.length);
      })
      .catch(() => {
        /* ignore */
      });
  };

  useEffect(() => {
    let live = true;
    setData(null);
    setSel(null);
    setDivFillDone(false);
    setFillDivMsg(null);
    void fetch(`/api/microcap?view=sectors&board=${board}&minN=${minN}&maxMcap=${maxMcap}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Data) => {
        if (live) setData(j);
      })
      .catch((e) => {
        if (live) setData({ ok: false, error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [board, minN, maxMcap]);

  useEffect(() => {
    setDivFillDone(false);
    setFillDivMsg(null);
    refreshMissingDiv();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when universe filters change
  }, [board, maxMcap]);

  useEffect(() => {
    setLimit(7);
    setSel(null);
  }, [board, minN, maxMcap, view]);

  const fillAllMissingDiv = async () => {
    if (fillingDiv) return;
    setFillingDiv(true);
    setFillDivMsg("Finding names missing div yield…");
    let filled = 0;
    let tried = 0;
    let failed = 0;
    let still = 0;
    /** Small batches — large Tickertape pulls often trip browser "Failed to fetch". */
    const BATCH = 12;
    const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

    type FillJson = {
      ok?: boolean;
      error?: string;
      tried?: number;
      filled?: number;
      failed?: number;
      still_missing?: number;
    };

    const postTickers = async (
      tickers: Array<{ ticker: string; name: string }>,
    ): Promise<FillJson> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const res = await fetch("/api/microcap", {
            method: "POST",
            headers: { "content-type": "application/json" },
            // Explicit tickers → server skips expensive re-scan of the whole board.
            body: JSON.stringify({ action: "fill-div", board, maxMcap, tickers }),
          });
          const j = (await res.json()) as FillJson;
          if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
          return j;
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          const transient =
            msg === "Failed to fetch" ||
            msg.includes("NetworkError") ||
            /fetch/i.test(msg);
          if (!transient || attempt === 3) break;
          setFillDivMsg(`Network hiccup — retrying batch (${attempt + 1}/3)…`);
          await sleep(800 * (attempt + 1));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    };

    try {
      const listRes = await fetch(
        `/api/microcap?view=missing-div&board=${board}&maxMcap=${maxMcap}`,
        { cache: "no-store" },
      );
      const listJ = (await listRes.json()) as {
        ok?: boolean;
        error?: string;
        missing?: Array<{ ticker: string; name: string }>;
      };
      if (!listRes.ok || listJ.ok === false) throw new Error(listJ.error || `HTTP ${listRes.status}`);
      const queue = Array.isArray(listJ.missing) ? listJ.missing : [];
      setMissingDivN(queue.length);
      if (!queue.length) {
        setFillDivMsg("Nothing missing");
        setDivFillDone(true);
        return;
      }

      for (let i = 0; i < queue.length; i += BATCH) {
        const chunk = queue.slice(i, i + BATCH);
        const left = queue.length - i;
        setFillDivMsg(
          `Pulling div yields… ${tried ? `${tried} tried · ${filled} filled` : "starting"}` +
            ` · ${left.toLocaleString("en-IN")} left`,
        );
        const j = await postTickers(chunk);
        tried += j.tried ?? 0;
        filled += j.filled ?? 0;
        failed += j.failed ?? 0;
        still += j.still_missing ?? 0;
        setMissingDivN(Math.max(0, queue.length - (i + chunk.length)));
        await sleep(100);
      }

      setMissingDivN(0);
      setFillDivMsg(
        `Done · filled ${filled} of ${tried}` +
          (still ? ` · ${still} have no yield on Tickertape` : "") +
          (failed ? ` · ${failed} failed` : ""),
      );
      setDivFillDone(true);
      window.dispatchEvent(new Event("mcs-div-filled"));
      refreshMissingDiv();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFillDivMsg(
        msg === "Failed to fetch"
          ? `Paused after network drop · ${tried} done — click Fill to continue`
          : msg,
      );
      refreshMissingDiv();
    } finally {
      setFillingDiv(false);
    }
  };

  const pick = (next: Sel) => {
    setSel((cur) => (sameSel(cur, next) ? null : next));
  };

  useEffect(() => {
    // Board view still stacks stocks under the columns; scroll them into view.
    if (!sel || view === "pockets" || view === "sectors") return;
    const t = window.setTimeout(() => {
      document.getElementById("mcs-stocks")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
    return () => window.clearTimeout(t);
  }, [sel, view]);

  const sectors = useMemo(() => {
    if (!data?.ok) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.sectors;
    return data.sectors.filter(
      (s) =>
        s.sector.toLowerCase().includes(needle) ||
        s.industries.some((i) => i.industry.toLowerCase().includes(needle)),
    );
  }, [data, q]);

  const pockets = useMemo(() => {
    const rows: PocketRow[] = [];
    for (const s of sectors) {
      for (const i of s.industries) {
        if (i.industry === "Other") continue;
        rows.push({ sector: s.sector, industry: i.industry, n: i.n, avg_ret_1y: i.avg_ret_1y });
      }
    }
    return rows;
  }, [sectors]);

  const pocketTop = useMemo(
    () =>
      [...pockets]
        .sort((a, b) => b.avg_ret_1y - a.avg_ret_1y || a.industry.localeCompare(b.industry))
        .slice(0, RANK_N)
        .map(toPocketRank),
    [pockets],
  );

  const pocketBot = useMemo(
    () =>
      [...pockets]
        .sort((a, b) => a.avg_ret_1y - b.avg_ret_1y || a.industry.localeCompare(b.industry))
        .slice(0, RANK_N)
        .map(toPocketRank),
    [pockets],
  );

  const pocketMid = useMemo(() => {
    const topKeys = new Set(pocketTop.map((r) => r.key));
    const botKeys = new Set(pocketBot.map((r) => r.key));
    return midRankRows(
      pockets,
      topKeys,
      botKeys,
      (p) => `${p.sector}/${p.industry}`,
      (p) => p.avg_ret_1y,
    ).map(toPocketRank);
  }, [pockets, pocketTop, pocketBot]);

  const sectorTop = useMemo(
    () =>
      [...sectors]
        .sort((a, b) => b.avg_ret_1y - a.avg_ret_1y || a.sector.localeCompare(b.sector))
        .slice(0, RANK_N)
        .map(toSectorRank),
    [sectors],
  );

  const sectorBot = useMemo(
    () =>
      [...sectors]
        .sort((a, b) => a.avg_ret_1y - b.avg_ret_1y || a.sector.localeCompare(b.sector))
        .slice(0, RANK_N)
        .map(toSectorRank),
    [sectors],
  );

  const sectorMid = useMemo(() => {
    const topKeys = new Set(sectorTop.map((r) => r.key));
    const botKeys = new Set(sectorBot.map((r) => r.key));
    return midRankRows(
      sectors,
      topKeys,
      botKeys,
      (s) => s.sector,
      (s) => s.avg_ret_1y,
    ).map(toSectorRank);
  }, [sectors, sectorTop, sectorBot]);

  const pocketRows = rankSide === "top" ? pocketTop : rankSide === "mid" ? pocketMid : pocketBot;
  const sectorRows = rankSide === "top" ? sectorTop : rankSide === "mid" ? sectorMid : sectorBot;
  const pocketScale = useMemo(() => {
    const xs = pocketRows.map((r) => Math.abs(r.avg_ret_1y));
    return Math.max(1, ...(xs.length ? xs : [1]));
  }, [pocketRows]);
  const sectorScale = useMemo(() => {
    const xs = sectorRows.map((r) => Math.abs(r.avg_ret_1y));
    return Math.max(1, ...(xs.length ? xs : [1]));
  }, [sectorRows]);

  const viewMeta = VIEWS.find((v) => v.id === view)!;
  const shownBoard = sectors.slice(0, limit);

  return (
    <section className="vx mcs">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">
            Find the best sector / industry / sub_sector · equal-weight avg 12M return · default ≤ ₹1,000 Cr
          </span>
          <h2 className="vx-title">
            Micro <span>Monopolies</span>
          </h2>
          <p className="vx-hint mcs-lede">
            Top 20 · Mid 20 (bottom → up, between the extremes) · Bot 20 — full width; click a bar and companies open
            beside it. Pick the <em>average</em> name in the strongest pocket.
          </p>
        </div>
      </header>

      <div className="mcs-tabs" role="tablist" aria-label="Micro Monopolies views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            className={view === v.id ? "on" : ""}
            title={v.hint}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="vx-card mcs-toolbar">
        {view === "pockets" || view === "sectors" ? (
          <label className="vx-field">
            <span className="vx-label">Rank</span>
            <div className="mcs-seg" role="group" aria-label="Top, mid, or bottom 20">
              {(
                [
                  ["top", "Top 20"],
                  ["mid", "Mid 20"],
                  ["bot", "Bot 20"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={rankSide === id ? "on" : ""}
                  aria-pressed={rankSide === id}
                  onClick={() => {
                    setRankSide(id);
                    setSel(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </label>
        ) : null}
        <label className="vx-field">
          <span className="vx-label">Board</span>
          <div className="mcs-seg" role="group" aria-label="Exchange board">
            {(
              [
                ["all", "All"],
                ["main", "Main board"],
                ["sme", "SME"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" className={board === id ? "on" : ""} aria-pressed={board === id} onClick={() => setBoard(id)}>
                {label}
              </button>
            ))}
          </div>
        </label>
        <label className="vx-field vx-field--inline">
          <span className="vx-label">Max mcap</span>
          <select
            value={maxMcap}
            onChange={(e) => setMaxMcap(Number(e.target.value) as (typeof MAX_MCAP_OPTS)[number])}
            aria-label="Maximum market cap in crore"
          >
            {MAX_MCAP_OPTS.map((n) => (
              <option key={n} value={n}>
                ≤ ₹{n.toLocaleString("en-IN")} Cr
              </option>
            ))}
          </select>
        </label>
        <label className="vx-field vx-field--inline" title="Pocket needs this many names before it ranks">
          <span className="vx-label">Min companies</span>
          <select value={minN} onChange={(e) => setMinN(Number(e.target.value))} aria-label="Minimum companies">
            {MIN_N_OPTS.map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </label>
        <label className="vx-field mcs-search">
          <span className="vx-label">Filter</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Defence, Chemicals…" />
        </label>
        {missingDivN != null && missingDivN > 0 && !divFillDone ? (
          <button
            type="button"
            className="vx-btn"
            disabled={fillingDiv}
            onClick={() => void fillAllMissingDiv()}
            title="Pull Tickertape dividend yield for every name on this board still missing it"
          >
            {fillingDiv ? "Filling div yields…" : `Fill ${missingDivN.toLocaleString("en-IN")} missing div yields`}
          </button>
        ) : null}
        <span className="vx-hint mcs-meta">
          {viewMeta.hint}
          {data?.ok
            ? ` · ≤ ₹${data.max_mcap_cr.toLocaleString("en-IN")} Cr · ${data.stocks_with_return.toLocaleString("en-IN")} names`
            : ""}
          {fillDivMsg ? ` · ${fillDivMsg}` : ""}
        </span>
      </div>

      {!data ? (
        <div className="vx-card vx-empty">Computing 12-month returns…</div>
      ) : !data.ok ? (
        <div className="vx-card vx-empty vx-msg--err">Could not load: {data.error}</div>
      ) : !sectors.length ? (
        <div className="vx-card vx-empty">No sectors match.</div>
      ) : view === "pockets" || view === "sectors" ? (
        <>
          <div className={`mcs-rank-row${sel ? " mcs-rank-row--split" : ""}`}>
            <div className="mcs-rank-bars">
              <Bars
                title={
                  view === "pockets"
                    ? rankSide === "top"
                      ? "Top 20 pockets by avg 12M return"
                      : rankSide === "mid"
                        ? "Mid 20 pockets · bottom → up (between Top & Bot)"
                        : "Bottom 20 pockets by avg 12M return"
                    : rankSide === "top"
                      ? "Top 20 sectors by avg 12M return"
                      : rankSide === "mid"
                        ? "Mid 20 sectors · bottom → up (between Top & Bot)"
                        : "Bottom 20 sectors by avg 12M return"
                }
                side={rankSide}
                rows={view === "pockets" ? pocketRows : sectorRows}
                sel={sel}
                onPick={pick}
                scaleMax={view === "pockets" ? pocketScale : sectorScale}
              />
            </div>
            {sel ? (
              <div className="mcs-rank-stocks">
                <StocksBelow sel={sel} board={board} minN={minN} maxMcap={maxMcap} onClose={() => setSel(null)} />
              </div>
            ) : null}
          </div>
          {view === "pockets" && !pocketRows.length ? (
            <div className="vx-card vx-empty">No pockets clear Min companies.</div>
          ) : null}
        </>
      ) : (
        <>
          <div className="mcs-board" role="list" aria-label="Sector return columns">
            {shownBoard.map((s) => (
              <div key={s.sector} role="listitem">
                <SectorColumn s={s} sel={sel} onPick={pick} />
              </div>
            ))}
          </div>
          {sectors.length > limit ? (
            <button type="button" className="vx-btn mcs-more" onClick={() => setLimit(sectors.length)}>
              Show all {sectors.length} sectors
            </button>
          ) : limit > 7 && sectors.length > 7 ? (
            <button type="button" className="link-btn mcs-more" onClick={() => setLimit(7)}>
              Show top 7
            </button>
          ) : null}
          {sel ? (
            <StocksBelow sel={sel} board={board} minN={minN} maxMcap={maxMcap} onClose={() => setSel(null)} />
          ) : null}
        </>
      )}
    </section>
  );
}

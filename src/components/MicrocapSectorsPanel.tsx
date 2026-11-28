"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReviewPlusButton } from "@/components/ReviewPlusButton";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import type {
  MicrocapBoardFilter,
  MicrocapSectorBoard,
  MicrocapSectorReturn,
  MicrocapStockList,
  MicrocapStockRow,
} from "@/lib/microcap-sector-returns";

type Data = (MicrocapSectorBoard & { ok: true }) | { ok: false; error: string };
type StocksData = (MicrocapStockList & { ok: true }) | { ok: false; error: string };

type RankSide = "top" | "bot";
type Sel = { sector: string; industry: string | null; side: RankSide };

const MIN_N_OPTS = [1, 2, 3, 5, 10] as const;
/** Default max market cap ₹1,000 Cr. */
const DEFAULT_MAX_CAP = "1000";

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(0)}%`;
}

function cr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
}

function parseCap(raw: string, fallback: number): number {
  const t = raw.trim();
  // Number("") === 0 in JS — treat blank as "use default", not ₹0 Cr.
  if (!t) return fallback;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
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

/** Best named industry inside a sector — never the residual Other bucket. */
function pickHigh(
  s: MicrocapSectorReturn,
): MicrocapSectorReturn["high"] {
  if (s.high && s.high.industry !== "Other") return s.high;
  const named = s.industries.filter((x) => x.industry && x.industry !== "Other");
  if (!named.length) return null;
  return (
    [...named].sort(
      (a, b) =>
        b.avg_ret_1y - a.avg_ret_1y || a.industry.localeCompare(b.industry),
    )[0] ?? null
  );
}

function SectorRail({
  s,
  sel,
  onPick,
  boardMax,
}: {
  s: MicrocapSectorReturn;
  sel: Sel | null;
  onPick: (next: Sel) => void;
  boardMax: number;
}) {
  const high = s.high && s.high.industry !== "Other" ? s.high : null;
  const low =
    s.low &&
    s.low.industry !== "Other" &&
    high &&
    (s.low.industry !== high.industry || s.low.avg_ret_1y !== high.avg_ret_1y)
      ? s.low
      : null;
  const showHigh = !!high;
  const showLow = !!low;
  const sectorOn = sameSel(sel, { sector: s.sector, industry: null, side: "top" });
  const barPct = Math.max(
    4,
    Math.min(100, (Math.max(0, s.avg_ret_1y) / Math.max(boardMax, 1)) * 100),
  );

  return (
    <article className={`mcs-rail${sectorOn ? " on" : ""}`}>
      <div className="mcs-rail-lead">
        <button
          type="button"
          className="mcs-rail-sector mcs-pick"
          title="Show all stocks in this sector"
          onClick={() => onPick({ sector: s.sector, industry: null, side: "top" })}
        >
          <h3>{s.sector}</h3>
          <span>{s.n.toLocaleString("en-IN")} names</span>
        </button>
        <div className="mcs-rail-metric">
          <b className={s.avg_ret_1y >= 0 ? "up" : "down"}>{pct(s.avg_ret_1y)}</b>
          <span className="mcs-rail-track" aria-hidden>
            <i style={{ width: `${barPct}%` }} />
          </span>
        </div>
      </div>

      {(showHigh || showLow) && (
        <div className="mcs-rail-poles">
          {showHigh && high ? (
            <button
              type="button"
              className={`mcs-pole high${sameSel(sel, { sector: s.sector, industry: high.industry, side: "top" }) ? " on" : ""}`}
              title={`${high.n} stocks · click for list`}
              onClick={() => onPick({ sector: s.sector, industry: high.industry, side: "top" })}
            >
              <em>High</em>
              <strong>{high.industry}</strong>
              <Ret n={high.avg_ret_1y} />
            </button>
          ) : null}
          {showLow && low ? (
            <button
              type="button"
              className={`mcs-pole low${sameSel(sel, { sector: s.sector, industry: low.industry, side: "bot" }) ? " on" : ""}`}
              title={`${low.n} stocks · click for list`}
              onClick={() => onPick({ sector: s.sector, industry: low.industry, side: "bot" })}
            >
              <em>Low</em>
              <strong>{low.industry}</strong>
              <Ret n={low.avg_ret_1y} />
            </button>
          ) : null}
        </div>
      )}

      {s.industries.length ? (
        <div className="mcs-rail-leaves" role="list">
          {s.industries.map((i) => {
            const on = sameSel(sel, { sector: s.sector, industry: i.industry, side: "top" });
            return (
              <button
                key={i.industry}
                type="button"
                role="listitem"
                className={`mcs-leaf${on ? " on" : ""}`}
                title={`${i.n} stocks · click for list`}
                onClick={() => onPick({ sector: s.sector, industry: i.industry, side: "top" })}
              >
                <span className="mcs-leaf-name">{i.industry}</span>
                <span className="mcs-leaf-meta">
                  <Ret n={i.avg_ret_1y} />
                  <small>{i.n}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

function StocksBelow({
  sel,
  board,
  minN,
  minMcap,
  maxMcap,
  onClose,
}: {
  sel: Sel;
  board: MicrocapBoardFilter;
  minN: number;
  minMcap: number;
  maxMcap: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<StocksData | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    setData(null);
    const sp = new URLSearchParams({
      view: "stocks",
      sector: sel.sector,
      board,
      minN: String(minN),
      minMcap: String(minMcap),
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
  }, [sel.sector, sel.industry, board, minN, minMcap, maxMcap, reloadToken]);

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
            <span className="vx-hint"> · {data.stocks.length.toLocaleString("en-IN")} companies</span>
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
        <p className="vx-empty">No companies with 1Y prices in this sector / industry.</p>
      ) : (
        <div className="vx-scroll">
          <table className="vx-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Sector</th>
                <th>Industry</th>
                <th className="num">Market cap</th>
                <th className="num">12M return</th>
              </tr>
            </thead>
            <tbody>
              {data.stocks.map((s: MicrocapStockRow) => (
                <tr key={s.ticker}>
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
                  <td className="mcs-rank-sec">{s.sector}</td>
                  <td className="mcs-rank-sec">{s.industry}</td>
                  <td className="num">{cr(s.mcap_cr)}</td>
                  <td className="num">
                    <Ret n={s.ret_1y} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Micro Monopolies — Screener.in sectors with High / Low leaf by equal-weight 12M. */
export function MicrocapSectorsPanel() {
  const [board, setBoard] = useState<MicrocapBoardFilter>("all");
  const [minN, setMinN] = useState(2);
  const [minCap, setMinCap] = useState("");
  const [maxCap, setMaxCap] = useState(DEFAULT_MAX_CAP);
  /** Band actually sent to the API — committed on blur / Enter / idle debounce. */
  const [minMcapClamped, setMinMcapClamped] = useState(0);
  const [maxMcap, setMaxMcap] = useState(1000);
  const [data, setData] = useState<Data | null>(null);
  const [boardLoading, setBoardLoading] = useState(true);
  const [sel, setSel] = useState<Sel | null>(null);
  const [limit, setLimit] = useState(7);
  /** Board = full columns · Top = positive sectors with their High industries only. */
  const [panelTab, setPanelTab] = useState<"board" | "top">("board");
  const [missingDivN, setMissingDivN] = useState<number | null>(null);
  const [fillingDiv, setFillingDiv] = useState(false);
  const [fillDivMsg, setFillDivMsg] = useState<string | null>(null);
  const [divFillDone, setDivFillDone] = useState(false);

  const commitCaps = useCallback(() => {
    const max = Math.max(1, parseCap(maxCap, 1000));
    const min = Math.min(parseCap(minCap, 0), max);
    setMaxMcap((prev) => (prev === max ? prev : max));
    setMinMcapClamped((prev) => (prev === min ? prev : min));
  }, [minCap, maxCap]);

  // Idle commit after typing stops (paste / tab-away without blur on some browsers).
  useEffect(() => {
    const id = window.setTimeout(commitCaps, 700);
    return () => window.clearTimeout(id);
  }, [commitCaps]);

  const refreshMissingDiv = useCallback(() => {
    void fetch(
      `/api/microcap?view=missing-div&board=${board}&minMcap=${minMcapClamped}&maxMcap=${maxMcap}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j: { ok?: boolean; missing?: unknown[] }) => {
        if (j?.ok && Array.isArray(j.missing)) setMissingDivN(j.missing.length);
      })
      .catch(() => {
        /* ignore */
      });
  }, [board, minMcapClamped, maxMcap]);

  useEffect(() => {
    let live = true;
    setBoardLoading(true);
    // Keep the previous board painted until the new band lands (no blank flash).
    // Do not clear sel / collapse "Show all" here — remapped after data lands.
    void fetch(
      `/api/microcap?view=sectors&board=${board}&minN=${minN}&minMcap=${minMcapClamped}&maxMcap=${maxMcap}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j: Data) => {
        if (!live) return;
        setData(j);
        setBoardLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setData({ ok: false, error: String(e) });
        setBoardLoading(false);
      });
    return () => {
      live = false;
    };
  }, [board, minN, minMcapClamped, maxMcap]);

  useEffect(() => {
    setDivFillDone(false);
    setFillDivMsg(null);
    refreshMissingDiv();
  }, [refreshMissingDiv]);

  useEffect(() => {
    setSel(null);
  }, [panelTab]);

  /** Drop / remap open pocket when minN · band · board folds it away. */
  useEffect(() => {
    if (!data?.ok) return;
    setSel((cur) => {
      if (!cur) return cur;
      const sec = data.sectors.find((s) => s.sector === cur.sector);
      if (!sec) return null;
      if (cur.industry == null) return cur;
      if (sec.industries.some((i) => i.industry === cur.industry)) return cur;
      // Named leaf folded into residual Other — follow the names there.
      if (cur.industry !== "Other" && sec.industries.some((i) => i.industry === "Other")) {
        return { ...cur, industry: "Other" };
      }
      return null;
    });
  }, [data]);

  const fillAllMissingDiv = async () => {
    if (fillingDiv) return;
    setFillingDiv(true);
    setFillDivMsg("Finding names missing div yield…");
    let filled = 0;
    let tried = 0;
    let failed = 0;
    let still = 0;
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
            body: JSON.stringify({
              action: "fill-div",
              board,
              minMcap: minMcapClamped,
              maxMcap,
              tickers,
            }),
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
        `/api/microcap?view=missing-div&board=${board}&minMcap=${minMcapClamped}&maxMcap=${maxMcap}`,
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
    if (!sel) return;
    const t = window.setTimeout(() => {
      document.getElementById("mcs-stocks")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
    return () => window.clearTimeout(t);
  }, [sel]);

  const sectors = useMemo(() => {
    if (!data?.ok) return [];
    return data.sectors;
  }, [data]);

  /** Top tab: positive sectors (API rank) → each sector’s High industry. */
  const topHighRows = useMemo(() => {
    const rows: {
      sector: string;
      sector_ret: number;
      industry: string;
      avg_ret_1y: number;
      n: number;
    }[] = [];
    for (const s of sectors) {
      if (s.avg_ret_1y <= 0) continue;
      const h = pickHigh(s);
      if (!h) continue;
      rows.push({
        sector: s.sector,
        sector_ret: s.avg_ret_1y,
        industry: h.industry,
        avg_ret_1y: h.avg_ret_1y,
        n: h.n,
      });
    }
    return rows;
  }, [sectors]);

  const topHighMax = useMemo(() => {
    let m = 0;
    for (const r of topHighRows) if (r.avg_ret_1y > m) m = r.avg_ret_1y;
    return m > 0 ? m : 1;
  }, [topHighRows]);

  const boardSectors = sectors;
  const shownBoard = boardSectors.slice(0, limit);
  const boardMax = useMemo(() => {
    let m = 0;
    for (const s of boardSectors) if (s.avg_ret_1y > m) m = s.avg_ret_1y;
    return m > 0 ? m : 1;
  }, [boardSectors]);
  const mcapHint =
    minMcapClamped > 0
      ? `₹${minMcapClamped.toLocaleString("en-IN")}–${maxMcap.toLocaleString("en-IN")} Cr`
      : `≤ ₹${maxMcap.toLocaleString("en-IN")} Cr`;

  return (
    <section className="vx mcs">
      <header className="vx-head mcs-head">
        <div>
          <span className="vx-eyebrow">Screener.in · equal-weight 12M · {mcapHint}</span>
          <h2 className="vx-title mcs-title">
            Micro <span>Monopolies</span>
          </h2>
          <p className="vx-hint mcs-lede">
            {panelTab === "top"
              ? "High leaf of each positive sector, ordered by sector 12M. Click a row for the names."
              : "One rail per sector — 12M, High / Low, then every leaf. Click any name for the list."}
          </p>
        </div>
      </header>

      <div className="mcs-toolbar">
        <label className="vx-field">
          <span className="vx-label">View</span>
          <div className="mcs-seg" role="group" aria-label="Board or Top">
            {(
              [
                ["board", "Board"],
                ["top", "Top"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={panelTab === id ? "on" : ""}
                aria-pressed={panelTab === id}
                onClick={() => setPanelTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </label>
        <label className="vx-field">
          <span className="vx-label">Exchange</span>
          <div className="mcs-seg" role="group" aria-label="Exchange board">
            {(
              [
                ["all", "All"],
                ["main", "Main board"],
                ["sme", "SME"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={board === id ? "on" : ""}
                aria-pressed={board === id}
                onClick={() => setBoard(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </label>
        <label className="vx-field vx-field--inline">
          <span className="vx-label">Min market cap</span>
          <input
            inputMode="numeric"
            value={minCap}
            onChange={(e) => setMinCap(e.target.value.replace(/[^\d.]/g, ""))}
            onBlur={commitCaps}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitCaps();
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="₹ Cr"
            aria-label="Minimum market cap in crore"
            title="Applies on Enter or when you leave the field"
          />
        </label>
        <label className="vx-field vx-field--inline">
          <span className="vx-label">Max market cap</span>
          <input
            inputMode="numeric"
            value={maxCap}
            onChange={(e) => setMaxCap(e.target.value.replace(/[^\d.]/g, ""))}
            onBlur={commitCaps}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitCaps();
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="₹ Cr"
            aria-label="Maximum market cap in crore"
            title="Applies on Enter or when you leave the field"
          />
        </label>
        <label className="vx-field vx-field--inline" title="Industry needs this many names before High / Low / list">
          <span className="vx-label">Min companies</span>
          <select value={minN} onChange={(e) => setMinN(Number(e.target.value))} aria-label="Minimum companies">
            {MIN_N_OPTS.map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
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
          Sector / leaf avg = equal-weight 12M (each name clipped to −90%…+300% so rockets don’t skew the mean) · stock rows stay raw · High / Low = named leaves
          {data?.ok ? ` · ${mcapHint} · ${data.stocks_with_return.toLocaleString("en-IN")} names` : ""}
          {boardLoading ? (data ? " · updating…" : " · computing…") : ""}
          {fillDivMsg ? ` · ${fillDivMsg}` : ""}
        </span>
      </div>

      {!data ? (
        <div className="vx-card vx-empty">Computing 12-month returns…</div>
      ) : !data.ok ? (
        <div className="vx-card vx-empty vx-msg--err">Could not load: {data.error}</div>
      ) : panelTab === "top" ? (
        !topHighRows.length ? (
          <div className="vx-card vx-empty">No positive sectors with a High industry in this band.</div>
        ) : (
          <>
            <div className={`mcs-top${boardLoading ? " is-updating" : ""}`} aria-label="Top High industries by sector 12M">
              <div className="mcs-top-head">
                <span>Rank</span>
                <span>High leaf · sector</span>
                <span>12M</span>
                <span>n</span>
              </div>
              <ol className="mcs-top-list">
                {topHighRows.map((r, i) => {
                  const next: Sel = {
                    sector: r.sector,
                    industry: r.industry,
                    side: "top",
                  };
                  const on = sameSel(sel, next);
                  const barPct = Math.max(
                    6,
                    Math.min(100, (Math.max(0, r.avg_ret_1y) / topHighMax) * 100),
                  );
                  return (
                    <li key={`${r.sector}::${r.industry}`}>
                      <button
                        type="button"
                        className={`mcs-top-row${on ? " on" : ""}`}
                        onClick={() => pick(next)}
                        title={`${r.industry} · High in ${r.sector} · ${pct(r.avg_ret_1y)} · sector ${pct(r.sector_ret)}`}
                      >
                        <span className="mcs-top-rank">{i + 1}</span>
                        <span className="mcs-top-main">
                          <strong title={r.industry}>{r.industry}</strong>
                          <em>{r.sector}</em>
                          <span className="mcs-top-track" aria-hidden>
                            <i style={{ width: `${barPct}%` }} />
                          </span>
                        </span>
                        <span className="mcs-top-pct">{pct(r.avg_ret_1y)}</span>
                        <span className="mcs-top-n">{r.n}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
            {sel ? (
              <StocksBelow
                sel={sel}
                board={board}
                minN={minN}
                minMcap={minMcapClamped}
                maxMcap={maxMcap}
                onClose={() => setSel(null)}
              />
            ) : null}
          </>
        )
      ) : !boardSectors.length ? (
        <div className="vx-card vx-empty">No sectors match.</div>
      ) : (
        <>
          <div className={`mcs-rails${boardLoading ? " is-updating" : ""}`} role="list" aria-label="Sector rails">
            {shownBoard.map((s) => (
              <div key={s.sector} role="listitem">
                <SectorRail s={s} sel={sel} onPick={pick} boardMax={boardMax} />
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
            <StocksBelow
              sel={sel}
              board={board}
              minN={minN}
              minMcap={minMcapClamped}
              maxMcap={maxMcap}
              onClose={() => setSel(null)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

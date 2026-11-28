"use client";

import { useEffect, useMemo, useState } from "react";
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
  const n = Number(raw.trim());
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

/** Best industry inside a sector (High pair, or best named industry). */
function pickHigh(
  s: MicrocapSectorReturn,
): MicrocapSectorReturn["high"] {
  if (s.high) return s.high;
  const named = s.industries.filter((x) => x.industry && x.industry !== "Other");
  const pool = named.length ? named : s.industries;
  if (!pool.length) return null;
  return (
    [...pool].sort(
      (a, b) =>
        b.avg_ret_1y - a.avg_ret_1y || a.industry.localeCompare(b.industry),
    )[0] ?? null
  );
}

function SectorColumn({
  s,
  sel,
  onPick,
  /** both = High+Low+list · high = Top tab (sector + High only). */
  band = "both",
}: {
  s: MicrocapSectorReturn;
  sel: Sel | null;
  onPick: (next: Sel) => void;
  band?: "both" | "high";
}) {
  const hasPair =
    !!(s.low && s.high) &&
    (s.low.industry !== s.high.industry || s.low.avg_ret_1y !== s.high.avg_ret_1y);
  const high = band === "high" ? pickHigh(s) : s.high;
  const showHigh = !!high && (band === "high" || hasPair);
  const showLow = band === "both" && !!s.low && hasPair;
  const showIndustries = band === "both" && s.industries.length >= 1;
  const sectorOn = sameSel(sel, { sector: s.sector, industry: null, side: "top" });

  return (
    <article className={`mcs-col${sectorOn ? " mcs-col--on" : ""}`}>
      <header className="mcs-col-head">
        <button
          type="button"
          className="mcs-col-title mcs-pick"
          title={
            band === "high" && high
              ? `${high.industry} · click for list`
              : "Show all stocks in this sector"
          }
          onClick={() =>
            onPick(
              band === "high" && high
                ? { sector: s.sector, industry: high.industry, side: "top" }
                : { sector: s.sector, industry: null, side: "top" },
            )
          }
        >
          <h3>{s.sector}</h3>
          {band === "both" ? (
            <span>{s.n.toLocaleString("en-IN")} cos</span>
          ) : null}
        </button>
        <b>
          <Ret n={s.avg_ret_1y} light />
        </b>
      </header>

      {showHigh || showLow ? (
        <div className="mcs-col-band">
          {showHigh && high ? (
            <button
              type="button"
              className={`mcs-band-btn high${sameSel(sel, { sector: s.sector, industry: high.industry, side: "top" }) ? " on" : ""}`}
              title={`${high.n} stocks · click for list`}
              onClick={() => onPick({ sector: s.sector, industry: high.industry, side: "top" })}
            >
              <em>High</em>
              <span className="mcs-ind">{high.industry}</span>
              <Ret n={high.avg_ret_1y} />
            </button>
          ) : null}
          {showLow ? (
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
          ) : null}
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

/** Micro Monopolies — StockScans sectors with High / Low industry by equal-weight 12M. */
export function MicrocapSectorsPanel() {
  const [board, setBoard] = useState<MicrocapBoardFilter>("all");
  const [minN, setMinN] = useState(2);
  const [minCap, setMinCap] = useState("");
  const [maxCap, setMaxCap] = useState(DEFAULT_MAX_CAP);
  const [data, setData] = useState<Data | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [limit, setLimit] = useState(7);
  /** Board = full columns · Top = positive sectors with their High industries only. */
  const [panelTab, setPanelTab] = useState<"board" | "top">("board");
  const [missingDivN, setMissingDivN] = useState<number | null>(null);
  const [fillingDiv, setFillingDiv] = useState(false);
  const [fillDivMsg, setFillDivMsg] = useState<string | null>(null);
  const [divFillDone, setDivFillDone] = useState(false);

  const minMcap = parseCap(minCap, 0);
  const maxMcap = Math.max(100, parseCap(maxCap, 1000));
  const minMcapClamped = Math.min(minMcap, maxMcap);

  const refreshMissingDiv = () => {
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
  };

  useEffect(() => {
    let live = true;
    setData(null);
    setSel(null);
    setDivFillDone(false);
    setFillDivMsg(null);
    void fetch(
      `/api/microcap?view=sectors&board=${board}&minN=${minN}&minMcap=${minMcapClamped}&maxMcap=${maxMcap}`,
      { cache: "no-store" },
    )
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
  }, [board, minN, minMcapClamped, maxMcap]);

  useEffect(() => {
    setDivFillDone(false);
    setFillDivMsg(null);
    refreshMissingDiv();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when universe filters change
  }, [board, minMcapClamped, maxMcap]);

  useEffect(() => {
    setLimit(7);
    setSel(null);
  }, [board, minN, minMcapClamped, maxMcap]);

  useEffect(() => {
    setSel(null);
  }, [panelTab]);

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
  const mcapHint =
    minMcapClamped > 0
      ? `₹${minMcapClamped.toLocaleString("en-IN")}–${maxMcap.toLocaleString("en-IN")} Cr`
      : `≤ ₹${maxMcap.toLocaleString("en-IN")} Cr`;

  return (
    <section className="vx mcs">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">StockScans sectors · equal-weight 12M · default ≤ ₹1,000 Cr</span>
          <h2 className="vx-title">
            Micro <span>Monopolies</span>
          </h2>
          <p className="vx-hint mcs-lede">
            {panelTab === "top"
              ? "Top = High industry of each positive sector, ranked by sector 12M (same order as Board). Click a bar for the companies."
              : "Each column is a sector (avg 12M of its microcaps). High / Low are the best and worst industries inside that sector. Click for the companies."}
          </p>
        </div>
      </header>

      <div className="vx-card mcs-toolbar">
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
            placeholder="₹ Cr"
            aria-label="Minimum market cap in crore"
          />
        </label>
        <label className="vx-field vx-field--inline">
          <span className="vx-label">Max market cap</span>
          <input
            inputMode="numeric"
            value={maxCap}
            onChange={(e) => setMaxCap(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="₹ Cr"
            aria-label="Maximum market cap in crore"
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
          Sector avg = all names in band · High / Low = industries inside that sector
          {data?.ok ? ` · ${mcapHint} · ${data.stocks_with_return.toLocaleString("en-IN")} names` : ""}
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
            <div className="vx-bars-grid vx-bars-grid--solo">
              <div className="vx-card vx-bars vx-bars--under">
                <span className="vx-label vx-label--title">
                  Top High industries · by sector 12M
                </span>
                {topHighRows.map((r) => {
                  const next: Sel = {
                    sector: r.sector,
                    industry: r.industry,
                    side: "top",
                  };
                  const on = sameSel(sel, next);
                  const barPct = Math.max(
                    4,
                    Math.min(100, (Math.max(0, r.avg_ret_1y) / topHighMax) * 100),
                  );
                  return (
                    <button
                      key={`${r.sector}::${r.industry}`}
                      type="button"
                      className={`vx-bar-row${on ? " on" : ""}`}
                      onClick={() => pick(next)}
                      title={`${r.industry} · High in ${r.sector} · ${pct(r.avg_ret_1y)} over 12M · sector ${pct(r.sector_ret)} — click for the list`}
                    >
                      <span className="vx-bar-name" title={`${r.industry} · ${r.sector}`}>
                        {r.industry}
                        <em className="mcs-bar-sub">{r.sector}</em>
                      </span>
                      <span className="vx-bar-track" aria-hidden>
                        <span className="vx-bar-fill" style={{ width: `${barPct}%` }} />
                      </span>
                      <span className="vx-bar-pct">{pct(r.avg_ret_1y)}</span>
                      <span className="vx-bar-k">{r.n}</span>
                    </button>
                  );
                })}
              </div>
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
          <div className="mcs-board" role="list" aria-label="Sector return columns">
            {shownBoard.map((s) => (
              <div key={s.sector} role="listitem">
                <SectorColumn s={s} sel={sel} onPick={pick} band="both" />
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

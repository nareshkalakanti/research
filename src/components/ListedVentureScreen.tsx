"use client";

import { useEffect, useState } from "react";
import { Loading } from "@/components/Loading";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import type { LvResult, LvRow } from "@/lib/listed-venture-score";

/**
 * Listed Venture screen (Lotusdew-style): small caps ranked on board quality
 * + earnings quality + value + trend, validated against the "Listed
 * Ventures" watchlist. Universe ₹500–6,000 Cr (where the list sits).
 */

/** Similar stocks shown at first (and per "Show more"). */
const PAGE = 25;
/**
 * "Caught" = your stock ranks inside the cluster of your list (stop at the
 * first gap > 100 ranks within the top 300) — e.g. 3 … 164 | gap | 282.
 */
function clusterCutoff(ranks: number[]): number {
  const rs = ranks.filter((r) => r <= 300).sort((a, b) => a - b);
  if (!rs.length) return 200;
  let end = rs[0]!;
  for (let i = 1; i < rs.length; i += 1) {
    if (rs[i]! - end > 100) break;
    end = rs[i]!;
  }
  return end;
}
const MCAP_MIN = 500;
const MCAP_MAX = 6000;

function fmtCr(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
}

function fmtPct(v: number | null, digits = 0): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;
}

function steadiness(cv: number | null): { label: string; cls: string } {
  if (cv == null) return { label: "—", cls: "" };
  if (cv <= 0.15) return { label: "Steady", cls: "q-up" };
  if (cv <= 0.35) return { label: "Mixed", cls: "" };
  return { label: "Volatile", cls: "q-down" };
}

export function ListedVentureScreen({ listKey = "others" }: { listKey?: string }) {
  const [data, setData] = useState<LvResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showN, setShowN] = useState(PAGE);
  const [adding, setAdding] = useState<string | null>(null);
  const [filling, setFilling] = useState<string | null>(null);
  /** Bump to refetch (e.g. after adding a stock to the list). */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({
      list: listKey,
      limit: "5000",
      mcapMin: String(MCAP_MIN),
      mcapMax: String(MCAP_MAX),
    });
    fetch(`/api/listed-venture?${qs}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as LvResult & { ok?: boolean; error?: string };
        if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
        if (alive) {
          setData(json);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "Could not load screen");
      });
    return () => {
      alive = false;
    };
  }, [listKey, tick]);

  /** Fetch quarters for names missing them — Yahoo / NSE / BSE / Groww only. */
  const fillQuarters = async () => {
    const skip: string[] = [];
    let saved = 0;
    try {
      for (let round = 0; round < 60; round += 1) {
        setFilling(`Filling quarters… ${saved} saved`);
        const res = await fetch("/api/listed-venture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "fill", skip }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          attempted?: string[];
          saved?: number;
          remaining?: number;
        };
        if (!res.ok || json.ok === false) throw new Error(json.error || "Fill failed");
        const tried = json.attempted ?? [];
        saved += json.saved ?? 0;
        setFilling(`Filling quarters… ${saved} saved · ${json.remaining ?? 0} left`);
        if (!tried.length) break;
        skip.push(...tried);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fill failed");
    } finally {
      setFilling(null);
      setTick((n) => n + 1);
    }
  };

  const addToList = async (r: LvRow) => {
    setAdding(r.ticker);
    try {
      const res = await fetch("/api/named-watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          list: listKey,
          ticker: r.ticker,
          name: r.name,
          market: r.market,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) throw new Error(json.error || "Add failed");
      setTick((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed");
    } finally {
      setAdding(null);
    }
  };

  if (!data && !error) return <Loading label="Scoring small caps" variant="block" />;
  if (!data) return <p className="miq-empty-hint" role="alert">{error}</p>;

  const v = data.validation;
  const label = data.list_label || "list";
  const cutoff = clusterCutoff(data.list_rows.map((r) => r.rank));
  const yours = [...data.list_rows].sort((a, b) => a.rank - b.rank);
  const caughtN = yours.filter((r) => r.rank <= cutoff).length;
  const similarAll = data.rows.filter((r) => !r.in_list && r.rank <= cutoff);
  const similar = similarAll.slice(0, showN);

  return (
    <div className="wl-dash lv-screen">
      <p className="wl-dash-summary">
        {data.universe.toLocaleString("en-IN")} small caps (₹500–6,000 Cr) ranked on
        board quality + earnings quality + value + trend · quarterly data for{" "}
        {data.with_quarters.toLocaleString("en-IN")}
        {data.missing_quarters.length ? (
          <>
            {" "}
            ·{" "}
            <button
              type="button"
              className="link-btn"
              disabled={!!filling}
              title="Fetch quarters from Yahoo / NSE / BSE / Groww (never Screener)"
              onClick={() => void fillQuarters()}
            >
              {filling ?? `Fill missing quarters (${data.missing_quarters.length})`}
            </button>
          </>
        ) : null}
      </p>
      <div className="lv-validate" role="note">
        <strong title="Leave-one-out: each list stock is hidden and must be found from the other names">
          Validated vs “{label}”
        </strong>
        {v.auc != null ? (
          <span title="Chance a list stock outranks a random small cap (0.5 = random, 1 = perfect)">
            AUC <b>{v.auc.toFixed(2)}</b>
          </span>
        ) : null}
        {v.top.map((t) => (
          <span key={t.n}>
            top {t.n}: <b>{t.hits}</b>/{v.in_universe}
            <em> (random {t.random})</em>
          </span>
        ))}
      </div>
      {error ? <p className="hint tight" role="alert">{error}</p> : null}

      <h2 className="lv-h">
        Your {label} — validation{" "}
        <span>
          {caughtN} / {yours.length} caught (ranked in the top {cutoff})
        </span>
      </h2>
      <div className="table-wrap">
        <table className="data-table wl-simple-table lv-table">
          <thead>
            <tr>
              <th className="num" title="Rank on the Lotusdew-style score">#</th>
              <th className="col-name">Company</th>
              <th>Industry</th>
              <th className="num">MCap</th>
              <th className="num" title="Lotusdew-style score: board + earnings + value + trend (0–100)">Score</th>
              <th className="num" title="Board quality 0–100">Board</th>
              <th className="num" title="Earnings quality 0–100">Earn</th>
              <th className="num">ROCE</th>
              <th title="Average operating margin and how steady it is, last ≤8 quarters">Margins</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {yours.map((r) => (
              <LvTableRow key={r.ticker} r={r} label={label} caught={r.rank <= cutoff} />
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="lv-h">
        Similar stocks{" "}
        <span>
          {similarAll.length} new names ranked inside the same top {cutoff}
        </span>
      </h2>
      <div className="table-wrap">
        <table className="data-table wl-simple-table lv-table">
          <thead>
            <tr>
              <th className="num" title="Rank on the Lotusdew-style score">#</th>
              <th className="col-name">Company</th>
              <th>Industry</th>
              <th className="num">MCap</th>
              <th className="num" title="Lotusdew-style score: board + earnings + value + trend (0–100)">Score</th>
              <th className="num" title="Board quality 0–100">Board</th>
              <th className="num" title="Earnings quality 0–100">Earn</th>
              <th className="num">ROCE</th>
              <th title="Average operating margin and how steady it is, last ≤8 quarters">Margins</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {similar.map((r) => (
              <LvTableRow
                key={r.ticker}
                r={r}
                label={label}
                adding={adding === r.ticker}
                onAdd={() => void addToList(r)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="lv-more">
        <span>
          Showing {similar.length} of {similarAll.length}
        </span>
        {similar.length < similarAll.length ? (
          <button type="button" className="rot-chip" onClick={() => setShowN((n) => n + PAGE)}>
            Show {Math.min(PAGE, similarAll.length - similar.length)} more
          </button>
        ) : null}
      </div>
      <p className="hint tight">
        Approximation of Lotusdew’s Listed Venture Capital rules (their exact
        rules and director database aren’t public). Weights are fixed from
        their description, not fitted to your list.
      </p>
    </div>
  );
}

function LvTableRow({
  r,
  label,
  caught,
  adding,
  onAdd,
}: {
  r: LvRow;
  label: string;
  /** Validation rows: inside the list cluster or not. */
  caught?: boolean;
  adding?: boolean;
  onAdd?: () => void;
}) {
  const st = steadiness(r.opm_cv);
  return (
    <tr className={caught === false ? "lv-missed" : undefined}>
      <td className="num">{r.rank}</td>
      <td className="col-name">
        <div className="company-watch-name">
          <a
            className="company-name wl-tv-name"
            href={tradingviewUrl(r.ticker, r.market)}
            target="_blank"
            rel="noreferrer"
          >
            {r.name || r.ticker}
          </a>
          <span className="company-meta">
            <span className="ticker">{r.ticker}</span>
            <a
              className="np-chip"
              href={napkinUrl(r.ticker)}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${r.ticker} in Napkin`}
            >
              NP
            </a>
          </span>
        </div>
      </td>
      <td className="lv-ind" title={r.sector ?? undefined}>
        {r.industry ?? "—"}
      </td>
      <td className="num">{fmtCr(r.mcap_cr)}</td>
      <td className="num"><strong>{r.score.toFixed(0)}</strong></td>
      <td className="num">{r.board.toFixed(0)}</td>
      <td className="num">{r.earnings.toFixed(0)}</td>
      <td className="num">{fmtPct(r.roce)}</td>
      <td className={st.cls}>
        {st.label}
        {r.opm_avg != null ? (
          <span className="lv-opm"> · {(r.opm_avg * 100).toFixed(0)}%</span>
        ) : null}
      </td>
      <td>
        {caught !== undefined ? (
          <span className={`result-tag ${caught ? "lv-ok" : "lv-no"}`}>
            {caught ? "✓ Caught" : "✗ Missed"}
          </span>
        ) : (
          <button
            type="button"
            className="result-tag"
            disabled={adding}
            onClick={onAdd}
            title={`Add ${r.ticker} to ${label}`}
          >
            {adding ? "Adding…" : "+ Add"}
          </button>
        )}
      </td>
    </tr>
  );
}

/** Top-nav LV page (/lv). */
export function ListedVenturePanel() {
  return (
    <section className="panel wl-panel wl-panel--simple">
      <header className="wl-simple-head">
        <div>
          <h1 className="wl-simple-title">Listed Ventures</h1>
          <p className="wl-simple-sub">
            Lotusdew-style screen: small caps with a quality board and quality
            earnings, ranked and checked against your Listed Ventures list.
          </p>
        </div>
      </header>
      <ListedVentureScreen />
    </section>
  );
}

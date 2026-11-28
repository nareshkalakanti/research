"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { subscribeReviewMembership } from "@/components/ReviewPlusButton";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import { PORTFOLIO_BAG, type ReviewBag } from "@/lib/portfolio-review-types";

export type ReviewUniverseStock = {
  t: string;
  name: string;
  market: string;
  industry: string | null;
  mcap: number | null;
};

type FundCheck = { id: string; label: string; rule: string; value: string; points: number | null; note?: string };
type ReviewRow = {
  t: string;
  name: string;
  market: string;
  industry: string | null;
  mcap: number | null;
  sales3y?: number | null;
  roce3y?: number | null;
  pb?: number | null;
  fundamental: number;
  scored: number;
  checks: FundCheck[];
  management: number;
  m_scored: number;
  m_checks: FundCheck[];
  quality: number;
  valuation: number;
  v_scored: number;
  v_checks: FundCheck[];
  total: number;
  total_max: number;
  rating: "Excellent" | "Good" | "Average" | "Poor" | "Incomplete" | "No data";
};
type DrawerKind = "fundamental" | "management" | "quality" | "valuation";
const DRAWER: Record<DrawerKind, { title: string; label: string; max: number; src: string }> = {
  fundamental: { title: "Fundamental parameters", label: "Fundamental score", max: 6, src: "Screener annual results (consolidated)" },
  management: { title: "Management parameters", label: "Management score", max: 5, src: "Screener shareholding pattern (last 12 quarters)" },
  quality: { title: "Quality parameters", label: "Quality score", max: 11, src: "Fundamental (Screener annual results) + management (shareholding pattern)" },
  valuation: { title: "Valuation parameters", label: "Valuation score", max: 6, src: "Peers = same industry (3+ with data) · cash: Yahoo" },
};


export function PortfolioReviewPanel({
  universe = null,
  bag = PORTFOLIO_BAG,
  onMembershipChange,
}: {
  universe?: ReviewUniverseStock[] | null;
  bag?: ReviewBag;
  onMembershipChange?: () => void;
}) {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<{ row: ReviewRow; kind: DrawerKind } | null>(null);
  /** Screener rate-limit: stocks without data cannot be scored until then. */
  const [pausedUntil, setPausedUntil] = useState<string | null>(null);
  const [peerColsMissing, setPeerColsMissing] = useState(false);
  /** Background "Score now" job running, and saved scores past their refresh time. */
  const [scoring, setScoring] = useState(false);
  const [stale, setStale] = useState(0);

  const load = useCallback(async (opts?: { fresh?: boolean }) => {
    try {
      const qsp = new URLSearchParams({ bag });
      if (opts?.fresh) qsp.set("fresh", "1");
      const res = await fetch(`/api/portfolio-review?${qsp}`, { cache: "no-store" });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        rows?: ReviewRow[];
        pending?: number;
        screener_paused_until?: string | null;
        peer_columns_missing?: boolean;
        scoring?: boolean;
        stale?: number;
      };
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      setErr(null);
      setScoring(!!j.scoring);
      setStale(j.stale ?? 0);
      setRows(j.rows ?? []);
      setPausedUntil(j.screener_paused_until ?? null);
      setPeerColsMissing(!!j.peer_columns_missing);
      return j.pending ?? (j.rows ?? []).filter((r) => r.scored < 0).length;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return 0;
    }
  }, [bag]);
  // Load the bag, then auto-start background scoring for unscored / stale names.
  useEffect(() => {
    let cancelled = false;
    const id = window.setTimeout(() => {
      void (async () => {
        await load();
        if (cancelled) return;
        try {
          const res = await fetch("/api/portfolio-review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ score: true, bag }),
          });
          const j = (await res.json()) as {
            ok?: boolean;
            started?: number;
            running?: boolean;
            error?: string;
          };
          if (cancelled || j.ok === false) return;
          setScoring(!!j.running);
          if (j.started) setMsg(`Scoring ${j.started} in the background`);
        } catch {
          /* Score now remains available if auto-start fails */
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [load, bag]);
  // Poll while the background job runs so scores fill in.
  useEffect(() => {
    if (!scoring) return;
    const id = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(id);
  }, [scoring, load]);
  // + / ✓ on this page — reload when that bag's membership changes.
  useEffect(() => {
    let t: number | null = null;
    return subscribeReviewMembership(() => {
      if (t != null) window.clearTimeout(t);
      t = window.setTimeout(() => void load(), 150);
    }, bag);
  }, [load, bag]);
  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [drawer]);

  const post = async (body: object) => {
    const res = await fetch("/api/portfolio-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, bag }),
    });
    return (await res.json()) as { ok?: boolean; error?: string; added?: number; missing?: string[] };
  };
  const add = async (codes: string[]) => {
    if (!codes.length) return;
    setBusy(true);
    setMsg("Adding and scoring…");
    try {
      const j = (await post({ add: codes })) as { ok?: boolean; error?: string; added?: number; found?: string[]; missing?: string[] };
      if (j.ok === false) throw new Error(j.error);
      const miss = j.missing?.length
        ? ` · not found: ${j.missing.slice(0, 8).join(", ")}${j.missing.length > 8 ? ` +${j.missing.length - 8}` : ""}`
        : "";
      // Show new stocks at once ("Scoring…"); scores fill in when ready.
      const have = new Set((rows ?? []).map((r) => r.t));
      const fresh = (j.found ?? []).filter((t) => !have.has(t));
      if (fresh.length) {
        const byT = new Map((universe ?? []).map((u) => [u.t, u] as const));
        setRows((cur) => [
          ...(cur ?? []),
          ...fresh.map((t) => ({
            t,
            name: byT.get(t)?.name ?? t,
            market: byT.get(t)?.market ?? "NSE",
            industry: byT.get(t)?.industry ?? null,
            mcap: byT.get(t)?.mcap ?? null,
            sales3y: null,
            roce3y: null,
            pb: null,
            fundamental: 0,
            scored: -1,
            checks: [],
            management: 0,
            m_scored: 0,
            m_checks: [],
            quality: 0,
            valuation: 0,
            v_scored: 0,
            v_checks: [],
            total: 0,
            total_max: 0,
            rating: "No data" as const,
          })),
        ]);
      }
      setMsg(
        j.added
          ? `Added ${j.added} — scoring…${miss}`
          : (j.found?.length ? "Already in your list" : "Nothing added") + miss,
      );
      setQ("");
      // Adding is a click: score the new stocks in the background.
      if (j.added) {
        const sj = (await post({ score: true })) as { running?: boolean };
        setScoring(!!sj.running);
      }
      await load();
      onMembershipChange?.();
      if (j.added) setMsg(`Added ${j.added} · scoring in the background${miss}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const local = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!universe || needle.length < 2) return [];
    return universe
      .filter((r) => r.t.toLowerCase().startsWith(needle) || r.name.toLowerCase().includes(needle))
      .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0))
      .slice(0, 8);
  }, [universe, q]);

  // The ranking list is cached and misses brand-new listings (e.g. a recent
  // IPO): also ask the app-wide ticker search, then Groww/BSE if that is empty.
  type Hit = { t: string; name: string; market: string; mcap: number | null; remote: boolean };
  const [extra, setExtra] = useState<Hit[]>([]);
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) {
      setExtra([]);
      return;
    }
    const ctl = new AbortController();
    const id = window.setTimeout(async () => {
      type Api = { hits?: Array<{ ticker: string; name: string; market: string; mcap_cr?: number | null; source?: string }> };
      const ask = async (remote: 0 | 1) =>
        ((await (await fetch(`/api/tickers?q=${encodeURIComponent(needle)}&limit=8&remote=${remote}`, { signal: ctl.signal })).json()) as Api).hits ?? [];
      try {
        let hits = await ask(0);
        if (!hits.length) hits = await ask(1);
        setExtra(
          hits.map((h) => ({
            t: h.ticker.toUpperCase(),
            name: h.name,
            market: h.market || "NSE",
            mcap: h.mcap_cr ?? null,
            remote: h.source === "groww" || h.source === "bse",
          })),
        );
      } catch {
        /* typing moved on, or search failed — keep the local list */
      }
    }, 300);
    return () => {
      window.clearTimeout(id);
      ctl.abort();
    };
  }, [q]);

  const suggestions = useMemo(() => {
    const seen = new Set(local.map((r) => r.t));
    const more = extra.filter((h) => !seen.has(h.t));
    return [...local.map((r) => ({ t: r.t, name: r.name, market: r.market, mcap: r.mcap, remote: false })), ...more].slice(0, 8);
  }, [local, extra]);

  /** A listing the app has never seen: save it first (as the Dashboard does), then add. */
  const pick = async (h: { t: string; name: string; market: string; remote: boolean }) => {
    if (h.remote) {
      setBusy(true);
      setMsg(`Adding ${h.t} as a new listing…`);
      try {
        await fetch("/api/tickers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: h.t, name: h.name, market: h.market }),
        });
      } catch {
        /* add() reports "not found" if this failed */
      } finally {
        setBusy(false);
      }
    }
    await add([h.t]);
  };

  /** Colour by share of checks passed: ≥ 65% green · ≥ 40% amber · else red. */
  const cls = (got: number, of: number) => (!of ? "na" : got / of >= 0.65 ? "good" : got / of >= 0.4 ? "mid" : "bad");
  const ratingCls = (r: ReviewRow) =>
    r.rating === "Excellent" ? "top" : r.rating === "Good" ? "good" : r.rating === "Average" ? "mid" : r.rating === "Poor" ? "bad" : "na"; // Incomplete / No data: grey
  const valCls = (v: number, n: number) => (!n ? "na" : v >= 3 ? "good" : v >= 1 ? "mid" : "bad");

  return (
    <>
      <div className="vx-card vx-filters">
        <span className="vx-label vx-label--title">Search and add stocks</span>
        <form
          className="vx-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add([q]);
          }}
        >
          <label className="vx-field vx-field--grow">
            <span className="vx-label">Stock name, NSE code or BSE code</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a stock name or code, e.g. Reliance, TCS, 500325…" />
            {suggestions.length ? (
              <ul className="vx-suggest" role="listbox">
                {suggestions.map((r) => (
                  <li key={r.t}>
                    <button type="button" onClick={() => void pick(r)}>
                      <strong>{r.name}</strong>
                      <span>
                        {r.t} · {r.market}
                        {r.mcap ? ` · ₹${Math.round(r.mcap).toLocaleString("en-IN")} Cr` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </label>
          <button type="submit" className="vx-btn vx-btn--gold" disabled={busy || !q.trim()}>
            Add stock
          </button>
        </form>
        {msg ? <p className="vx-hint vx-add-msg">{msg}</p> : null}
        {peerColsMissing ? (
          <p className="vx-hint vx-add-msg">
            Screener&apos;s peer table has no “Price to book value” / “Price to Sales” columns, so P/B and P/S use our
            industry medians. Add both columns on Screener (any company → Peer comparison → edit columns).
          </p>
        ) : null}
        {pausedUntil && rows?.some((r) => r.rating === "No data") ? (
          <p className="vx-hint vx-add-msg">
            Screener is rate-limiting until{" "}
            {new Date(pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — stocks showing
            “No data” are scored after that (use Refresh at the top).
          </p>
        ) : null}
      </div>

      <div className="vx-card vx-table-card">
        <div className="vx-table-head">
          <span className="vx-label vx-label--title">Stock evaluation table</span>
          <div className="vx-table-actions">
            {rows?.length ? (
              <span className="vx-hint">
                {scoring
                  ? "Scoring in the background…"
                  : [
                      rows.filter((r) => r.scored < 0).length ? `${rows.filter((r) => r.scored < 0).length} not scored` : "",
                      stale ? `${stale} older than a week` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Scores saved"}
              </span>
            ) : null}
            <button
              type="button"
              className="vx-btn"
              disabled={busy || scoring || !rows?.length}
              title="Re-queue unscored or stale scores in the background (also starts automatically when you open this page)"
              onClick={async () => {
                setBusy(true);
                try {
                  const j = (await post({ score: true })) as { ok?: boolean; started?: number; running?: boolean; error?: string };
                  if (j.ok === false) throw new Error(j.error);
                  setScoring(!!j.running);
                  setMsg(j.started ? `Scoring ${j.started} in the background` : "Every score is current");
                } catch (e) {
                  setMsg(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {scoring ? "Scoring…" : "Score now"}
            </button>
            {rows?.length ? (
              <button
                type="button"
                className="vx-btn"
                onClick={async () => {
                  if (!window.confirm("Remove every stock from the review?")) return;
                  await post({ clear: true });
                  await load();
                  onMembershipChange?.();
                }}
              >
                Clear portfolio
              </button>
            ) : null}
          </div>
        </div>
        <div className="vx-scroll">
          <table className="vx-table">
            <thead>
              <tr>
                <th>Company name</th>
                <th className="num" title="Click a score for the checklist">
                  Fundamental score
                </th>
                <th className="num" title="Click a score for the checklist">
                  Management score
                </th>
                <th className="num" title="Fundamental + management">
                  Quality score
                </th>
                <th className="num" title="Valuation checklist · range −4…+6">
                  Valuation score
                </th>
                <th className="num" title="Quality + valuation">
                  Total score
                </th>
                <th>Final rating</th>
                <th className="num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {err ? (
                <tr>
                  <td colSpan={8} className="vx-empty vx-msg--err">
                    Could not load: {err}
                  </td>
                </tr>
              ) : !rows ? (
                <tr>
                  <td colSpan={8} className="vx-empty">
                    Loading portfolio…
                  </td>
                </tr>
              ) : !rows.length ? (
                <tr>
                  <td colSpan={8} className="vx-empty">
                    Add stocks above by name, NSE code or BSE code — or tap + on Napkin, Value, or Trend.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.t}>
                    <td>
                      <a className="vx-co" href={tradingviewUrl(r.t, r.market)} target="_blank" rel="noopener noreferrer">
                        {r.name}
                      </a>
                      <span className="vx-sub">
                        {r.t}
                        {r.market !== "NSE" ? <em>{r.market}</em> : null}
                        <a className="np-chip" href={napkinUrl(r.t)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                          NP
                        </a>
                      </span>
                    </td>
                    <td className="num">
                      {r.scored < 0 ? (
                        <span className="vx-hint">{scoring ? "Scoring…" : "Not scored"}</span>
                      ) : (
                        <button
                          type="button"
                          className={`vx-score vx-score--${cls(r.fundamental, r.scored)}`}
                          onClick={() => setDrawer({ row: r, kind: "fundamental" })}
                          title="Show the fundamental checklist"
                        >
                          {r.scored ? r.fundamental : "—"}
                          <small>/ 6</small>
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {r.scored < 0 ? null : (
                        <button
                          type="button"
                          className={`vx-score vx-score--${cls(r.management, r.m_scored)}`}
                          onClick={() => setDrawer({ row: r, kind: "management" })}
                          title="Show the management checklist"
                        >
                          {r.m_scored ? r.management : "—"}
                          <small>/ 5</small>
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {r.scored < 0 ? null : (
                        <button
                          type="button"
                          className={`vx-score vx-score--${cls(r.quality, r.scored + r.m_scored)}`}
                          onClick={() => setDrawer({ row: r, kind: "quality" })}
                          title="Show the fundamental + management checklist"
                        >
                          {r.scored + r.m_scored ? r.quality : "—"}
                          <small>/ 11</small>
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {r.scored < 0 ? null : (
                        <button
                          type="button"
                          className={`vx-score vx-score--val vx-score--${valCls(r.valuation, r.v_scored)}`}
                          onClick={() => setDrawer({ row: r, kind: "valuation" })}
                          title="Valuation checklist · −4…+6"
                        >
                          {r.v_scored ? r.valuation : "—"}
                        </button>
                      )}
                    </td>
                    <td className="num vx-total-cell">
                      {r.scored < 0 ? null : (
                        <>
                          {r.total} <small>/ 17</small>
                        </>
                      )}
                    </td>
                    <td>
                      {r.scored < 0 ? null : <span className={`vx-rating vx-rating--${ratingCls(r)}`}>{r.rating}</span>}
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="vx-del"
                        aria-label={`Remove ${r.name}`}
                        title="Remove"
                        onClick={async () => {
                          await post({ remove: r.t });
                          await load();
                          onMembershipChange?.();
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {drawer ? (
        <div className="vx-drawer-wrap" onClick={() => setDrawer(null)}>
          <aside className="vx-drawer" role="dialog" aria-label={`${drawer.row.name} ${drawer.kind} checks`} onClick={(e) => e.stopPropagation()}>
            <header className="vx-drawer-head">
              <span className="vx-eyebrow">{DRAWER[drawer.kind].title}</span>
              <button type="button" className="vx-drawer-x" aria-label="Close" onClick={() => setDrawer(null)}>
                ✕
              </button>
            </header>
            <h3 className="vx-drawer-title">{drawer.row.name}</h3>
            <p className="vx-hint">
              {drawer.row.market}: {drawer.row.t}
              {drawer.row.industry ? ` · ${drawer.row.industry}` : ""}
            </p>
            <div className="vx-drawer-score">
              <span>{DRAWER[drawer.kind].label}</span>
              <strong>
                {drawer.kind === "fundamental" ? drawer.row.fundamental : drawer.kind === "management" ? drawer.row.management : drawer.kind === "quality" ? drawer.row.quality : drawer.row.valuation}
                <small> / {DRAWER[drawer.kind].max}</small>
              </strong>
            </div>
            <span className="vx-label vx-drawer-k">Detailed checks checklist</span>
            <ul className="vx-checks">
              {(drawer.kind === "fundamental" ? drawer.row.checks : drawer.kind === "management" ? drawer.row.m_checks : drawer.kind === "quality" ? [...drawer.row.checks, ...drawer.row.m_checks] : drawer.row.v_checks).map((c) => (
                <li key={c.id}>
                  <div>
                    <strong>{c.label}</strong>
                    <span className="vx-hint">
                      {c.rule} · <b>{c.value}</b>
                    </span>
                    {c.note ? <span className="vx-hint">{c.note}</span> : null}
                  </div>
                  <span className={`vx-pt vx-pt--${c.points == null ? "na" : c.points > 0 ? "yes" : c.points < 0 ? "neg" : "no"}`}>
                    {c.points == null ? "n/a" : c.points > 0 ? `+${c.points}` : String(c.points)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="vx-hint">
              {DRAWER[drawer.kind].src} · points as shown per check
            </p>
          </aside>
        </div>
      ) : null}
    </>
  );
}

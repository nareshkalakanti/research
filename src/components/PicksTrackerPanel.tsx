"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TickerSuggest, type TickerSuggestHit } from "@/components/TickerSuggest";
import { napkinUrl } from "@/lib/links";
import type { BulkAddResult, Pick, PicksData } from "@/lib/picks-tracker";

/* ---------- quarters ---------- */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type Q = { key: string; y: number; q: number };
const qOf = (key: string): Q => ({ key, y: Number(key.slice(0, 4)), q: Number(key.slice(6)) });
const qKey = (y: number, q: number) => `${y}-Q${q}`;
const qLabel = (key: string, short = false) => {
  const { y, q } = qOf(key);
  const a = MON[(q - 1) * 3]!;
  const b = MON[(q - 1) * 3 + 2]!;
  // Compact en-dash — no spaces (avoids wrap/gap issues like "Jan - Mar 26").
  return short ? `${a}–${b}` : `${a}–${b} ${String(y).slice(2)}`;
};
const qIndex = (key: string) => {
  const { y, q } = qOf(key);
  return y * 4 + (q - 1);
};
const qFromIndex = (i: number) => qKey(Math.floor(i / 4), (i % 4) + 1);
function currentQuarter(): string {
  const d = new Date();
  return qKey(d.getFullYear(), Math.floor(d.getMonth() / 3) + 1);
}
/** Quarters from a to b, oldest first. */
const qRange = (a: string, b: string) => {
  const out: string[] = [];
  for (let i = Math.min(qIndex(a), qIndex(b)); i <= Math.max(qIndex(a), qIndex(b)); i++) out.push(qFromIndex(i));
  return out;
};

type Scope = "source" | "all";
type RowStatus = "all" | "still" | "new" | "dropped" | "earlier";
/** Table filter: every row, tracked in every quarter of the range, on the latest quarter's list, new, dropped. */
type RowFilter = "any" | "every" | "now" | "new" | "dropped";

const STATUS_LABEL: Record<RowStatus, (qs: number, n: number) => string> = {
  all: (qs, n) => `${qs} of ${n} quarters`,
  still: (qs) => `Still tracking · ${qs} qtr${qs === 1 ? "" : "s"}`,
  new: () => "New",
  dropped: () => "Dropped",
  earlier: (qs) => `Earlier · ${qs} qtr${qs === 1 ? "" : "s"}`,
};

type TrackRow = { p: Pick; qs: Set<string>; status: RowStatus };

/** One row per stock (per source) seen in the range: which quarters it was on the list, and its status at the end. */
function trackRows(list: Pick[], range: string[]): TrackRow[] {
  const lastQ = range[range.length - 1]!;
  const prevQ = range.length > 1 ? range[range.length - 2]! : null;
  const by = new Map<string, { p: Pick; qs: Set<string> }>();
  for (const p of list) {
    if (!range.includes(p.quarter)) continue;
    const key = `${p.source}|${p.ticker}`;
    const r = by.get(key) ?? { p, qs: new Set<string>() };
    r.qs.add(p.quarter);
    // Prefer the newest quarter's labels/name for the row.
    if (qIndex(p.quarter) >= qIndex(r.p.quarter)) r.p = p;
    by.set(key, r);
  }
  return [...by.values()]
    .map(({ p, qs }) => {
      const inLast = qs.has(lastQ);
      const inPrev = prevQ ? qs.has(prevQ) : false;
      const status: RowStatus =
        inLast && qs.size === range.length && range.length > 1
          ? "all"
          : inLast && inPrev
            ? "still"
            : inLast
              ? "new"
              : inPrev
                ? "dropped"
                : "earlier";
      return { p, qs, status };
    })
    .sort((a, b) => b.qs.size - a.qs.size || a.p.ticker.localeCompare(b.p.ticker));
}

function matchesFilter(r: TrackRow, f: RowFilter, lastQ: string): boolean {
  if (f === "every") return r.status === "all";
  if (f === "now") return r.qs.has(lastQ);
  if (f === "new") return r.status === "new";
  if (f === "dropped") return r.status === "dropped";
  return true;
}

/** Chosen source / quarter / range survive remounts (tab refresh, reloads) for this browser session. */
const VIEW_KEY = "picks-tracker:view";
type View = { source: string | null; quarter: string; custom: { from: string; to: string } | null };
const QK = /^\d{4}-Q[1-4]$/;
function readView(): View {
  const fallback: View = { source: null, quarter: currentQuarter(), custom: null };
  try {
    const v = JSON.parse(window.sessionStorage.getItem(VIEW_KEY) ?? "null") as Partial<View> | null;
    if (!v) return fallback;
    const custom = v.custom && QK.test(v.custom.from) && QK.test(v.custom.to) ? v.custom : null;
    return {
      source: typeof v.source === "string" ? v.source : null,
      quarter: typeof v.quarter === "string" && QK.test(v.quarter) ? v.quarter : fallback.quarter,
      custom,
    };
  } catch {
    return fallback;
  }
}

/** Picks tracker (Research): stocks the user enters per source and quarter; the stocks and sectors each source keeps tracking. */
export function PicksTrackerPanel() {
  const [data, setData] = useState<PicksData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [initial] = useState(readView);
  const [source, setSource] = useState<string | null>(initial.source);
  const [quarter, setQuarter] = useState(initial.quarter);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(initial.custom);
  const [editingRange, setEditingRange] = useState(false);
  const [newSource, setNewSource] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("source");
  const [rowFilter, setRowFilter] = useState<RowFilter>("any");
  const [busy, setBusy] = useState(false);
  /** Stocks picked from search, waiting to be added together. */
  const [bulk, setBulk] = useState<TickerSuggestHit[]>([]);
  const [bulkResult, setBulkResult] = useState<BulkAddResult | null>(null);
  const rangeRef = useRef<HTMLDivElement | null>(null);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch("/api/picks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json()) as PicksData & { ok: boolean; error?: string; result?: BulkAddResult };
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData({ sources: j.sources, picks: j.picks });
      setErr(null);
      return j.result ?? true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    void fetch("/api/picks", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: PicksData & { ok: boolean; error?: string }) => {
        if (!live) return;
        if (!j.ok) setErr(j.error ?? "Could not load");
        else setData({ sources: j.sources, picks: j.picks });
      })
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(VIEW_KEY, JSON.stringify({ source, quarter, custom } satisfies View));
    } catch {
      /* storage off: view just resets on reload */
    }
  }, [source, quarter, custom]);

  useEffect(() => {
    if (!editingRange) return;
    const close = (e: MouseEvent) => {
      if (rangeRef.current && !rangeRef.current.contains(e.target as Node)) setEditingRange(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [editingRange]);

  const sources = useMemo(() => data?.sources ?? [], [data]);
  const src = source && sources.includes(source) ? source : (sources[0] ?? null);

  // Quarter list: the last 8 quarters (newest first) plus any older ones that have picks.
  const quarterList = useMemo(() => {
    const now = qIndex(currentQuarter());
    const set = new Set<string>();
    for (let i = 0; i < 8; i++) set.add(qFromIndex(now - i));
    for (const p of data?.picks ?? []) set.add(p.quarter);
    return [...set].sort((a, b) => qIndex(b) - qIndex(a));
  }, [data]);

  // Columns for the charts: the custom range, else the 4 quarters ending at the picked one.
  const range = useMemo(
    () => (custom ? qRange(custom.from, custom.to) : qRange(qFromIndex(qIndex(quarter) - 3), quarter)),
    [custom, quarter],
  );
  const lastQ = range[range.length - 1]!;
  const prevQ = range.length > 1 ? range[range.length - 2]! : null;
  const rangeFrom = range[0]!;
  const rangeLabel =
    range.length > 1 ? `${qLabel(rangeFrom)} → ${qLabel(lastQ)}` : qLabel(lastQ);

  const picks = useMemo(() => data?.picks ?? [], [data]);
  const scoped = useMemo(() => (scope === "source" ? picks.filter((p) => p.source === src) : picks), [picks, scope, src]);
  const current = picks.filter((p) => p.source === src && p.quarter === quarter);

  const srcLast = new Set(picks.filter((p) => p.source === src && p.quarter === lastQ).map((p) => p.ticker));
  const srcPrev = new Set(prevQ ? picks.filter((p) => p.source === src && p.quarter === prevQ).map((p) => p.ticker) : []);
  const newCount = [...srcLast].filter((t) => !srcPrev.has(t)).length;
  const droppedCount = [...srcPrev].filter((t) => !srcLast.has(t)).length;


  /* ---------- tracking rows (selected source) ---------- */
  const rows = useMemo(() => trackRows(picks.filter((p) => p.source === src), range), [picks, src, range]);

  const multi = range.length > 1;
  const filterCount: Record<RowFilter, number> = {
    any: rows.length,
    every: rows.filter((r) => r.status === "all").length,
    now: rows.filter((r) => r.qs.has(lastQ)).length,
    new: rows.filter((r) => r.status === "new").length,
    dropped: rows.filter((r) => r.status === "dropped").length,
  };
  const activeFilter: RowFilter = !multi && rowFilter !== "any" && rowFilter !== "now" ? "any" : rowFilter;
  const shownRows = rows.filter((r) => matchesFilter(r, activeFilter, lastQ));
  // The chart counts the same stocks as the table (same range + filter); "All sources" widens it to every source.
  const chartRows =
    scope === "source" ? shownRows : trackRows(scoped, range).filter((r) => matchesFilter(r, activeFilter, lastQ));
  const filterLabel = {
    any: multi ? `in ${rangeLabel}` : `in ${qLabel(lastQ)}`,
    every: `in every quarter, ${rangeLabel}`,
    now: `on the list in ${qLabel(lastQ)}`,
    new: `new in ${qLabel(lastQ)}`,
    dropped: `dropped in ${qLabel(lastQ)}`,
  }[activeFilter];
  const filterOpts: Array<[RowFilter, string]> = multi
    ? [
        ["any", "All in range"],
        ["every", `Every quarter ${qLabel(rangeFrom, true)} → ${qLabel(lastQ)}`],
        ["now", `On the list in ${qLabel(lastQ)}`],
        ["new", "New"],
        ["dropped", "Dropped"],
      ]
    : [["any", `On the list in ${qLabel(lastQ)}`]];

  /** A search pick joins the list; "Add N stocks" saves the whole list at once. */
  const addHit = (hit: TickerSuggestHit) => {
    if (!src) return;
    const t = hit.ticker.toUpperCase();
    setBulk((l) => (l.some((h) => h.ticker.toUpperCase() === t) ? l : [...l, hit]));
    setBulkResult(null);
    setQ("");
  };

  const addMany = async () => {
    if (!src || !bulk.length) return;
    const res = await post({
      action: "add-many",
      source: src,
      quarter,
      items: bulk.map((h) => ({ ticker: h.ticker, market: h.market, name: h.name })),
    });
    if (res && typeof res === "object") {
      setBulkResult(res);
      setBulk([]);
    }
  };

  const rangeFromValue = custom?.from ?? rangeFrom;
  const rangeToValue = custom?.to ?? lastQ;

  return (
    <section className="vx pt-root">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">The stocks and industries each source keeps tracking, quarter by quarter</span>
          <h2 className="vx-title">
            Picks <span>tracker</span>
          </h2>
        </div>
        <div className="pt-sources" role="group" aria-label="Sources">
          {sources.map((s) => {
            const on = s === src;
            return (
              <span key={s} className={`pt-source-chip${on ? " on" : ""}`}>
                <button type="button" aria-pressed={on} onClick={() => setSource(s)}>
                  {s}
                </button>
                {on ? (
                  <button
                    type="button"
                    className="pt-source-del"
                    aria-label={`Delete source ${s}`}
                    title={`Delete ${s}`}
                    disabled={busy}
                    onClick={() => {
                      const n = picks.filter((p) => p.source === s).length;
                      const msg =
                        n > 0
                          ? `Delete source “${s}” and its ${n} pick${n === 1 ? "" : "s"}?`
                          : `Delete source “${s}”?`;
                      if (!window.confirm(msg)) return;
                      void (async () => {
                        if (await post({ action: "remove-source", name: s })) setSource(null);
                      })();
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            );
          })}
          {newSource == null ? (
            <button type="button" className="pt-new" onClick={() => setNewSource("")}>
              + New source
            </button>
          ) : (
            <form
              className="pt-new-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const name = newSource.trim();
                if (name && (await post({ action: "source", name }))) {
                  setSource(name);
                  setNewSource(null);
                }
              }}
            >
              <input autoFocus value={newSource} onChange={(e) => setNewSource(e.target.value)} placeholder="e.g. Niveshaay" aria-label="New source name" />
              <button type="submit" disabled={!newSource.trim() || busy}>
                Add
              </button>
              <button type="button" className="link-btn" onClick={() => setNewSource(null)}>
                Cancel
              </button>
            </form>
          )}
        </div>
      </header>

      {err ? <p className="vx-msg vx-msg--err">{err}</p> : null}

      {/* 1. Date selector + search to add */}
      <div className="pt-addbar">
        <div className="pt-date" ref={rangeRef}>
          <button
            type="button"
            className={`pt-date-btn${editingRange || custom ? " on" : ""}`}
            aria-expanded={editingRange}
            aria-haspopup="listbox"
            aria-label={custom ? `Custom range ${rangeLabel}` : `Quarter ${qLabel(quarter)}`}
            onClick={() => setEditingRange((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M3 10h18M8 3v4M16 3v4" />
            </svg>
            <span>{custom ? rangeLabel : qLabel(quarter)}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {editingRange ? (
            <div className="pt-date-menu" role="listbox" aria-label="Pick quarter">
              <button
                type="button"
                className="pt-date-custom"
                onClick={() => {
                  const now = currentQuarter();
                  setCustom({ from: qKey(qOf(now).y, 1), to: now });
                  setQuarter(now);
                  setRowFilter("every");
                  setEditingRange(false);
                }}
              >
                <span>Year to date</span>
              </button>
              <button
                type="button"
                className={`pt-date-custom${custom ? " on" : ""}`}
                aria-expanded={!!custom}
                onClick={() => {
                  if (custom) setCustom(null);
                  else setCustom({ from: qFromIndex(qIndex(quarter) - 3), to: quarter });
                }}
              >
                <span>Custom range…</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M3 10h18M8 3v4M16 3v4" />
                </svg>
              </button>
              {custom ? (
                <div className="pt-date-custom-fields">
                  <label>
                    From
                    <select
                      value={rangeFromValue}
                      onChange={(e) => {
                        const from = e.target.value;
                        const to = qIndex(from) <= qIndex(rangeToValue) ? rangeToValue : from;
                        setCustom({ from, to });
                        setQuarter(to);
                      }}
                    >
                      {quarterList.map((k) => (
                        <option key={k} value={k}>
                          {qLabel(k)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    To
                    <select
                      value={rangeToValue}
                      onChange={(e) => {
                        const to = e.target.value;
                        const from = qIndex(rangeFromValue) <= qIndex(to) ? rangeFromValue : to;
                        setCustom({ from, to });
                        setQuarter(to);
                      }}
                    >
                      {quarterList.map((k) => (
                        <option key={k} value={k}>
                          {qLabel(k)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
              <div className="pt-date-divider" aria-hidden="true" />
              {quarterList.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="option"
                  aria-selected={k === quarter && !custom}
                  className={k === quarter && !custom ? "on" : undefined}
                  onClick={() => {
                    setQuarter(k);
                    setCustom(null);
                    setEditingRange(false);
                  }}
                >
                  {qLabel(k)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="pt-add-inline">
          <TickerSuggest
            value={q}
            onChange={setQ}
            onSelect={addHit}
            clearOnSelect
            persistGroww={false}
            placeholder={src ? `Search and pick stocks for ${src}…` : "Add a source first"}
            className="pt-search"
            submitLabel="add to list"
            disabled={!src || busy}
          />
        </div>
      </div>

      {bulk.length > 0 && src ? (
        <div className="vx-card pt-bulk">
          <div className="pt-bulk-head">
            <span>
              List for <b>{src}</b> · {qLabel(quarter)}
            </span>
            <span className="vx-hint">{bulk.length} picked</span>
          </div>
          <ul className="pt-bulk-list" aria-label="Stocks to add">
            {bulk.map((h) => {
              const already = current.some((p) => p.ticker === h.ticker.toUpperCase());
              return (
                <li key={h.ticker} className={already ? "dup" : undefined} title={already ? "Already in this quarter" : h.name}>
                  <b>{h.ticker}</b>
                  {h.name ? <small>{h.name}</small> : null}
                  <button
                    type="button"
                    aria-label={`Remove ${h.ticker} from the list`}
                    onClick={() => setBulk((l) => l.filter((x) => x.ticker !== h.ticker))}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="pt-bulk-foot">
            <button type="button" className="pt-bulk-go" disabled={busy} onClick={() => void addMany()}>
              {busy ? "Adding…" : `Add ${bulk.length} stock${bulk.length === 1 ? "" : "s"} to ${src}`}
            </button>
            <button type="button" className="link-btn" onClick={() => setBulk([])}>
              Clear list
            </button>
          </div>
        </div>
      ) : null}
      {bulkResult ? (
        <p className="vx-msg pt-bulk-msg" role="status">
          Added {bulkResult.added.length}
          {bulkResult.already.length ? ` · ${bulkResult.already.length} already on the list` : ""}
          <button type="button" className="link-btn" aria-label="Dismiss" onClick={() => setBulkResult(null)}>
            ×
          </button>
        </p>
      ) : null}

      {!data ? (
        <div className="vx-card vx-empty">Loading…</div>
      ) : !picks.length ? (
        <div className="vx-card vx-empty">
          {src ? `Search above to add stocks for ${qLabel(quarter)}.` : "Add a source, then search to add stocks."}
        </div>
      ) : (
        <>
          <div className="pt-scope-row">
            <span className="vx-hint">
              {current.length} in {qLabel(quarter)}
              {src ? ` · ${src}` : ""} · {rangeLabel}
              {prevQ ? (
                <>
                  {" "}
                  · <span className="up">+{newCount}</span> / <span className="down">−{droppedCount}</span>
                </>
              ) : null}
            </span>
            <div className="pt-scope" role="group" aria-label="Charts show">
              <button type="button" className={scope === "source" ? "on" : undefined} aria-pressed={scope === "source"} onClick={() => setScope("source")}>
                {src ?? "This source"}
              </button>
              <button type="button" className={scope === "all" ? "on" : undefined} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                All sources
              </button>
            </div>
          </div>

          <SectorBars rows={chartRows} range={range} what={filterLabel} />

          <div className="vx-card pt-card">
            <div className="pt-card-head">
              <h3>
                Track stocks · {src}
                <span className="pt-card-sub"> · {qLabel(quarter)}</span>
              </h3>
              <div className="pt-legend">
                <span>
                  <i className="pt-dot on" /> Tracked
                </span>
                <span>
                  <i className="pt-dot new" /> New
                </span>
                <span>
                  <i className="pt-dot" /> Not on the list
                </span>
                <span>
                  <i className="pt-dot dropped" /> Dropped
                </span>
              </div>
            </div>
            {multi ? (
              <div className="pt-filter" role="group" aria-label="Show stocks">
                {filterOpts.map(([k, label]) => (
                  <button key={k} type="button" className={activeFilter === k ? "on" : undefined} aria-pressed={activeFilter === k} onClick={() => setRowFilter(k)}>
                    {label} <b>{filterCount[k]}</b>
                  </button>
                ))}
              </div>
            ) : null}
            {shownRows.length ? (
              <div className="pt-table-wrap">
                <table className="pt-table">
                  <thead>
                    <tr>
                      <th className="pt-col-stock">Stock</th>
                      <th className="pt-col-industry">Industry</th>
                      <th className="pt-col-date">Date</th>
                      <th className="pt-col-trend">
                        Trend
                        <span className="pt-trend-labs">
                          {range.map((k) => (
                            <span key={k}>{qLabel(k, true)}</span>
                          ))}
                        </span>
                      </th>
                      <th className="pt-col-status">Status</th>
                      <th className="pt-col-act" />
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map(({ p, qs, status }) => (
                      <tr key={p.ticker}>
                        <td className="pt-col-stock">
                          <a href={napkinUrl(p.ticker)} target="_blank" rel="noopener noreferrer">
                            {p.ticker}
                          </a>
                          {p.name ? <small>{p.name}</small> : null}
                        </td>
                        <td className="pt-col-industry">{p.industry ?? p.sector ?? "—"}</td>
                        <td className="pt-col-date">{qLabel(p.quarter)}</td>
                        <td className="pt-col-trend">
                          <div className="pt-trend" role="img" aria-label={`${p.ticker} trend across ${rangeLabel}`}>
                            {range.map((k) => {
                              const on = qs.has(k);
                              const cls =
                                on && status === "new" && k === lastQ
                                  ? "pt-dot new"
                                  : on
                                    ? "pt-dot on"
                                    : status === "dropped" && k === lastQ
                                      ? "pt-dot dropped"
                                      : "pt-dot";
                              return (
                                <i
                                  key={k}
                                  className={cls}
                                  title={`${p.ticker} · ${qLabel(k)}: ${on ? "tracked" : "not on the list"}`}
                                />
                              );
                            })}
                          </div>
                        </td>
                        <td className={`pt-col-status pt-status pt-status--${status}`}>{STATUS_LABEL[status](qs.size, range.length)}</td>
                        <td className="pt-col-act">
                          {qs.has(quarter) ? (
                            <button
                              type="button"
                              className="link-btn"
                              aria-label={`Remove ${p.ticker} from ${qLabel(quarter)}`}
                              onClick={() => void post({ action: "remove", source: p.source, quarter, ticker: p.ticker })}
                            >
                              Remove
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="vx-hint">{rows.length ? "No stocks match this filter." : `No stocks for ${src} in this range.`}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

type Group = "sector" | "industry";

/**
 * Ranked horizontal bars: how many of the shown stocks (same range + filter as the table) sit in each
 * sector or industry. Hover a row for its count in each quarter.
 */
function SectorBars({ rows: stocks, range, what }: { rows: TrackRow[]; range: string[]; what: string }) {
  const [group, setGroup] = useState<Group>("sector");
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const label = (p: Pick) => (group === "sector" ? (p.sector ?? p.industry) : (p.industry ?? p.sector)) ?? "Unclassified";
    const per = new Map<string, { tickers: Set<string>; byQ: Map<string, Set<string>> }>();
    for (const r of stocks) {
      const g = label(r.p);
      const e = per.get(g) ?? { tickers: new Set<string>(), byQ: new Map<string, Set<string>>() };
      e.tickers.add(r.p.ticker);
      for (const k of r.qs) e.byQ.set(k, (e.byQ.get(k) ?? new Set<string>()).add(r.p.ticker));
      per.set(g, e);
    }
    return [...per]
      .map(([name, e]) => ({ name, n: e.tickers.size, byQ: range.map((k) => e.byQ.get(k)?.size ?? 0) }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [stocks, range, group]);

  const total = new Set(stocks.map((r) => r.p.ticker)).size;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const LIMIT = 12;
  const shown = showAll ? rows : rows.slice(0, LIMIT);

  return (
    <div className="vx-card pt-card">
      <div className="pt-card-head">
        <div>
          <h3>Where the picks are</h3>
          <p className="vx-hint">
            {total} stock{total === 1 ? "" : "s"} {what} · {rows.length} {group === "sector" ? "sector" : "industr"}
            {group === "sector" ? (rows.length === 1 ? "" : "s") : rows.length === 1 ? "y" : "ies"}
          </p>
        </div>
        <div className="pt-scope" role="group" aria-label="Group by">
          {(["sector", "industry"] as const).map((g) => (
            <button key={g} type="button" className={group === g ? "on" : undefined} aria-pressed={group === g} onClick={() => setGroup(g)}>
              {g === "sector" ? "Sector" : "Industry"}
            </button>
          ))}
        </div>
      </div>
      {rows.length ? (
        <ul className="pt-bars" aria-label={`Picks by ${group}`}>
          {shown.map((r) => (
            <li key={r.name} title={`${r.name}\n${range.map((k, i) => `${qLabel(k)}: ${r.byQ[i]}`).join("\n")}`}>
              <span className="pt-bar-name">{r.name}</span>
              <span className="pt-bar-track">
                <i style={{ width: `${(r.n / max) * 100}%` }} />
                <b>{r.n}</b>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vx-hint">No stocks match this filter.</p>
      )}
      {rows.length > LIMIT ? (
        <button type="button" className="link-btn pt-bars-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show top 12" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

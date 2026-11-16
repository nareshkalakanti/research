"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loading } from "@/components/Loading";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import { SS_BUCKETS, type SsBucket } from "@/lib/special-situations-shared";
import type { SsPage } from "@/lib/special-situations";

const SIZES = [
  { id: "all", label: "All sizes", max: Infinity },
  { id: "5000", label: "Under ₹5,000 Cr", max: 5000 },
  { id: "1000", label: "Under ₹1,000 Cr", max: 1000 },
] as const;

const PERIODS = [30, 60, 90] as const;

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })
    : iso;
}

function fmtCr(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString("en-IN");
}

/** Special Situations: corporate events that can create mispricing, in six themes. */
export function SpecialSituationsPanel() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(60);
  const [data, setData] = useState<(SsPage & { syncing?: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<SsBucket>("ma");
  const [size, setSize] = useState<(typeof SIZES)[number]["id"]>("all");
  const [q, setQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/special-situations?days=${days}`, { cache: "no-store" });
      const j = (await res.json()) as SsPage & { ok: boolean; error?: string; syncing?: boolean };
      if (!j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the first backfill runs, reload every few seconds so counts fill in.
  const syncing = !!data?.syncing;
  useEffect(() => {
    if (!syncing) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [syncing, load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/special-situations", { method: "POST" });
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const max = SIZES.find((s) => s.id === size)!.max;
    const needle = q.trim().toLowerCase();
    return data.rows[bucket].filter((r) => {
      if (max !== Infinity && (r.mcap_cr == null || r.mcap_cr > max)) return false;
      if (!needle) return true;
      return (
        r.symbol.toLowerCase().includes(needle) ||
        r.company.toLowerCase().includes(needle) ||
        r.latest.label.toLowerCase().includes(needle)
      );
    });
  }, [data, bucket, size, q]);

  if (error && !data) {
    return (
      <div className="panel">
        <p className="miq-empty-hint">Could not load special situations: {error}</p>
      </div>
    );
  }
  if (!data) return <Loading label="Loading special situations" variant="block" />;

  const active = SS_BUCKETS.find((b) => b.id === bucket)!;

  return (
    <div className="panel ss-panel">
      <div className="missing-head">
        <div>
          <h2>Special Situations</h2>
          <p className="missing-sub">
            Events that create opportunities — unique corporate events that can cause mispricing. Higher risk, with
            potential for higher returns.
          </p>
        </div>
        <div className="ss-head-actions">
          <span className="ss-sync">
            {syncing ? (
              <>
                <span className="ld-spin" aria-hidden /> Loading NSE announcements…
              </>
            ) : data.synced_at ? (
              `Updated ${new Date(data.synced_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
            ) : (
              "Not loaded yet"
            )}
          </span>
          <button type="button" className="btn-fill" disabled={refreshing || syncing} onClick={() => void refresh()}>
            {refreshing ? (
              <>
                <span className="ld-spin" aria-hidden /> Refreshing…
              </>
            ) : (
              "Refresh"
            )}
          </button>
        </div>
      </div>

      <div className="ss-cards" role="tablist" aria-label="Theme">
        {SS_BUCKETS.map((b, i) => (
          <button
            key={b.id}
            type="button"
            role="tab"
            aria-selected={bucket === b.id}
            className={`ss-card${bucket === b.id ? " on" : ""}`}
            onClick={() => setBucket(b.id)}
          >
            <span className="ss-card-top">
              <span className="ss-num">{i + 1}</span>
              <span className="ss-count">{data.counts[b.id]}</span>
            </span>
            <span className="ss-card-title">{b.label}</span>
            <span className="ss-card-hint">{b.hint}</span>
          </button>
        ))}
      </div>

      <div className="ss-filters">
        <div className="ss-chips" role="group" aria-label="Size">
          {SIZES.map((s) => (
            <button key={s.id} type="button" className={`chip${size === s.id ? " on" : ""}`} onClick={() => setSize(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="ss-chips" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p} type="button" className={`chip${days === p ? " on" : ""}`} onClick={() => setDays(p)}>
              {p} days
            </button>
          ))}
        </div>
        <input
          className="fam-dash-search ss-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Company or event…"
          aria-label="Filter"
        />
      </div>

      <h3 className="ss-list-title">
        {active.label} <span className="nano-count">{rows.length} companies</span>
      </h3>

      {rows.length ? (
        <div className="table-wrap nano-wrap">
          <table className="data-table nano-table ss-table">
            <thead>
              <tr>
                <th className="nano-col-name">Company</th>
                <th className="num">Value ₹ Cr</th>
                <th>Event</th>
                <th>Date</th>
                <th>What happened</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.symbol}-${r.latest.id}`}>
                  <td className="nano-col-name">
                    <a className="nano-name" href={tradingviewUrl(r.symbol, r.market)} target="_blank" rel="noreferrer">
                      {r.company}
                    </a>
                    <span className="nano-meta">
                      {r.symbol}
                      {r.market && r.market !== "NSE" ? <span>· {r.market}</span> : null}
                      <a className="np-chip" href={napkinUrl(r.symbol)} title="Open in Napkin">
                        NP
                      </a>
                    </span>
                  </td>
                  <td className="num">{fmtCr(r.mcap_cr)}</td>
                  <td>
                    <span className="ss-tag">{r.latest.label}</span>
                    {r.count > 1 ? <span className="ss-more">+{r.count - 1} more</span> : null}
                  </td>
                  <td className="ss-date">{fmtDate(r.latest.date)}</td>
                  <td className="ss-text">
                    {r.latest.url ? (
                      <a href={r.latest.url} target="_blank" rel="noreferrer">
                        {r.latest.text || r.latest.category}
                      </a>
                    ) : (
                      r.latest.text || r.latest.category
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="miq-empty-hint">
          {syncing ? "Loading announcements — this fills in over a minute or two." : "No events for this filter."}
        </p>
      )}

      <p className="ss-key">
        <strong>Key idea:</strong> special situations carry higher risk but also the potential for higher returns.
        Events are sorted automatically from NSE announcement categories and wording — open the filing before acting.
      </p>
    </div>
  );
}

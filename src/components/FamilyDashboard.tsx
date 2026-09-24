"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FamilyMapCards, type FamilyRow } from "@/components/FamilyMapCards";
import { useAppTab } from "@/lib/app-tab";
import { tradingviewUrl } from "@/lib/links";
import { requestGovOpen } from "@/lib/gov-open";

export function FamilyDashboard() {
  const { setTab } = useAppTab();
  const [rows, setRows] = useState<FamilyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ view: "family", page: "1", pageSize: "200" });
      const res = await fetch(`/api/governance-map?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: FamilyRow[] };
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const marketByTicker = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of rows) for (const c of f.companies) map.set(c.ticker, c.market);
    return map;
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (f) =>
        f.family_name.toLowerCase().includes(needle) ||
        f.companies.some(
          (c) =>
            c.ticker.toLowerCase().startsWith(needle) ||
            c.name.toLowerCase().includes(needle),
        ) ||
        (f.people ?? []).some((p) => p.name.toLowerCase().includes(needle)),
    );
  }, [rows, q]);

  const openCompany = (ticker: string) => {
    setTab("governance");
    requestGovOpen({ kind: "company", ticker, from: "Dashboard", returnTab: "dashboard" });
  };

  const openPerson = (personId: string, name: string) => {
    setTab("governance");
    requestGovOpen({ kind: "director", personId, name, from: "Dashboard", returnTab: "dashboard" });
  };

  return (
    <section className="fam-dash">
      <div className="fam-dash-head">
        <div>
          <h2 className="fam-dash-title">Business groups</h2>
          <p className="fam-dash-sub">
            Companies grouped by house, with the board people who link them.
            Click a node to open the company; click a ticker name for its
            TradingView chart.
          </p>
        </div>
        <div className="fam-dash-actions">
          <input
            type="search"
            className="fam-dash-search"
            placeholder="Group, ticker, company or director…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>
      {error ? <div className="table-meta">Could not load groups: {error}</div> : null}
      {loading && !rows.length ? (
        <div className="table-meta">Loading business groups…</div>
      ) : (
        <FamilyMapCards
          rows={filtered}
          onTicker={(t) => openCompany(t)}
          onPerson={(id, name) => openPerson(id, name)}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
        />
      )}
    </section>
  );
}

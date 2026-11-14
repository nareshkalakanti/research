"use client";

import { Loading } from "@/components/Loading";
import { useCallback, useEffect, useState } from "react";
import { FamilyGraph } from "@/components/FamilyGraph";
import { BoxRefreshButton } from "@/components/RefreshButton";
import { GOV_MAP_CHANGED } from "@/lib/gov-map-sync";
import {
  TickerSuggest,
  type TickerSuggestHit,
} from "@/components/TickerSuggest";
import { tradingviewUrl } from "@/lib/links";

type Network = {
  ticker: string;
  name: string;
  market: string;
  companies: Array<{
    ticker: string;
    name: string;
    market: string;
    cap_code: string | null;
    market_cap_cr?: number | null;
    is_sme: boolean;
  }>;
  people: Array<{
    person_id: string;
    name: string;
    din: string | null;
    tickers: string[];
    dir_score?: number;
  }>;
};

export function StockNetworkSearch({
  onPerson,
  initialTicker,
  hideSearch = false,
  onOpenCompany,
}: {
  onPerson: (personId: string, name: string) => void;
  initialTicker?: string | null;
  /** Embedded use (Napkin): the host page already has a ticker search. */
  hideSearch?: boolean;
  /** Override node / chip clicks (e.g. open that stock in Napkin). */
  onOpenCompany?: (ticker: string) => void;
}) {
  const [stockQ, setStockQ] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [row, setRow] = useState<Network | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(async (sym: string) => {
    const ticker = sym.trim().toUpperCase();
    if (!ticker) {
      setFocus(null);
      setRow(null);
      return;
    }
    setStockQ(ticker);
    setFocus(ticker);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/governance-map?view=network&ticker=${encodeURIComponent(ticker)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { row?: Network | null };
      setRow(json.row ?? null);
      if (!json.row) setError("No board seats on file for this ticker.");
    } catch (e) {
      setRow(null);
      setError(e instanceof Error ? e.message : "Could not load network");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = (initialTicker || "").trim().toUpperCase();
    if (t) void pick(t);
  }, [initialTicker, pick]);

  useEffect(() => {
    const onChange = () => {
      if (focus) void pick(focus);
    };
    window.addEventListener(GOV_MAP_CHANGED, onChange);
    return () => window.removeEventListener(GOV_MAP_CHANGED, onChange);
  }, [focus, pick]);

  const marketByTicker = new Map(
    (row?.companies ?? []).map((c) => [c.ticker.toUpperCase(), c.market]),
  );
  const openCompany = (t: string) =>
    onOpenCompany ? onOpenCompany(t) : void pick(t);
  const focalTicker = (row?.ticker || "").toUpperCase();
  const hub = (row?.companies ?? []).filter(
    (c) => c.ticker.toUpperCase() === focalTicker,
  );
  const connected = (row?.companies ?? []).filter(
    (c) => c.ticker.toUpperCase() !== focalTicker,
  );

  return (
    <div className="fam-stock-net">
      {hideSearch ? null : (
      <div className="theme-stock-search theme-stock-search--inline fam-stock-search">
        <TickerSuggest
          value={stockQ}
          onChange={(v) => {
            setStockQ(v);
            if (!v.trim()) {
              setFocus(null);
              setRow(null);
              setError(null);
            } else if (focus && v.trim().toUpperCase() !== focus) {
              setFocus(null);
              setRow(null);
            }
          }}
          onSelect={(hit: TickerSuggestHit) => {
            void pick(hit.ticker);
          }}
          onSubmit={(t) => {
            void pick(t);
          }}
          placeholder="Search ticker or company…"
          className="theme-stock-suggest-input"
        />
      </div>
      )}
      {loading ? (
        <Loading label="Loading directors and connected boards" variant="block" />
      ) : null}
      {error ? <div className="table-meta">{error}</div> : null}
      {row ? (
        <article className="gov-card gov-family-card fam-stock-card">
          <header className="gov-family-head">
            <div className="gov-family-head-row">
              <div className="gov-family-title-text">
                <span className="gov-family-name">{row.name}</span>
                <span className="gov-family-sub">
                  {row.ticker} · {row.people.length} directors ·{" "}
                  {connected.length} connected{" "}
                  {connected.length === 1 ? "company" : "companies"}
                </span>
              </div>
              <BoxRefreshButton
                busy={loading}
                onRefresh={() => void pick(row.ticker)}
              />
            </div>
          </header>
          <FamilyGraph
            companies={hub.length ? hub : row.companies.slice(0, 1)}
            people={row.people}
            outside={connected}
            onCompany={openCompany}
            onPerson={onPerson}
            chartUrl={(t) =>
              tradingviewUrl(t, marketByTicker.get(t.toUpperCase()) ?? row.market)
            }
          />
          <div className="gov-family-chips">
            {row.companies.map((c) => {
              const focal = c.ticker.toUpperCase() === row.ticker.toUpperCase();
              return (
                <button
                  key={c.ticker}
                  type="button"
                  className={`gov-family-chip${focal ? " full" : " part"}`}
                  title={`${c.ticker} · ${c.name} — show this stock and related boards`}
                  onClick={() => openCompany(c.ticker)}
                >
                  <span className="mono">{c.ticker}</span>
                </button>
              );
            })}
          </div>
        </article>
      ) : !loading && !error && !hideSearch ? (
        <div className="table-meta">
          Search a stock for its board map: directors, connected listings as
          dashed outside nodes, and bottom ticker chips to jump between them.
        </div>
      ) : null}
    </div>
  );
}

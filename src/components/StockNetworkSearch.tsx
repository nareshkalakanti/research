"use client";

import { useCallback, useEffect, useState } from "react";
import { FamilyGraph } from "@/components/FamilyGraph";
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
}: {
  onPerson: (personId: string, name: string) => void;
  initialTicker?: string | null;
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

  const marketByTicker = new Map(
    (row?.companies ?? []).map((c) => [c.ticker.toUpperCase(), c.market]),
  );

  return (
    <div className="fam-stock-net">
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
      {loading ? (
        <div className="table-meta">Loading directors and connected boards…</div>
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
                  {row.companies.length} connected companies
                </span>
              </div>
            </div>
          </header>
          <FamilyGraph
            companies={row.companies}
            people={row.people}
            outside={[]}
            onCompany={(t) => void pick(t)}
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
                  onClick={() => void pick(c.ticker)}
                >
                  <span className="mono">{c.ticker}</span>
                </button>
              );
            })}
          </div>
        </article>
      ) : !loading && !error ? (
        <div className="table-meta">
          Pick a stock to see its directors and every listed board they sit on.
        </div>
      ) : null}
    </div>
  );
}

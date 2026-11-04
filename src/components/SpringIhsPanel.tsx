"use client";

import { useCallback, useEffect, useState } from "react";
import { tradingviewUrl } from "@/lib/links";
import type { SpringIhsRow } from "@/lib/spring-ihs";

/** Same exchange lists as PEAD. */
const SPRING_LISTS = ["All", "NSE", "NSE SME", "BSE SME"] as const;
type SpringList = (typeof SPRING_LISTS)[number];

type ApiResponse = {
  ok?: boolean;
  market?: string;
  tried?: number;
  failed?: number;
  remaining?: number;
  nextOffset?: number;
  universe?: number;
  hits?: SpringIhsRow[];
  error?: string;
};

function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    maximumFractionDigits: d,
    minimumFractionDigits: 0,
  });
}

export function SpringIhsPanel() {
  const [market, setMarket] = useState<SpringList>("All");
  const [tipOnly, setTipOnly] = useState(false);
  const [lookbackBars, setLookbackBars] = useState(10);
  const [batchSize, setBatchSize] = useState(40);
  const [scanning, setScanning] = useState(false);
  const [hits, setHits] = useState<SpringIhsRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markets, setMarkets] = useState<Record<string, number>>({});

  useEffect(() => {
    void fetch("/api/companies?market=All&pageSize=1")
      .then((r) => r.json())
      .then((j: { markets?: Record<string, number> }) => {
        if (j.markets) setMarkets(j.markets);
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);
  const listCount = (list: SpringList): number => {
    if (list === "All") return allCount;
    if (list === "NSE") return nseCount;
    if (list === "NSE SME") return smeCount;
    return bseSmeCount;
  };

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    setHits([]);
    setStatus("Scanning…");
    const allHits: SpringIhsRow[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let totalTried = 0;
    let totalFailed = 0;
    let universe = 0;

    try {
      for (let round = 0; round < 120; round += 1) {
        const res = await fetch("/api/spring-ihs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            market,
            limit: batchSize,
            offset,
            concurrency: 5,
            tipOnly,
            lookbackBars,
            yearsBack: 2,
          }),
          signal: AbortSignal.timeout(180_000),
        });
        const json = (await res.json()) as ApiResponse;
        if (!res.ok || json.ok === false) {
          setError(json.error || `Scan failed (${res.status})`);
          break;
        }
        universe = json.universe ?? universe;
        totalTried += json.tried ?? 0;
        totalFailed += json.failed ?? 0;
        for (const h of json.hits ?? []) {
          const key = `${h.ticker}:${h.date}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allHits.push(h);
        }
        allHits.sort((a, b) => {
          const d = b.date.localeCompare(a.date);
          return d || a.ticker.localeCompare(b.ticker);
        });
        setHits([...allHits]);
        const rem = json.remaining ?? 0;
        setStatus(
          `${market} · ${totalTried.toLocaleString()}/${universe.toLocaleString() || "…"} · hits ${allHits.length} · ${rem.toLocaleString()} left`,
        );
        if (rem <= 0 || (json.tried ?? 0) === 0) break;
        offset = json.nextOffset ?? offset + batchSize;
      }
      setStatus(
        `Done · ${market} · tried ${totalTried.toLocaleString()} · ${allHits.length} hit${allHits.length === 1 ? "" : "s"}${totalFailed ? ` · ${totalFailed} miss` : ""}`,
      );
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Scan failed";
      setError(/timeout|aborted/i.test(raw) ? "Scan timed out — retry" : raw);
    } finally {
      setScanning(false);
    }
  }, [scanning, market, tipOnly, lookbackBars, batchSize]);

  return (
    <div className="panel pead2-panel">
      <div className="toolbar gov-toolbar">
        <div className="pead2-title">
          <h2>Spring + inverse H&amp;S</h2>
          <p>
            Long breakout: spring under prior 60-bar low, right shoulder, falling
            neckline, +DI/−DI &amp; rising ADX, volume thrust. Enter next open;
            RR ≥ 1.5. Pick a list and Run.
          </p>
        </div>
        <label className="field">
          <span>List</span>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value as SpringList)}
            disabled={scanning}
            aria-label="Spring IHS list"
          >
            {SPRING_LISTS.map((list) => (
              <option key={list} value={list}>
                {list} ({listCount(list).toLocaleString() || "…"})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Batch</span>
          <select
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value))}
            disabled={scanning}
          >
            {[20, 40, 60, 80].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Lookback</span>
          <select
            value={tipOnly ? 0 : lookbackBars}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v <= 0) setTipOnly(true);
              else {
                setTipOnly(false);
                setLookbackBars(v);
              }
            }}
            disabled={scanning}
            title="How recent the trigger bar must be"
          >
            <option value={0}>Tip only</option>
            <option value={5}>Last 5 bars</option>
            <option value={10}>Last 10 bars</option>
            <option value={20}>Last 20 bars</option>
          </select>
        </label>
        <button
          type="button"
          className={`btn-fill ${scanning ? "on" : ""}`}
          disabled={scanning}
          onClick={() => void runScan()}
        >
          {scanning ? "Scanning…" : "Run on list"}
        </button>
      </div>

      <div className="table-meta">
        {error ? (
          <span className="gov-load-error" role="alert">
            {error}
          </span>
        ) : status ? (
          <span>{status}</span>
        ) : (
          <span>Pick a list and Run — hits appear as batches finish.</span>
        )}
      </div>

      <div className="table-card">
        <div className="table-wrap">
          <table className="data-table pead2-table spring-ihs-table">
            <colgroup>
              <col className="spring-ihs-col-co" />
              <col className="spring-ihs-col-num" />
              <col className="spring-ihs-col-num" />
              <col className="spring-ihs-col-num" />
              <col className="spring-ihs-col-num" />
              <col className="spring-ihs-col-num" />
              <col className="spring-ihs-col-num" />
              <col className="spring-ihs-col-num" />
              <col className="spring-ihs-col-num" />
            </colgroup>
            <thead>
              <tr>
                <th className="col-company pead2-col-company">Company</th>
                <th className="col-num">Trigger</th>
                <th className="col-num">Entry</th>
                <th className="col-num">Head</th>
                <th className="col-num">RS</th>
                <th className="col-num">Neckline</th>
                <th className="col-num">Stop</th>
                <th className="col-num">Target</th>
                <th className="col-num">RR</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => (
                <tr key={`${h.ticker}-${h.date}`}>
                  <td className="col-company pead2-col-company">
                    <div className="pead2-co">
                      <a
                        className="pead2-name pead2-name-btn"
                        href={tradingviewUrl(h.ticker, h.market)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${h.ticker} on TradingView`}
                      >
                        {h.name}
                      </a>
                      <div className="pead2-co-meta">
                        <span className="mono">{h.ticker}</span>
                        <a
                          className="pead2-link"
                          href={tradingviewUrl(h.ticker, h.market)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          TV
                        </a>
                      </div>
                    </div>
                  </td>
                  <td className="col-num mono">{h.date}</td>
                  <td className="col-num" title={h.entry_kind}>
                    {fmt(h.entry)}
                  </td>
                  <td className="col-num">{fmt(h.head)}</td>
                  <td className="col-num">{fmt(h.rs_low)}</td>
                  <td className="col-num">{fmt(h.neckline)}</td>
                  <td className="col-num">{fmt(h.stop)}</td>
                  <td className="col-num">{fmt(h.target)}</td>
                  <td className="col-num">{fmt(h.rr, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!hits.length && !scanning ? (
            <div className="table-meta">No spring + IHS triggers in range.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

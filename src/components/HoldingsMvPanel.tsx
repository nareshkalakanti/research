"use client";

import { useCallback, useEffect, useState } from "react";
import { tradingviewUrl } from "@/lib/links";

type Row = {
  ticker: string;
  name: string;
  current_w: number;
  suggested_w: number;
  delta_w: number;
  alpha: number;
  grad: number;
  days: number;
  tv_url?: string;
};

type Result = {
  lambda: number;
  max_w: number;
  names: number;
  days: number;
  L_current: number;
  L_star: number;
  skipped: string[];
  rows: Row[];
};

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function num(x: number, d = 3): string {
  return x.toFixed(d);
}

export function HoldingsMvPanel() {
  const [lambda, setLambda] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Result | null>(null);

  const run = useCallback(async (lam: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/holdings-mv?lambda=${encodeURIComponent(String(lam))}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as Result & { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || "Could not run mean-variance");
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run mean-variance");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(8);
  }, [run]);

  return (
    <div className="holdings-mv">
      <header className="holdings-mv-head">
        <div>
          <h1>Holdings · mean variance</h1>
          <p>
            Investment tilt on your holdings, not a 100% bet. Trailing α is
            shrunk so one spike cannot take the book. P* is long-only, sums to
            1, and no name can exceed the max weight. Equal weight is “now”
            because holdings have no quantities. Click a ticker for TradingView.
          </p>
        </div>
        <label className="holdings-mv-lambda">
          <span>λ {lambda}</span>
          <input
            type="range"
            min={0.5}
            max={20}
            step={0.5}
            value={lambda}
            disabled={busy}
            onChange={(e) => setLambda(Number(e.target.value))}
          />
          <button
            type="button"
            className="din-fill-btn"
            disabled={busy}
            onClick={() => void run(lambda)}
          >
            {busy ? "Running…" : "Apply"}
          </button>
        </label>
      </header>
      {error ? <p className="buyback-error">{error}</p> : null}
      {data ? (
        <p className="buyback-status">
          {data.names} names · {data.days} days · max {(data.max_w * 100).toFixed(1)}%
          each · L {num(data.L_current)} → L* {num(data.L_star)}
          {data.skipped.length
            ? ` · skipped ${data.skipped.length} (thin history)`
            : ""}
        </p>
      ) : null}
      {data?.rows.length ? (
        <div className="buyback-result-card holdings-mv-table-wrap">
          <table className="holdings-mv-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th>Now</th>
                <th>P*</th>
                <th>Δ</th>
                <th>α</th>
                <th>∇L</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.ticker}>
                  <td className="mono">
                    <a
                      className="holdings-mv-tv"
                      href={
                        r.tv_url || tradingviewUrl(r.ticker)
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {r.ticker}
                    </a>
                  </td>
                  <td>{r.name}</td>
                  <td>{pct(r.current_w)}</td>
                  <td>{pct(r.suggested_w)}</td>
                  <td className={r.delta_w >= 0 ? "is-up" : "is-down"}>
                    {r.delta_w >= 0 ? "+" : ""}
                    {pct(r.delta_w)}
                  </td>
                  <td>{pct(r.alpha)}</td>
                  <td>{num(r.grad, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data && !data.rows.length && !busy ? (
        <p className="buyback-status">
          Need at least two holdings with overlapping daily history.
        </p>
      ) : null}
    </div>
  );
}

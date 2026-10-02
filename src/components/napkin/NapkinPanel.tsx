"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { TickerSuggest, type TickerSuggestHit } from "@/components/TickerSuggest";
import {
  pickUniqueListing,
  rankListingQuery,
} from "@/lib/listing-name-match";
import { loadNapkinResearch, type NapkinLoadDebug } from "@/lib/napkin/client";
import { napkinMetric, napkinPeDisplay } from "@/lib/napkin/format";
import type { NapkinResearch } from "@/lib/napkin/types";
import { NapkinValuation } from "@/components/napkin/NapkinValuation";

function na(v: string | undefined): string {
  return !v || v === "N/A" ? "N/A" : v;
}

function dash(): string {
  return "—";
}

function fmtUpdated(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "N/A";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function NapkinPanel() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<NapkinResearch | null>(null);
  const [debug, setDebug] = useState<NapkinLoadDebug | null>(null);
  const tickRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const resolveTicker = async (raw: string): Promise<string> => {
    const typed = raw.trim();
    if (!typed) return "";
    const compact = typed
      .toUpperCase()
      .replace(/\.NS$/i, "")
      .replace(/[^A-Z0-9]/g, "");
    try {
      const res = await fetch(
        `/api/tickers?q=${encodeURIComponent(typed)}&limit=14`,
        { signal: AbortSignal.timeout(14_000) },
      );
      const json = (await res.json()) as { hits?: TickerSuggestHit[] };
      const hits = Array.isArray(json.hits) ? json.hits : [];
      const exact = hits.find(
        (h) => h.ticker.trim().toUpperCase() === compact,
      );
      if (exact) return exact.ticker.trim().toUpperCase();
      const unique = pickUniqueListing(typed, hits);
      if (unique?.ticker) return unique.ticker.trim().toUpperCase();
      const top = hits[0];
      if (
        top?.ticker &&
        rankListingQuery(typed, top.ticker, top.name) <= 3
      ) {
        return top.ticker.trim().toUpperCase();
      }
    } catch {
      /* fall through to compact ticker */
    }
    return compact;
  };

  const run = async (raw: string) => {
    const ticker = await resolveTicker(raw);
    if (!ticker) {
      setError("Enter a ticker or company name");
      return;
    }
    setQ(ticker);
    setLoading(true);
    setError(null);
    setDebug(null);
    setElapsed(0);
    const t0 = Date.now();
    if (tickRef.current) window.clearInterval(tickRef.current);
    tickRef.current = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - t0) / 100) / 10);
    }, 200);
    const url = new URL(window.location.href);
    url.searchParams.delete("ticker");
    if ((url.searchParams.get("tab") || "") !== "napkin") {
      url.searchParams.set("tab", "napkin");
    }
    window.history.replaceState(window.history.state, "", url);
    try {
      const { research, debug: yahooDebug } = await loadNapkinResearch(ticker);
      setData(research);
      setDebug(yahooDebug);
    } catch (e) {
      setData(null);
      setError(
        e instanceof Error && e.name === "AbortError"
          ? "Request aborted after 45s"
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      if (tickRef.current) window.clearInterval(tickRef.current);
      tickRef.current = null;
      setElapsed(Math.round((Date.now() - t0) / 100) / 10);
      setLoading(false);
    }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const initial = (url.searchParams.get("ticker") || "").trim();
    if (url.searchParams.has("ticker")) {
      url.searchParams.delete("ticker");
      window.history.replaceState(window.history.state, "", url);
    }
    if (initial) void run(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hist5 = data ? napkinMetric(data.financials, "eps5") : "N/A";
  const status = data?.data_status ?? "insufficient";
  const dq = data?.data_quality;
  const statusLine =
    status === "complete"
      ? "✓ Data complete"
      : status === "partial"
        ? "○ Partial data"
        : "○ Insufficient data";

  return (
    <div className="napkin-dash napkin-simple">
      <div className="napkin-sheet">
        <div className="napkin-logo">Napkin Research</div>
        <form
          className="napkin-bar"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(q);
          }}
        >
          <div className="napkin-search-row">
            <TickerSuggest
              value={q}
              onChange={setQ}
              onSelect={(hit) => {
                setQ(hit.ticker);
                void run(hit.ticker);
              }}
              onSubmit={(ticker) => void run(ticker)}
              disabled={loading}
              placeholder="Search NSE ticker..."
              className="napkin-ticker"
              submitLabel="go"
            />
            <button type="submit" className="napkin-analyse" disabled={loading}>
              {loading ? "…" : "GO"}
            </button>
          </div>
        </form>

        {loading ? (
          <p className="napkin-debug" aria-live="polite">
            Fetching Yahoo Finance and Screener… {elapsed}s
          </p>
        ) : null}
        {error ? <p className="napkin-error">{error}</p> : null}

        {data ? (
          <>
            <div className="napkin-sheet-section napkin-header-block">
              <div className="napkin-stock-header">
                <div>
                  <div className="napkin-company">{data.name}</div>
                  <div className="napkin-ticker-lg">
                    {data.yf_symbol || `${data.ticker}.NS`}
                  </div>
                </div>
                <div className="napkin-card-value">
                  {napkinMetric(data.overview, "price")}
                </div>
              </div>
              <div className="napkin-meta-row">
                Market Cap {napkinMetric(data.overview, "mcap")}
                {data.sector ? ` · ${data.sector}` : ""}
              </div>
            </div>

            <div className="napkin-sheet-section">
              <h2 className="napkin-block-title">Financials</h2>
              <div className="napkin-table-wrap">
                <table className="napkin-table napkin-table--nums">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Current</th>
                      <th>3Y CAGR</th>
                      <th>5Y CAGR</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Revenue</td>
                      <td>{napkinMetric(data.overview, "revenue")}</td>
                      <td>{na(napkinMetric(data.financials, "rev3"))}</td>
                      <td>{na(napkinMetric(data.financials, "rev5"))}</td>
                    </tr>
                    <tr>
                      <td>Net Profit</td>
                      <td>{napkinMetric(data.financials, "ni")}</td>
                      <td>{na(napkinMetric(data.financials, "p3"))}</td>
                      <td>{na(napkinMetric(data.financials, "p5"))}</td>
                    </tr>
                    <tr>
                      <td>EPS</td>
                      <td>{napkinMetric(data.overview, "eps")}</td>
                      <td>{na(napkinMetric(data.financials, "eps3"))}</td>
                      <td>{na(hist5)}</td>
                    </tr>
                    <tr>
                      <td>Net Margin</td>
                      <td>{na(napkinMetric(data.financials, "mnow"))}</td>
                      <td>{dash()}</td>
                      <td>{dash()}</td>
                    </tr>
                    <tr>
                      <td>ROE</td>
                      <td>{napkinMetric(data.overview, "roe")}</td>
                      <td>{dash()}</td>
                      <td>{dash()}</td>
                    </tr>
                    <tr>
                      <td>ROCE</td>
                      <td>{napkinMetric(data.overview, "roce")}</td>
                      <td>{dash()}</td>
                      <td>{dash()}</td>
                    </tr>
                    <tr>
                      <td>P/E</td>
                      <td>{napkinPeDisplay(napkinMetric(data.overview, "pe"))}</td>
                      <td>{dash()}</td>
                      <td>{dash()}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <NapkinValuation data={data} />

            <div className="napkin-sheet-section napkin-foot">
              <p className={`napkin-status-line napkin-status-line--${status}`}>
                {statusLine}
              </p>
              <p className="napkin-data-src">
                Sources:{" "}
                {(data.sources || ["Yahoo Finance", "Screener"]).join(" · ")}
              </p>
              <p className="napkin-data-src">
                Updated: {fmtUpdated(data.fetched_at)}
                {debug?.yahoo_ms != null ? ` · ${debug.yahoo_ms}ms` : ""}
              </p>
              {!dq?.fiveYearCagrAvailable ? (
                <p className="napkin-missing">
                  EPS 5Y CAGR N/A
                  {dq?.reasons?.eps_5y || dq?.reason
                    ? ` — ${dq.reasons?.eps_5y || dq.reason}`
                    : ""}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { FilterBar, Pick, Toggle } from "@/components/FilterBar";
import { Loading } from "@/components/Loading";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import type { NanoFillJob } from "@/lib/nanocap-champs";
import type { ModelPage, ModelRow } from "@/lib/sm-model-page";

const pct = (v: number | null, digits = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;

type Cap = "all" | "tiny" | "small" | "mid" | "upper";
const CAPS: ReadonlyArray<readonly [Cap, string, number, number]> = [
  ["all", "₹100–6,000 Cr", 0, Infinity],
  ["tiny", "₹100–500 Cr", 0, 500],
  ["small", "₹500–1,000 Cr", 500, 1000],
  ["mid", "₹1,000–3,000 Cr", 1000, 3000],
  ["upper", "₹3,000–6,000 Cr", 3000, Infinity],
];

function whyText(w: ModelRow["why"][number]): string {
  const up = w.c > 0;
  const v = w.id === "mom6" ? pct(w.v, 0) : w.id === "n_named" ? String(Math.round(Math.expm1(w.v))) : Number(w.v.toFixed(2)).toString();
  return `${up ? "▲" : "▼"} ${w.label}: ${v}`;
}

/** Model: every stock in the universe scored by the smart-money model. */
export function ModelView() {
  const [page, setPage] = useState<ModelPage | null>(null);
  const [job, setJob] = useState<NanoFillJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<Cap>("all");
  const [smartOnly, setSmartOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sm-model", { cache: "no-store" });
      const json = (await res.json()) as ModelPage & { ok: boolean; error?: string; job: NanoFillJob | null };
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPage(json);
      setJob(json.job);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const running = job?.running && job.kind === "smmodel";
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(async () => {
      try {
        const res = await fetch("/api/sm-model?job=1", { cache: "no-store" });
        const json = (await res.json()) as { job: NanoFillJob | null };
        setJob(json.job);
        if (!json.job?.running) void load();
      } catch {
        /* retry */
      }
    }, 4000);
    return () => window.clearInterval(id);
  }, [running, load]);

  const post = async (body: object) => {
    const res = await fetch("/api/sm-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setJob(((await res.json()) as { job: NanoFillJob | null }).job);
  };

  if (error && !page) return <div className="table-meta">Could not load: {error}</div>;
  if (!page) return <Loading label="Loading the model" variant="block" />;
  const rep = page.report;
  const inCap = page.rows.filter((r) => {
    const b = CAPS.find((x) => x[0] === cap)!;
    return r.mcap_cr != null && r.mcap_cr >= b[2] && r.mcap_cr < b[3];
  });
  const filtered = inCap.filter((r) => !smartOnly || r.smart.length);
  const rows = showAll ? filtered : filtered.slice(0, 100);

  return (
    <div>

      <div className={`filter-progress status-block nano-progress${running ? "" : " is-done"}`} role="status" aria-live="polite">
        <div className="mom-ratio-head">
          <strong>Data</strong>
          <span className="mom-ratio-nums">
            history for <b>{page.data.backfilled.toLocaleString("en-IN")}</b> of{" "}
            {page.data.universe.toLocaleString("en-IN")} stocks · prices for{" "}
            <b>{page.data.priced.toLocaleString("en-IN")}</b>
          </span>
          {running ? (
            <button type="button" className="btn-fill-all" onClick={() => void post({ stop: true })}>
              Stop
            </button>
          ) : (
            <>
              <button type="button" className="btn-fill" disabled={!!job?.running} onClick={() => void post({})}>
                Run (fetch data + train)
              </button>
              <button type="button" className="btn-ghost" disabled={!!job?.running} onClick={() => void post({ retrainOnly: true })}>
                Retrain only
              </button>
            </>
          )}
        </div>
        {running ? (
          <>
            <div className="filter-progress-track">
              <div
                className="filter-progress-fill"
                style={{ width: `${job!.total ? Math.max(1, Math.round((job!.done / job!.total) * 100)) : 1}%` }}
              />
            </div>
            <span className="filter-progress-text">
              <span className="ld-spin" aria-hidden /> {job!.done.toLocaleString("en-IN")} of{" "}
              {(job!.total || 0).toLocaleString("en-IN")} steps — filings first, then prices, then training · runs on
              the server, safe to close the tab
            </span>
          </>
        ) : null}
      </div>

      {page.data.nse_blocked_at && page.data.backfilled < page.data.universe ? (
        <p className="sl-lv">
          NSE stopped answering on {new Date(page.data.nse_blocked_at).toLocaleString("en-IN")} after too many requests —
          history is still missing for {(page.data.universe - page.data.backfilled).toLocaleString("en-IN")} stocks.
          {running ? " The run is still going and will pick up when NSE answers." : " Run again later; it carries on where it stopped."}
        </p>
      ) : null}
      {rep && rep.test_auc != null && (rep.test_auc < 0.55 || (rep.test_top_excess ?? 0) <= (rep.test_avg_excess ?? 0)) ? (
        <p className="sm-warn">
          <strong>No proven edge yet — don&apos;t use these scores to pick stocks.</strong> On the quarters it never saw,
          the model&apos;s top picks did not beat the average stock (AUC {rep.test_auc.toFixed(2)}, about a coin flip).
          It needs more history first.
        </p>
      ) : null}
      {rep ? (
        <div className="sm-model-report">
          {rep.test_auc != null ? (
            <>
              <div>
                <span className="sl-sub">Test (quarters it never saw)</span>
                <strong>
                  Top 10% picks: {pct(rep.test_top_excess)} vs Nifty · all stocks {pct(rep.test_avg_excess)} · bottom
                  10% {pct(rep.test_bottom_excess)}
                </strong>
              </div>
              <div>
                <span className="sl-sub">Beat the Nifty</span>
                <strong>
                  {pct(rep.test_top_hit, 0).replace("+", "")} of top picks vs {pct(rep.test_avg_hit, 0).replace("+", "")}{" "}
                  of all · AUC {rep.test_auc.toFixed(2)} (0.50 = coin flip)
                </strong>
              </div>
            </>
          ) : (
            <div>
              <strong>{rep.note || "Not tested yet."}</strong>
            </div>
          )}
          <div>
            <span className="sl-sub">Data</span>
            <strong>
              {rep.n_train.toLocaleString("en-IN")} training rows ({rep.train_buckets[0] ?? "—"} →{" "}
              {rep.train_buckets.at(-1) ?? "—"}) · {rep.n_test.toLocaleString("en-IN")} test rows (
              {rep.test_buckets.join(", ") || "—"}) · trained {new Date(rep.trained_at).toLocaleString("en-IN")}
            </strong>
          </div>
          {rep.weights.length ? (
            <div>
              <span className="sl-sub">What it learned (strongest first)</span>
              <span className="sm-weights">
                {rep.weights.slice(0, 8).map((w) => (
                  <span key={w.id} className={`sm-holder ${w.w > 0 ? "ok" : "bad"}`}>
                    {w.w > 0 ? "▲" : "▼"} {w.label}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="table-meta">No model yet — press Run. The first run fetches 3 years of filings, so it takes a while.</p>
      )}

      {page.rows.length ? (
        <>
          <FilterBar>
            <Pick
              label="Size"
              value={cap}
              onChange={setCap}
              options={CAPS.map(([id, text, lo, hi]) => ({
                id,
                label: text,
                count: page.rows.filter((r) => r.mcap_cr != null && r.mcap_cr >= lo && r.mcap_cr < hi).length,
              }))}
            />
            <Toggle
              label="Smart money holds"
              checked={smartOnly}
              onChange={setSmartOnly}
              count={inCap.filter((r) => r.smart.length).length}
              title="Only stocks your tracked investors hold"
            />
          </FilterBar>
          <p className="table-meta">
            {page.rows.length.toLocaleString("en-IN")} stocks scored (NSE and NSE SME — BSE-only stocks have no NSE
            filings) · showing {rows.length} of {filtered.length}
          </p>
          <div className="table-wrap nano-wrap">
            <table className="data-table nano-table sl-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th className="nano-col-name">Stock</th>
                  <th className="num" title="Rank among all scored stocks, 100 = best">
                    Model
                  </th>
                  <th className="num" title="Model's chance of beating the Nifty over the next 6 months">
                    Chance
                  </th>
                  <th className="sl-why">Why</th>
                  <th className="num">Value ₹ Cr</th>
                  <th className="num">P/E</th>
                  <th title="Board trust from the Shortlist">Trust</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.ticker}>
                    <td className="num">{i + 1}</td>
                    <td className="nano-col-name">
                      <a className="nano-name" href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noreferrer">
                        {r.name}
                      </a>
                      <span className="nano-meta">
                        {r.ticker}
                        {r.market && r.market !== "NSE" ? <span>· {r.market}</span> : null}
                        <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                          NP
                        </a>
                        {websiteUrl(r.website) ? (
                          <a className="np-chip" href={websiteUrl(r.website)!} target="_blank" rel="noopener noreferrer" title={r.website ?? ""}>
                            Web
                          </a>
                        ) : null}
                      </span>
                      {r.sector ? (
                        <span className="mom-sector">
                          {r.sector}
                          {r.sub_sector ? ` › ${r.sub_sector}` : ""}
                        </span>
                      ) : null}
                    </td>
                    <td className="num">
                      <span className="mom-q">{r.score}</span>
                    </td>
                    <td className="num">{Math.round(r.prob * 100)}%</td>
                    <td className="sl-why">
                      <ul>
                        {r.why.map((w) => (
                          <li key={w.id} className={w.c > 0 ? "sl-happen" : "sl-flag"}>
                            {whyText(w)}
                          </li>
                        ))}
                        {r.smart.length ? <li className="sl-smart">Smart money: {r.smart.join(", ")}</li> : null}
                      </ul>
                    </td>
                    <td className="num">{r.mcap_cr == null ? "—" : Math.round(r.mcap_cr).toLocaleString("en-IN")}</td>
                    <td className="num">{r.pe == null ? "—" : r.pe.toFixed(1)}</td>
                    <td>{r.trust == null ? "—" : <span className="mom-q">{r.trust}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > 100 ? (
            <div className="rot-more">
              <button type="button" className="rot-chip" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show top 100 only" : `Show all ${filtered.length}`}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

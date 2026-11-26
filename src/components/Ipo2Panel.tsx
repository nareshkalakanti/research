"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ReviewPlusButton } from "@/components/ReviewPlusButton";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import { BASE_STAGES as STAGES, BaseChart, inr, shortDate, STAGE_LABEL } from "@/components/BaseChart";
import type { BasesDetail as Detail, Ipo2Entry, Ipo2Result, Ipo2Row, Ipo2Stage } from "@/lib/ipo2";

type Exch = "all" | "nse" | "nse_sme" | "bse" | "bse_sme";
type SortKey = "listing" | "mcap" | "run" | "ret" | "score" | "pivot";

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function cr(n: number | null): string {
  if (n == null) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
}
function age(m: number): string {
  if (m < 1) return "under a month";
  if (m < 12) return `${m} mo`;
  const y = Math.floor(m / 12);
  const r = m % 12;
  return r ? `${y} yr ${r} mo` : `${y} yr`;
}

function Check({ ok, label, title }: { ok: boolean | null; label: string; title: string }) {
  return (
    <span className={`ipo2-check ${ok === true ? "pass" : ok === false ? "fail" : "na"}`} title={title}>
      {ok === true ? "✓" : ok === false ? "✗" : "?"} {label}
    </span>
  );
}

function EntryCell({ e, live }: { e: Ipo2Entry | null; live: boolean }) {
  if (!e) return <td className="ipo2-entry">—</td>;
  return (
    <td className="ipo2-entry">
      <b className={live ? "ipo2-live" : undefined}>{e.label}</b>
      <span>
        {shortDate(e.date)} · above {inr(e.level)}
      </span>
      <span className="ipo2-stop">
        stop {inr(e.stop)} · risk {e.risk_pct}%{e.vol_x != null && (e.kind === "pivot" || e.kind === "add") ? ` · vol ${e.vol_x}×` : ""}
      </span>
    </td>
  );
}

function DetailRow({ ticker, cols }: { ticker: string; cols: number }) {
  const [d, setD] = useState<Detail | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(`/api/ipo2?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((j: Detail) => live && setD(j))
      .catch(() => live && setD({ ok: false, error: "Could not load the chart" }));
    return () => {
      live = false;
    };
  }, [ticker]);
  return (
    <tr className="ipo2-detail">
      <td colSpan={cols}>
        {!d ? <p className="vx-empty">Loading chart…</p> : d.ok ? <BaseChart series={d.series} analysis={d.analysis} ticker={d.ticker} /> : <p className="vx-msg vx-msg--err">{d.error}</p>}
      </td>
    </tr>
  );
}

const PAGE = 150;

export function Ipo2Panel() {
  const [data, setData] = useState<(Ipo2Result & { ok: boolean; error?: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [stages, setStages] = useState<Ipo2Stage[]>(["buy_zone", "near_pivot"]);
  const [exch, setExch] = useState<Exch>("all");
  const [urgencyOnly, setUrgencyOnly] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("score");
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  /** Refresh button rebuilds the screen; the first load runs from `reloadKey`'s effect. */
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);
  useEffect(() => {
    let live = true;
    void fetch(`/api/ipo2${reloadKey ? "?refresh=1" : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as Ipo2Result & { ok: boolean; error?: string };
        if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (!live) return;
        setData(j);
        setErr(null);
      })
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const base = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => {
      if (exch === "nse" && r.market !== "NSE") return false;
      if (exch === "nse_sme" && r.market !== "NSE SME") return false;
      if (exch === "bse" && r.market !== "BSE") return false;
      if (exch === "bse_sme" && r.market !== "BSE SME") return false;
      if (urgencyOnly && r.urgency !== true) return false;
      if (needle && !`${r.name} ${r.ticker} ${r.industry ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, exch, urgencyOnly, q]);

  const counts = useMemo(() => {
    const m = new Map<Ipo2Stage, number>();
    for (const r of base) m.set(r.stage, (m.get(r.stage) ?? 0) + 1);
    return m;
  }, [base]);

  const rows = useMemo(() => {
    const out = stages.length ? base.filter((r) => stages.includes(r.stage)) : base.slice();
    const key = (r: Ipo2Row): number =>
      sort === "listing"
        ? -Date.parse(r.listing_date)
        : sort === "mcap"
          ? -(r.mcap_cr ?? 0)
          : sort === "run"
            ? -(r.run_pct ?? -1e9)
            : sort === "ret"
              ? -r.ret_pct
              : sort === "pivot"
                ? r.to_pivot_pct ?? 1e9
                : -(r.score * 1e7 + (r.mcap_cr ?? 0));
    return out.sort((a, b) => key(a) - key(b));
  }, [base, stages, sort]);

  const toggleStage = (s: Ipo2Stage) => {
    setLimit(PAGE);
    setStages((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  };
  const cols = 8;
  const R = data?.rules;

  return (
    <section className="vx ipo2">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">Stocks listed in the last {R?.maxAgeYears ?? 4} years · bases and entry points</span>
          <h2 className="vx-title">
            IPO2 <span>Strategy</span>
          </h2>
        </div>
        <div className="vx-actions">
          <button type="button" className="vx-btn" disabled={loading} onClick={load}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="vx-card vx-filters">
        <div className="ipo2-stages" role="group" aria-label="Stage">
          {STAGES.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.hint}
              className={`ipo2-chip ipo2-chip--${s.id}${stages.includes(s.id) ? " on" : ""}`}
              aria-pressed={stages.includes(s.id)}
              onClick={() => toggleStage(s.id)}
            >
              {s.label} <em>{(counts.get(s.id) ?? 0).toLocaleString("en-IN")}</em>
            </button>
          ))}
          <button type="button" className="link-btn" onClick={() => setStages([])}>
            Show all stages
          </button>
        </div>
        <div className="ipo2-filters">
          <label className="vx-field">
            <span className="vx-label">Search</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company, symbol or industry" />
          </label>
          <div className="vx-field">
            <span className="vx-label">Exchange</span>
            <div className="pa-presets" role="group" aria-label="Exchange">
              {(
                [
                  ["all", "All"],
                  ["nse", "NSE"],
                  ["nse_sme", "NSE SME"],
                  ["bse", "BSE"],
                  ["bse_sme", "BSE SME"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className={exch === id ? "on" : ""} aria-pressed={exch === id} onClick={() => setExch(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="ipo2-toggle">
            <input type="checkbox" checked={urgencyOnly} onChange={(e) => setUrgencyOnly(e.target.checked)} />
            Urgency only ({R?.urgencyGreenWeeks ?? 6}/{R?.urgencyWeeks ?? 8} green weeks or {R?.urgencyGreenDays ?? 6}/
            {R?.urgencyDays ?? 9} green days)
          </label>
          <label className="vx-field">
            <span className="vx-label">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="score">Checks passed</option>
              <option value="pivot">Closest to pivot</option>
              <option value="listing">Newest listing</option>
              <option value="run">Biggest first run</option>
              <option value="ret">Return since listing</option>
              <option value="mcap">Market cap</option>
            </select>
          </label>
        </div>
        {R ? (
          <p className="vx-hint">
            <b>Bases:</b> a rest below the high for {Math.round(R.ipoBaseMinDays / 5)}+ weeks (IPO base) or {R.baseMinDays / 5}+ weeks,
            at least {R.baseMinDepthPct}% deep; ideal {R.idealDepth[0]}–{R.idealDepth[1]}%, broken past {R.maxDepthIpoPct}% (IPO base) or{" "}
            {R.maxDepthPct}%. <b>Low cheat / cheat:</b> {R.pauseDays} closes moving sideways within {R.pauseRangePct}% on below-average volume in the lower /
            middle third of the base; buy above the pause high. <b>Pivot:</b> close above the base high. <b>E1B / E2B:</b> a{" "}
            {R.addMinDepthPct}–{R.addMaxDepthPct}% pause of {R.addMinDays}+ days after the breakout. Stops sit under the pause or pivot low,
            at most {R.maxStopPct}% below the buy level.
            <br />
            First run is measured from the IPO issue price (NSE&apos;s past issues) where known
            {data ? ` (${data.with_issue_price.toLocaleString("en-IN")} of ${data.rows.length.toLocaleString("en-IN")} stocks)` : ""}, else
            from the listing-day close: BSE-only issues and some main-board IPOs aren&apos;t in NSE&apos;s list. The day-1 ignite bar and
            QIB subscription aren&apos;t checked (no open/high/low or subscription data saved). Today&apos;s volume is partial until the close.
          </p>
        ) : null}
      </div>

      {err ? <p className="vx-msg vx-msg--err">Could not load: {err}</p> : null}

      <div className="vx-card vx-table-card">
        <div className="vx-table-head">
          <span className="vx-label vx-label--title">{data ? `${rows.length.toLocaleString("en-IN")} stocks` : "Stocks"}</span>
          <span className="vx-hint">
            {data
              ? `${data.rows.length.toLocaleString("en-IN")} listed in the last ${R?.maxAgeYears ?? 4} years · ${data.skipped_old.toLocaleString(
                  "en-IN",
                )} older companies skipped (old BSE code or NSE batch listing)${
                  data.no_prices ? ` · ${data.no_prices} without saved prices` : ""
                }${
                  data.stale_prices
                    ? ` · ${data.stale_prices.toLocaleString("en-IN")} with older prices updating in the background (Refresh in a minute)`
                    : ""
                } · click a row for its chart`
              : loading
                ? "Loading…"
                : ""}
          </span>
        </div>
        <div className="vx-scroll">
          <table className="vx-table ipo2-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Industry</th>
                <th>Listed</th>
                <th
                  className="num"
                  title={`Green weekly bars in the first ${R?.urgencyWeeks ?? 8} weeks after listing and green days in the first ${
                    R?.urgencyDays ?? 9
                  } sessions (closed above the previous close). Below: the best close in 8 weeks vs the issue price or day-1 close.`}
                >
                  Urgency
                </th>
                <th className="num">Since listing</th>
                <th>Stage</th>
                <th>Latest entry</th>
                <th>Checks</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((r) => {
                const web = websiteUrl(r.website);
                const isOpen = open === r.ticker;
                return (
                  <Fragment key={r.ticker}>
                    <tr className={`ipo2-row${isOpen ? " open" : ""}`} onClick={() => setOpen(isOpen ? null : r.ticker)}>
                      <td>
                        <a
                          className="vx-co"
                          href={tradingviewUrl(r.ticker, r.market)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.name}
                        </a>
                        <span className="vx-sub" onClick={(e) => e.stopPropagation()}>
                          {r.ticker}
                          {r.market !== "NSE" ? <em>{r.market}</em> : null}
                          <ReviewPlusButton ticker={r.ticker} />
                          <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                            NP
                          </a>
                          {web ? (
                            <a className="np-chip" href={web} target="_blank" rel="noopener noreferrer" title={r.website ?? ""}>
                              Web
                            </a>
                          ) : null}
                        </span>
                      </td>
                      <td className="pa-sector" title={[r.sector, r.industry].filter(Boolean).join(" › ") || undefined}>
                        {r.industry || r.sector || "—"}
                        <span className="pa-cap-cr ipo2-cap">{cr(r.mcap_cr)}</span>
                      </td>
                      <td className="ipo2-listed" title={r.listing_source === "nse" ? "NSE listing date" : "First day in the saved prices"}>
                        {shortDate(r.listing_date)}
                        <span>
                          {age(r.age_months)}
                          {r.listing_source === "history" ? " · from prices" : ""}
                        </span>
                        {r.issue_price != null ? (
                          r.issue_mismatch ? (
                            <span
                              className="ipo2-warn"
                              title="The saved prices are adjusted for a later split / bonus, the issue price isn't, so it isn't used"
                            >
                              Issue {inr(r.issue_price)}: split / bonus since listing, not used
                            </span>
                          ) : (
                            <span>
                              Issue {inr(r.issue_price)}
                              {r.listing_gain_pct != null ? ` · day 1 ${pct(r.listing_gain_pct)}` : ""}
                            </span>
                          )
                        ) : null}
                        {r.history_gap ? <span className="ipo2-warn">Prices start later: first run not checked</span> : null}
                        {r.corp_actions.length ? (
                          <span className="ipo2-warn" title="A one-day move past any exchange circuit: earlier prices adjusted as a split / bonus">
                            Split / bonus adjusted:{" "}
                            {r.corp_actions.map((c) => `${shortDate(c.date)} ×${c.ratio}`).join(", ")}
                          </span>
                        ) : null}
                      </td>
                      <td className={`num ${r.urgency ? "pos-t" : ""}`}>
                        {r.green_weeks == null ? "—" : `${r.green_weeks}/${r.weeks_seen} wks`}
                        {r.green_days != null ? <span className="ipo2-sub">{`${r.green_days}/${r.days_seen} days`}</span> : null}
                        {r.run_pct != null ? (
                          <span className="ipo2-sub">
                            {pct(r.run_pct)} {r.run_base === "issue" ? "from issue" : "from day 1"}
                          </span>
                        ) : null}
                      </td>
                      <td className={`num ${r.ret_pct >= 0 ? "pos-t" : "neg"}`}>
                        {pct(r.ret_pct)}
                        <span className="ipo2-sub">{inr(r.price)}</span>
                      </td>
                      <td className="ipo2-stage">
                        <span className={`ipo2-pill ipo2-pill--${r.stage}`}>{STAGE_LABEL[r.stage]}</span>
                        <span>{r.stage_note}</span>
                        {r.vol_dry && (r.stage === "in_base" || r.stage === "near_pivot") ? <span className="ipo2-sub">Volume drying up</span> : null}
                        {r.sell_now ? (
                          <span className="ipo2-sell" title={`${r.sell_now.label} on ${shortDate(r.sell_now.date)} at ${inr(r.sell_now.price)}, ${r.sell_now.ext_pct}% above the 10-day average`}>
                            {r.sell_now.action}: {r.sell_now.label.toLowerCase()}
                          </span>
                        ) : null}
                      </td>
                      <EntryCell e={r.live_entry ?? r.last_entry} live={!!r.live_entry} />
                      <td className="ipo2-checks">
                        <Check
                          ok={r.urgency}
                          label="Urgency"
                          title={`${r.green_weeks ?? 0}/${r.weeks_seen} green weeks, ${r.green_days ?? 0}/${r.days_seen} green days after listing. Needs ${
                            R?.urgencyGreenWeeks ?? 6
                          }/${R?.urgencyWeeks ?? 8} weeks or ${R?.urgencyGreenDays ?? 6}/${R?.urgencyDays ?? 9} days.`}
                        />
                        <Check
                          ok={r.growth_ok}
                          label="Growth"
                          title={
                            r.growth?.stale
                              ? `No recent quarter: the latest saved one is ${r.growth.quarter}, over ${R?.growthMaxAgeMonths ?? 9} months old`
                              : r.growth && (r.growth.sales_yoy != null || r.growth.np_yoy != null)
                              ? `Latest quarter (${r.growth.quarter}) vs a year earlier: sales ${pct(r.growth.sales_yoy)}, profit ${pct(
                                  r.growth.np_yoy,
                                )}. Needs both ≥ ${R?.growthPct ?? 20}%.`
                              : "No year-ago quarter saved"
                          }
                        />
                        <Check
                          ok={r.base_depth_pct == null ? null : r.stage !== "broken"}
                          label="Depth"
                          title={r.base_depth_pct == null ? "No base yet" : `Latest base ${r.base_depth_pct}% deep`}
                        />
                        <Check
                          ok={!r.base_vol ? null : !r.base_vol.cooled || r.base_vol.returning === false ? false : r.base_vol.returning ? true : null}
                          label="Volume"
                          title={
                            !r.base_vol
                              ? "No base volume saved"
                              : `Latest base volume (× its average): left side ${r.base_vol.left_x}×, bottom ${r.base_vol.bottom_x}×, right side ${r.base_vol.right_x}×${
                                  r.base_vol.right_updown != null ? `, right-side up days ${r.base_vol.right_updown}× down days` : ""
                                }. Want heavy on the left, dry at the bottom, returning on the right.`
                          }
                        />
                        {r.lockout ? (
                          <Check
                            ok={true}
                            label="Lockout"
                            title={`Lockout rally since ${shortDate(r.lockout.start)}: ${r.lockout.green} of 8 weekly bars green, +${r.lockout.gain_pct}% (end of stage 1 / start of stage 2)`}
                          />
                        ) : null}
                        <Check ok={null} label="QIB" title="QIB subscription not saved: check the IPO's subscription page" />
                      </td>
                    </tr>
                    {isOpen ? <DetailRow ticker={r.ticker} cols={cols} /> : null}
                  </Fragment>
                );
              })}
              {data && !rows.length ? (
                <tr>
                  <td colSpan={cols} className="vx-empty">
                    No stocks in these stages. Pick more stages above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {rows.length > limit ? (
          <button type="button" className="vx-btn ipo2-more" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, rows.length - limit)} more
          </button>
        ) : null}
      </div>
    </section>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { BASE_STAGES, BaseChart, inr, shortDate, STAGE_LABEL } from "@/components/BaseChart";
import type { BasesDetail } from "@/lib/ipo2";

const RANGES = [
  { id: "1Y", years: 1 },
  { id: "2Y", years: 2 },
  { id: "5Y", years: 5 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

function age(from: string, to: string): string {
  const m = Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (30.44 * 86_400_000)));
  if (m < 12) return `${m} mo ago`;
  const y = Math.floor(m / 12);
  return m % 12 ? `${y} yr ${m % 12} mo ago` : `${y} yr ago`;
}

/**
 * Napkin: price with bases and entry points. Recent listings (last 4 years) use the
 * IPO rules from the listing day; every other stock uses the normal base rules.
 * Mount with `key={ticker}` so a new stock starts clean.
 */
export function NapkinBasesCard({ ticker, market }: { ticker: string; market?: string | null }) {
  const [d, setD] = useState<BasesDetail | null>(null);
  const [range, setRange] = useState<RangeId>("2Y");

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ ticker });
    if (market) qs.set("market", market);
    void fetch(`/api/ipo2?${qs}`)
      .then((r) => r.json())
      .then((j: BasesDetail) => live && setD(j))
      .catch(() => live && setD({ ok: false, error: "Could not load prices" }));
    return () => {
      live = false;
    };
  }, [ticker, market]);

  const fromIdx = useMemo(() => {
    if (!d?.ok || d.mode === "ipo") return 0;
    const years = RANGES.find((r) => r.id === range)!.years;
    // Count back from the latest price, not the clock (keeps render pure).
    const lastAt = Date.parse(`${d.series[d.series.length - 1]!.date}T00:00:00Z`);
    const cut = new Date(lastAt - years * 365.25 * 86_400_000).toISOString().slice(0, 10);
    const i = d.series.findIndex((b) => b.date >= cut);
    return i < 0 ? 0 : i;
  }, [d, range]);

  if (!d) return <p className="vx-empty">Loading bases for {ticker}…</p>;
  if (!d.ok) return <p className="vx-msg vx-msg--err">{d.error}</p>;
  const a = d.analysis;
  const live = a.live_entry;
  const hint = BASE_STAGES.find((s) => s.id === a.stage)?.hint;

  return (
    <div className="napkin-bases">
      <div className="napkin-bases-head">
        <div>
          <h3 className="vx-earn-title">Bases &amp; entries</h3>
          <p className="napkin-bases-mode">
            {d.mode === "ipo" && d.listing_date ? (
              <>
                Listed {shortDate(d.listing_date)} ({age(d.listing_date, a.last_date)}) · IPO rules
                {a.run_pct != null ? (
                  <>
                    {" "}
                    · first run{" "}
                    <b className={a.urgency ? "pos-t" : undefined}>
                      {a.run_pct > 0 ? "+" : ""}
                      {a.run_pct}%
                    </b>{" "}
                    in 8 wks {a.urgency === true ? "✓ urgency" : a.urgency === false ? "(under 50%)" : ""}
                  </>
                ) : null}
              </>
            ) : (
              <>Base rules · each base needs a 25%+ rise into it</>
            )}
          </p>
          <p className="napkin-bases-stage">
            <span className={`ipo2-pill ipo2-pill--${a.stage}`} title={hint}>
              {STAGE_LABEL[a.stage]}
            </span>{" "}
            {a.stage_note}
            {a.vol_dry && (a.stage === "in_base" || a.stage === "near_pivot") ? " · volume drying up" : ""}
          </p>
          {live ? (
            <p className="napkin-bases-live">
              <b>{live.label}</b> {shortDate(live.date)}: above {inr(live.level)}, stop {inr(live.stop)} (risk {live.risk_pct}%)
            </p>
          ) : a.pivot != null && a.to_pivot_pct != null && a.to_pivot_pct > 0 && (a.stage === "in_base" || a.stage === "near_pivot") ? (
            <p className="napkin-bases-live napkin-bases-live--wait">
              Pivot {inr(a.pivot)}: {a.to_pivot_pct}% above today&apos;s {inr(a.last_close)}
            </p>
          ) : null}
        </div>
        {d.mode === "established" ? (
          <div className="pa-presets napkin-bases-range" role="group" aria-label="Chart range">
            {RANGES.map((r) => (
              <button key={r.id} type="button" className={range === r.id ? "on" : ""} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
                {r.id}
              </button>
            ))}
          </div>
        ) : (
          <span className="vx-earn-period">Since listing</span>
        )}
      </div>
      <BaseChart series={d.series} analysis={a} ticker={d.ticker} fromIdx={fromIdx} height={240} />
      <p className="vx-hint napkin-bases-foot">
        Daily closes. Low cheat / cheat: a tight sideways pause in the lower / middle third of a base, buy above its high. Pivot: close
        above the base high. E1B / E2B: small pause after the breakout. Stops at most 8% under the buy level.
      </p>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_NAPKIN_CONFIG,
  NAPKIN_DEFAULT_EXPECTED_CAGR,
  NAPKIN_EXPECTED_CAGR_PRESETS,
  napkinForwardScenario,
  napkinRequiredEpsCagr,
} from "@/lib/napkin/engine";
import {
  formatNapkinPct,
  formatNapkinPctWhole,
  formatNapkinRupee,
  napkinMathNotes,
  napkinMetric,
  napkinPeDisplay,
  parseDisplayedMoney,
  parseDisplayedPct,
  parseDisplayedPe,
} from "@/lib/napkin/format";
import type { NapkinResearch } from "@/lib/napkin/types";
import { NapkinBuyPrice } from "@/components/napkin/NapkinBuyPrice";

export function NapkinValuation({ data }: { data: NapkinResearch }) {
  const [expected, setExpected] = useState(NAPKIN_DEFAULT_EXPECTED_CAGR);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    setExpected(NAPKIN_DEFAULT_EXPECTED_CAGR);
    setCustom("");
  }, [data.ticker]);

  const hist5 = napkinMetric(data.financials, "eps5");
  const hist3 = napkinMetric(data.financials, "eps3");
  const historical = hist5 !== "N/A" ? hist5 : hist3;
  const eps = parseDisplayedMoney(napkinMetric(data.overview, "eps"));
  const price = parseDisplayedMoney(napkinMetric(data.overview, "price"));
  const pe = parseDisplayedPe(napkinPeDisplay(napkinMetric(data.overview, "pe")));
  const requiredRatio = napkinRequiredEpsCagr(pe);
  const required = formatNapkinPct(requiredRatio);
  const histRatio = parseDisplayedPct(historical);
  const fwd = napkinForwardScenario({
    eps,
    pe,
    price,
    expected_cagr: expected,
    required_cagr: requiredRatio,
    historical_cagr: histRatio,
    years: DEFAULT_NAPKIN_CONFIG.years,
    significant_pp: DEFAULT_NAPKIN_CONFIG.pass_gap_pp,
  });
  const notes = napkinMathNotes({
    historicalEpsCagr: historical,
    usedFiveYear: hist5 !== "N/A",
    aboveHistory: fwd.above_history,
  });
  const years = fwd.years;

  const pick = (rate: number) => {
    setExpected(rate);
    setCustom("");
  };

  return (
    <>
      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Napkin</h2>
        <dl className="napkin-dl napkin-val">
          <div className="napkin-dl-row">
            <dt>Required EPS CAGR</dt>
            <dd>{required}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Historical EPS CAGR</dt>
            <dd>{historical}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Growth Gap</dt>
            <dd>
              {formatNapkinPct(
                histRatio != null && requiredRatio != null
                  ? histRatio - requiredRatio
                  : null,
                true,
              )}
            </dd>
          </div>
        </dl>

        <h3 className="napkin-subhead">Your future growth</h3>
        <p className="napkin-cagr-label">Expected EPS CAGR</p>
        <div className="napkin-cagr-chips" role="group" aria-label="Expected EPS CAGR">
          {NAPKIN_EXPECTED_CAGR_PRESETS.map((rate) => {
            const on = Math.abs(expected - rate) < 1e-9 && custom === "";
            return (
              <button
                key={rate}
                type="button"
                className={`napkin-cagr-chip${on ? " is-on" : ""}`}
                aria-pressed={on}
                onClick={() => pick(rate)}
              >
                {`[ ${formatNapkinPctWhole(rate)} ]`}
              </button>
            );
          })}
        </div>
        <label className="napkin-cagr-custom">
          <input
            type="number"
            min={-99}
            max={200}
            step={0.1}
            inputMode="decimal"
            placeholder="25"
            value={custom}
            onChange={(e) => {
              const raw = e.target.value;
              setCustom(raw);
              const n = Number(raw);
              if (raw.trim() !== "" && Number.isFinite(n)) setExpected(n / 100);
            }}
          />
          <span>%</span>
        </label>

        <dl className="napkin-dl napkin-val">
          <div className="napkin-dl-row">
            <dt>Growth vs Required</dt>
            <dd>{formatNapkinPct(fwd.vs_required, true)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Growth vs Historical</dt>
            <dd>{formatNapkinPct(fwd.vs_historical, true)}</dd>
          </div>
        </dl>
      </div>

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">{years}-year scenario</h2>
        <dl className="napkin-dl napkin-val">
          <div className="napkin-dl-row">
            <dt>Current EPS</dt>
            <dd>{formatNapkinRupee(fwd.eps_now)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Expected EPS CAGR</dt>
            <dd>{formatNapkinPctWhole(fwd.expected_cagr)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>EPS in {years} years</dt>
            <dd>{formatNapkinRupee(fwd.eps_end)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Current P/E</dt>
            <dd>{napkinPeDisplay(fwd.pe != null ? fwd.pe.toFixed(1) : "N/A")}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Exit P/E</dt>
            <dd>{napkinPeDisplay(fwd.pe != null ? fwd.pe.toFixed(1) : "N/A")}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Implied price</dt>
            <dd>{formatNapkinRupee(fwd.implied_price)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Current price</dt>
            <dd>{formatNapkinRupee(fwd.price_now)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Implied price CAGR</dt>
            <dd>{formatNapkinPct(fwd.price_cagr)}</dd>
          </div>
        </dl>
      </div>

      <NapkinBuyPrice ticker={data.ticker} eps={eps} price={price} currentPe={pe} />

      {notes.length ? (
        <div className="napkin-sheet-section napkin-warns">
          {notes.map((note) => (
            <p key={note}>⚠ {note}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}

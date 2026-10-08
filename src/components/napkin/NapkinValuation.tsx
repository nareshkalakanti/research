"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_NAPKIN_CONFIG,
  NAPKIN_DEFAULT_EXPECTED_CAGR,
  NAPKIN_EXPECTED_CAGR_PRESETS,
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
import { napkinPathCase } from "@/lib/napkin/composite";
import {
  NAPKIN_DEFAULT_TARGET_RETURN,
  NAPKIN_TARGET_RETURN_PRESETS,
  NAPKIN_BUY_YEARS,
} from "@/lib/napkin/buy-price";

export function NapkinValuation({ data }: { data: NapkinResearch }) {
  const [expected, setExpected] = useState(NAPKIN_DEFAULT_EXPECTED_CAGR);
  const [custom, setCustom] = useState("");
  const [target, setTarget] = useState(NAPKIN_DEFAULT_TARGET_RETURN);
  const pe = parseDisplayedPe(napkinPeDisplay(napkinMetric(data.overview, "pe")));
  const [exitPe, setExitPe] = useState<number | null>(pe);
  const [exitText, setExitText] = useState("");

  useEffect(() => {
    setExpected(NAPKIN_DEFAULT_EXPECTED_CAGR);
    setCustom("");
    setTarget(NAPKIN_DEFAULT_TARGET_RETURN);
    setExitPe(pe);
    setExitText("");
  }, [data.ticker, pe]);

  const hist5 = napkinMetric(data.financials, "eps5");
  const hist3 = napkinMetric(data.financials, "eps3");
  const historical = hist5 !== "N/A" ? hist5 : hist3;
  const eps = parseDisplayedMoney(napkinMetric(data.overview, "eps"));
  const price = parseDisplayedMoney(napkinMetric(data.overview, "price"));
  const requiredRatio = napkinRequiredEpsCagr(pe);
  const histRatio = parseDisplayedPct(historical);
  const years = NAPKIN_BUY_YEARS;
  const path = napkinPathCase({
    eps,
    price,
    pe,
    expected_cagr: expected,
    exit_pe: exitPe,
    target_return: target,
    years,
  });
  const notes = napkinMathNotes({
    historicalEpsCagr: historical,
    usedFiveYear: hist5 !== "N/A",
    aboveHistory:
      histRatio != null && expected - histRatio >= DEFAULT_NAPKIN_CONFIG.pass_gap_pp / 100,
  });
  const usingCurrent =
    pe != null && exitPe != null && Math.abs(exitPe - pe) < 1e-9;

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
            <dt>Napkin Factor</dt>
            <dd>30%</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Holding period</dt>
            <dd>{years} years</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Required EPS CAGR</dt>
            <dd>{formatNapkinPct(requiredRatio)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Historical EPS CAGR</dt>
            <dd>{historical}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Growth Gap (hist − required)</dt>
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
      </div>

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Your assumptions</h2>
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

        <p className="napkin-cagr-label">Target annual return</p>
        <div className="napkin-cagr-chips" role="group" aria-label="Target annual return">
          {NAPKIN_TARGET_RETURN_PRESETS.map((rate) => {
            const on = Math.abs(target - rate) < 1e-9;
            return (
              <button
                key={rate}
                type="button"
                className={`napkin-cagr-chip${on ? " is-on" : ""}`}
                aria-pressed={on}
                onClick={() => setTarget(rate)}
              >
                {`[ ${formatNapkinPctWhole(rate)} ]`}
              </button>
            );
          })}
        </div>

        <p className="napkin-cagr-label">Exit P/E</p>
        <div className="napkin-cagr-chips">
          <button
            type="button"
            className={`napkin-cagr-chip${usingCurrent ? " is-on" : ""}`}
            aria-pressed={usingCurrent}
            onClick={() => {
              setExitPe(pe);
              setExitText("");
            }}
          >
            [ Current P/E ]
          </button>
          <label className="napkin-cagr-custom">
            <input
              type="number"
              min={0}
              step={0.1}
              inputMode="decimal"
              placeholder={pe != null ? String(pe) : "P/E"}
              value={exitText}
              onChange={(e) => {
                const raw = e.target.value;
                setExitText(raw);
                const n = Number(raw);
                if (raw.trim() !== "" && Number.isFinite(n) && n > 0) setExitPe(n);
              }}
            />
            <span>x</span>
          </label>
        </div>

        <dl className="napkin-dl napkin-val">
          <div className="napkin-dl-row">
            <dt>Growth vs Required</dt>
            <dd>{formatNapkinPct(path.growth_gap, true)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Growth vs Historical</dt>
            <dd>
              {formatNapkinPct(
                histRatio != null ? expected - histRatio : null,
                true,
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">{years}-year path</h2>
        <dl className="napkin-dl napkin-val">
          <div className="napkin-dl-row">
            <dt>Current EPS</dt>
            <dd>{formatNapkinRupee(eps)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Expected EPS CAGR</dt>
            <dd>{formatNapkinPctWhole(expected)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>EPS in {years} years</dt>
            <dd>{formatNapkinRupee(path.case.future_eps)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Current P/E</dt>
            <dd>{napkinPeDisplay(pe != null ? pe.toFixed(1) : "N/A")}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Exit P/E</dt>
            <dd>{napkinPeDisplay(exitPe != null ? exitPe.toFixed(1) : "N/A")}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Future Value</dt>
            <dd>{formatNapkinRupee(path.case.future_price)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Current Price</dt>
            <dd>{formatNapkinRupee(price)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Implied Price CAGR</dt>
            <dd>{formatNapkinPct(path.case.implied_cagr)}</dd>
          </div>
        </dl>
      </div>

      <NapkinBuyPrice
        ticker={data.ticker}
        eps={eps}
        price={price}
        pe={pe}
        expected={expected}
        target={target}
        exitPe={exitPe}
        years={years}
      />

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

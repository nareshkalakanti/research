"use client";

import { useEffect, useState } from "react";
import {
  NAPKIN_BUY_SENSITIVITY_CAGRS,
  NAPKIN_BUY_SENSITIVITY_PES,
  NAPKIN_BUY_YEARS,
  NAPKIN_DEFAULT_TARGET_RETURN,
  NAPKIN_TARGET_RETURN_PRESETS,
  napkinBuyCase,
  napkinBuyPricePosition,
  napkinIllustrativeBuyRows,
} from "@/lib/napkin/buy-price";
import {
  NAPKIN_DEFAULT_EXPECTED_CAGR,
  NAPKIN_EXPECTED_CAGR_PRESETS,
} from "@/lib/napkin/engine";
import {
  formatNapkinPct,
  formatNapkinPctWhole,
  formatNapkinRupee,
  napkinPeDisplay,
} from "@/lib/napkin/format";

export function NapkinBuyPrice({
  ticker,
  eps,
  price,
  currentPe,
}: {
  ticker: string;
  eps: number | null;
  price: number | null;
  currentPe: number | null;
}) {
  const [expected, setExpected] = useState(NAPKIN_DEFAULT_EXPECTED_CAGR);
  const [target, setTarget] = useState(NAPKIN_DEFAULT_TARGET_RETURN);
  const [exitPe, setExitPe] = useState<number | null>(currentPe);
  const [exitText, setExitText] = useState("");

  useEffect(() => {
    setExpected(NAPKIN_DEFAULT_EXPECTED_CAGR);
    setTarget(NAPKIN_DEFAULT_TARGET_RETURN);
    setExitPe(currentPe);
    setExitText("");
  }, [ticker, currentPe]);

  const years = NAPKIN_BUY_YEARS;
  const quote = napkinBuyCase({
    eps,
    price,
    expected_cagr: expected,
    exit_pe: exitPe,
    target_return: target,
    years,
  });
  const usingCurrent =
    currentPe != null && exitPe != null && Math.abs(exitPe - currentPe) < 1e-9;

  return (
    <div className="napkin-sheet-section">
      <h2 className="napkin-block-title">Buy price / target return</h2>

      <p className="napkin-cagr-label">Expected EPS CAGR</p>
      <div className="napkin-cagr-chips" role="group" aria-label="Buy expected EPS CAGR">
        {NAPKIN_EXPECTED_CAGR_PRESETS.map((rate) => {
          const on = Math.abs(expected - rate) < 1e-9;
          return (
            <button
              key={rate}
              type="button"
              className={`napkin-cagr-chip${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() => setExpected(rate)}
            >
              {`[ ${formatNapkinPctWhole(rate)} ]`}
            </button>
          );
        })}
      </div>

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

      <p className="napkin-cagr-label">Investment horizon</p>
      <p className="napkin-debug">{years} years</p>

      <p className="napkin-cagr-label">Expected exit P/E</p>
      <div className="napkin-cagr-chips">
        <button
          type="button"
          className={`napkin-cagr-chip${usingCurrent ? " is-on" : ""}`}
          aria-pressed={usingCurrent}
          onClick={() => {
            setExitPe(currentPe);
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
            placeholder={currentPe != null ? String(currentPe) : "P/E"}
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
          <dt>Expected EPS CAGR</dt>
          <dd>{formatNapkinPctWhole(expected)}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>Target annual return</dt>
          <dd>{formatNapkinPctWhole(target)}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>Expected exit P/E</dt>
          <dd>{napkinPeDisplay(exitPe != null ? exitPe.toFixed(1) : "N/A")}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>Current EPS</dt>
          <dd>{formatNapkinRupee(eps)}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>EPS in {years} years</dt>
          <dd>{formatNapkinRupee(quote.future_eps)}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>Expected price</dt>
          <dd>{formatNapkinRupee(quote.future_price)}</dd>
        </div>
      </dl>

      <div className="napkin-buy-hero">
        <div className="napkin-buy-kicker">Maximum buy price</div>
        <div className="napkin-buy-value">{formatNapkinRupee(quote.buy_price)}</div>
        <p className="napkin-buy-note">
          If these assumptions hold, this is about the most you can pay today and
          still earn the target annual return over {years} years.
        </p>
      </div>

      <dl className="napkin-dl napkin-val">
        <div className="napkin-dl-row">
          <dt>Current price</dt>
          <dd>{formatNapkinRupee(price)}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>Upside to expected price</dt>
          <dd>{formatNapkinPct(quote.upside, true)}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>Expected annual return</dt>
          <dd>{formatNapkinPct(quote.implied_cagr)}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>Maximum buy price</dt>
          <dd>{formatNapkinRupee(quote.buy_price)}</dd>
        </div>
        <div className="napkin-dl-row">
          <dt>Difference %</dt>
          <dd>{formatNapkinPct(quote.price_gap, true)}</dd>
        </div>
      </dl>
      {napkinBuyPricePosition(quote.price_gap) ? (
        <p className="napkin-debug">{napkinBuyPricePosition(quote.price_gap)}</p>
      ) : null}

      <h3 className="napkin-subhead">Buy price sensitivity</h3>
      <p className="napkin-cagr-label">
        Maximum buy price at target return {formatNapkinPctWhole(target)}
      </p>
      <div className="napkin-table-wrap">
        <table className="napkin-table napkin-table--nums">
          <thead>
            <tr>
              <th>Expected CAGR</th>
              {NAPKIN_BUY_SENSITIVITY_PES.map((pe) => (
                <th key={pe}>{pe}x</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NAPKIN_BUY_SENSITIVITY_CAGRS.map((cagr) => (
              <tr
                key={cagr}
                className={Math.abs(cagr - expected) < 1e-9 ? "is-on" : undefined}
              >
                <td>{formatNapkinPctWhole(cagr)}</td>
                {NAPKIN_BUY_SENSITIVITY_PES.map((pe) => {
                  const cell = napkinBuyCase({
                    eps,
                    price,
                    expected_cagr: cagr,
                    exit_pe: pe,
                    target_return: target,
                    years,
                  });
                  return <td key={pe}>{formatNapkinRupee(cell.buy_price)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="napkin-subhead">Bear / base / bull</h3>
      <p className="napkin-debug">Illustrative scenarios based on user assumptions.</p>
      <div className="napkin-table-wrap">
        <table className="napkin-table napkin-table--nums">
          <thead>
            <tr>
              <th>Scenario</th>
              <th>EPS CAGR</th>
              <th>Exit P/E</th>
              <th>5Y EPS</th>
              <th>5Y price</th>
              <th>Maximum buy price</th>
            </tr>
          </thead>
          <tbody>
            {napkinIllustrativeBuyRows({ eps, price, target_return: target }).map((row) => (
              <tr key={row.name}>
                <td>{row.name}</td>
                <td>{formatNapkinPctWhole(row.expected_cagr)}</td>
                <td>{napkinPeDisplay(row.exit_pe.toFixed(1))}</td>
                <td>{formatNapkinRupee(row.case.future_eps)}</td>
                <td>{formatNapkinRupee(row.case.future_price)}</td>
                <td>{formatNapkinRupee(row.case.buy_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

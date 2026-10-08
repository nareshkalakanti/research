"use client";

import {
  napkinIllustrativeBuyRows,
} from "@/lib/napkin/buy-price";
import {
  napkinCompositeVerdict,
  napkinEntryPriceStatus,
  napkinExpectedCagrSensitivityRows,
  napkinExitPeSensitivityRows,
  napkinFactorSensitivityRows,
  napkinPathCase,
} from "@/lib/napkin/composite";
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
  pe,
  expected,
  target,
  exitPe,
  years,
}: {
  ticker: string;
  eps: number | null;
  price: number | null;
  pe: number | null;
  expected: number;
  target: number;
  exitPe: number | null;
  years: number;
}) {
  void ticker;
  const path = napkinPathCase({
    eps,
    price,
    pe,
    expected_cagr: expected,
    exit_pe: exitPe,
    target_return: target,
    years,
  });
  const quote = path.case;
  const status = napkinEntryPriceStatus(price, quote.buy_price);
  const verdict = napkinCompositeVerdict({
    expected_cagr: expected,
    required_cagr: path.required_cagr,
    price_cagr: quote.implied_cagr,
    target_return: target,
    max_pay: quote.buy_price,
    price,
  });
  const factorRows = napkinFactorSensitivityRows({
    pe,
    expected_cagr: expected,
    eps,
    price,
    exit_pe: exitPe,
    target_return: target,
    years,
  });
  const growthRows = napkinExpectedCagrSensitivityRows({
    eps,
    price,
    exit_pe: exitPe,
    target_return: target,
    years,
    current_cagr: expected,
  });
  const peRows =
    exitPe != null
      ? napkinExitPeSensitivityRows({
          eps,
          price,
          expected_cagr: expected,
          target_return: target,
          years,
          current_exit_pe: exitPe,
        })
      : [];

  return (
    <>
      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Entry price</h2>
        <div className="napkin-entry-box">
          <div className="napkin-entry-left">
            <div>
              <div className="napkin-buy-kicker">Max entry price</div>
              <div className="napkin-buy-value">{formatNapkinRupee(quote.buy_price)}</div>
            </div>
            {status ? (
              <span className={`napkin-entry-status napkin-entry-status--${status.tone}`}>
                {status.label}
              </span>
            ) : null}
          </div>
          <p className="napkin-buy-note">
            Maximum price today for the selected target return if expected EPS
            CAGR, exit P/E and holding period hold. Not a recommendation.
          </p>
        </div>
        <dl className="napkin-dl napkin-val">
          <div className="napkin-dl-row">
            <dt>Spot</dt>
            <dd>{formatNapkinRupee(price)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Target return</dt>
            <dd>{formatNapkinPctWhole(target)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Max pay vs spot</dt>
            <dd>{formatNapkinPct(path.max_pay_vs_spot, true)}</dd>
          </div>
        </dl>
      </div>

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Composite verdict</h2>
        {verdict ? (
          <div className={`napkin-composite napkin-composite--${verdict.label.toLowerCase().replace(/ /g, "-")}`}>
            <div className="napkin-composite-label">{verdict.label}</div>
            <p className="napkin-composite-note">{verdict.note}</p>
          </div>
        ) : (
          <p className="napkin-debug">N/A — missing inputs for a composite verdict.</p>
        )}
      </div>

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Margin of safety / premium</h2>
        <dl className="napkin-dl napkin-val">
          <div className="napkin-dl-row">
            <dt>Max entry price</dt>
            <dd>{formatNapkinRupee(quote.buy_price)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>Spot</dt>
            <dd>{formatNapkinRupee(price)}</dd>
          </div>
          <div className="napkin-dl-row">
            <dt>MOS / Premium</dt>
            <dd>{formatNapkinPct(path.max_pay_vs_spot, true)}</dd>
          </div>
        </dl>
        <p className="napkin-debug">
          Positive = discount to calculated Max Entry. Negative = premium above
          it. Not a guaranteed margin of safety.
        </p>
      </div>

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Sensitivity</h2>

        <h3 className="napkin-subhead">Napkin Factor</h3>
        <div className="napkin-table-wrap">
          <table className="napkin-table napkin-table--nums">
            <thead>
              <tr>
                <th>Factor</th>
                <th>Required CAGR</th>
                <th>Max Entry</th>
                <th>vs Spot</th>
              </tr>
            </thead>
            <tbody>
              {factorRows.map((r) => (
                <tr key={r.factor} className={r.current ? "is-on" : undefined}>
                  <td>{formatNapkinPctWhole(r.factor)}</td>
                  <td>{formatNapkinPct(r.required_cagr)}</td>
                  <td>{formatNapkinRupee(r.max_pay)}</td>
                  <td>{formatNapkinPct(r.vs_spot, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="napkin-subhead">Expected EPS CAGR</h3>
        <div className="napkin-table-wrap">
          <table className="napkin-table napkin-table--nums">
            <thead>
              <tr>
                <th>Growth</th>
                <th>Future EPS</th>
                <th>Future Value</th>
                <th>Price CAGR</th>
                <th>Max Entry</th>
                <th>vs Spot</th>
              </tr>
            </thead>
            <tbody>
              {growthRows.map((r) => (
                <tr key={r.expected_cagr} className={r.current ? "is-on" : undefined}>
                  <td>{formatNapkinPctWhole(r.expected_cagr)}</td>
                  <td>{formatNapkinRupee(r.future_eps)}</td>
                  <td>{formatNapkinRupee(r.future_value)}</td>
                  <td>{formatNapkinPct(r.price_cagr)}</td>
                  <td>{formatNapkinRupee(r.max_pay)}</td>
                  <td>{formatNapkinPct(r.vs_spot, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="napkin-subhead">Exit P/E</h3>
        <div className="napkin-table-wrap">
          <table className="napkin-table napkin-table--nums">
            <thead>
              <tr>
                <th>Exit P/E</th>
                <th>Future Value</th>
                <th>Price CAGR</th>
                <th>Max Entry</th>
                <th>vs Spot</th>
              </tr>
            </thead>
            <tbody>
              {peRows.map((r) => (
                <tr key={r.exit_pe} className={r.current ? "is-on" : undefined}>
                  <td>{napkinPeDisplay(r.exit_pe.toFixed(1))}</td>
                  <td>{formatNapkinRupee(r.future_value)}</td>
                  <td>{formatNapkinPct(r.price_cagr)}</td>
                  <td>{formatNapkinRupee(r.max_pay)}</td>
                  <td>{formatNapkinPct(r.vs_spot, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="napkin-sheet-section">
        <h3 className="napkin-subhead">Scenario range</h3>
        <p className="napkin-debug">Illustrative paths from the selected target return.</p>
        <div className="napkin-table-wrap">
          <table className="napkin-table napkin-table--nums">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>EPS CAGR</th>
                <th>Exit P/E</th>
                <th>Future Value</th>
                <th>Price CAGR</th>
                <th>Max Entry</th>
              </tr>
            </thead>
            <tbody>
              {napkinIllustrativeBuyRows({ eps, price, target_return: target }).map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{formatNapkinPctWhole(row.expected_cagr)}</td>
                  <td>{napkinPeDisplay(row.exit_pe.toFixed(1))}</td>
                  <td>{formatNapkinRupee(row.case.future_price)}</td>
                  <td>{formatNapkinPct(row.case.implied_cagr)}</td>
                  <td>{formatNapkinRupee(row.case.buy_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

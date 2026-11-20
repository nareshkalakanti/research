"use client";

import { formatNapkinPctWhole, formatNapkinRupee } from "@/lib/napkin/format";
import type { NapkinBuyCase } from "@/lib/napkin/buy-price";

type Status = { label: string; tone: string } | null;

function pctText(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const p = v * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(digits)}%`;
}

function toneOf(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "";
  return v >= 0 ? " is-up" : " is-down";
}

/** Price ruler: where today's price sits between max entry and 5-year value. */
function PriceRuler({ entry, price, future }: { entry: number | null; price: number | null; future: number | null }) {
  const pts = [
    { k: "entry", label: "Max entry", v: entry },
    { k: "price", label: "Today", v: price },
    { k: "future", label: "In 5 yrs", v: future },
  ].filter((p): p is { k: string; label: string; v: number } => p.v != null && Number.isFinite(p.v) && p.v > 0);
  if (pts.length < 2) return null;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const span = hi - lo || 1;
  const pos = (v: number) => 4 + ((v - lo) / span) * 92;
  return (
    <div className="nph-ruler" aria-hidden>
      <div className="nph-ruler-track">
        <span className="nph-ruler-fill" style={{ left: `${pos(lo)}%`, width: `${pos(hi) - pos(lo)}%` }} />
        {pts.map((p) => (
          <span
            key={p.k}
            className={`nph-ruler-pin nph-ruler-pin--${p.k}${pos(p.v) < 20 ? " is-start" : pos(p.v) > 80 ? " is-end" : ""}`}
            style={{ left: `${pos(p.v)}%` }}
          >
            <span className="nph-ruler-dot" />
            <span className="nph-ruler-tag">
              {p.label} <b>{formatNapkinRupee(p.v)}</b>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function NapkinHero({
  price,
  pe,
  eps,
  expected,
  exitPe,
  target,
  years,
  growthSource,
  quote,
  status,
}: {
  price: number | null;
  pe: number | null;
  eps: number | null;
  expected: number;
  exitPe: number | null;
  target: number;
  years: number;
  growthSource: string;
  quote: NapkinBuyCase;
  status: Status;
}) {
  const discount = Math.pow(1 + target, years);
  const entryVsPrice = quote.buy_price != null && price ? quote.buy_price / price - 1 : null;
  const fmtPe = (v: number | null) => (v != null && Number.isFinite(v) ? `${v.toFixed(1)}×` : "N/A");

  return (
    <section className="nph" aria-label="Napkin summary">
      <div className="nph-tiles">
        <div className="nph-tile">
          <div className="nph-label">Current price</div>
          <div className="nph-value">{formatNapkinRupee(price)}</div>
          <div className="nph-sub">
            P/E {fmtPe(pe)} · EPS {formatNapkinRupee(eps)}
          </div>
        </div>

        <div className="nph-tile">
          <div className="nph-label">Value in {years} years</div>
          <div className="nph-value">{formatNapkinRupee(quote.future_price)}</div>
          <div className={`nph-sub${toneOf(quote.upside)}`}>
            {pctText(quote.upside)} total · {pctText(quote.implied_cagr, 1)} a year
          </div>
        </div>

        <div className={`nph-tile nph-tile--key nph-tile--${status?.tone ?? "none"}`}>
          <div className="nph-label">Max entry price</div>
          <div className="nph-value">{formatNapkinRupee(quote.buy_price)}</div>
          <div className="nph-sub nph-sub--row">
            {status ? <span className={`nph-pill nph-pill--${status.tone}`}>{status.label.toLowerCase()}</span> : null}
            {entryVsPrice != null ? (
              <span>
                {entryVsPrice >= 0 ? `${Math.round(entryVsPrice * 100)}% above today` : `${Math.round(-entryVsPrice * 100)}% below today`}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <PriceRuler entry={quote.buy_price} price={price} future={quote.future_price} />

      <div className="nph-how">
        <div className="nph-how-title">How Napkin gets these numbers</div>
        <ol className="nph-steps">
          <li>
            <span className="nph-step-n">1</span>
            <div>
              <b>Grow the earnings.</b> EPS {formatNapkinRupee(eps)} growing {formatNapkinPctWhole(expected)} a year
              ({growthSource}) for {years} years becomes <b>{formatNapkinRupee(quote.future_eps)}</b>.
            </div>
          </li>
          <li>
            <span className="nph-step-n">2</span>
            <div>
              <b>Put a price on it.</b> {formatNapkinRupee(quote.future_eps)} × exit P/E {fmtPe(exitPe)} ={" "}
              <b>{formatNapkinRupee(quote.future_price)}</b>, the share&apos;s value in {years} years.
            </div>
          </li>
          <li>
            <span className="nph-step-n">3</span>
            <div>
              <b>Work back to today.</b> To earn {formatNapkinPctWhole(target)} a year, pay at most{" "}
              {formatNapkinRupee(quote.future_price)} ÷ {discount.toFixed(2)} = <b>{formatNapkinRupee(quote.buy_price)}</b>.
            </div>
          </li>
        </ol>
        {quote.implied_cagr != null && price != null ? (
          <p className="nph-verdict">
            Buying at today&apos;s {formatNapkinRupee(price)} would return about{" "}
            <b className={toneOf(quote.implied_cagr - target).trim()}>{pctText(quote.implied_cagr, 1)} a year</b> if these
            assumptions hold — {quote.implied_cagr >= target ? "at or above" : "below"} your {formatNapkinPctWhole(target)} target.
            Change growth, target or exit P/E below to test it.
          </p>
        ) : null}
      </div>
    </section>
  );
}

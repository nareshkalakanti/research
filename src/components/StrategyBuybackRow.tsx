"use client";

import {
  StrategyExpandDetail,
  type StrategyExpandPanel,
  type StrategyRowLinks,
} from "@/components/StrategyExpandDetail";
import { StrategyCompanyCell } from "@/components/StrategyCompanyCell";
import { formatMcap } from "@/lib/types";

export type StrategyBuybackRowData = {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  price: number | null;
  latest_date: string | null;
  latest_status: string | null;
  buyback_method: string;
  max_price: number | null;
  pct_equity: number | null;
  spread_pct: number | null;
  buyback_score: number;
  reason: string;
} & StrategyRowLinks;

function methodLabel(method: string): string {
  if (method === "tender") return "Tender";
  if (method === "open_market") return "Open mkt";
  return "—";
}

function fmtPrice(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

const COL_SPAN = 11;

type Props = {
  row: StrategyBuybackRowData;
  open: boolean;
  panel: StrategyExpandPanel;
  onToggle: () => void;
  onPanel: (panel: StrategyExpandPanel) => void;
};

export function StrategyBuybackRow({
  row: r,
  open,
  panel,
  onToggle,
  onPanel,
}: Props) {
  return (
    <>
      <tr className={open ? "row-open" : undefined}>
        <td className="col-name">
          <StrategyCompanyCell
            name={r.name}
            ticker={r.ticker}
            open={open}
            onToggle={onToggle}
          />
        </td>
        <td className="num col-mcap_cr">{formatMcap(r.market_cap_cr)}</td>
        <td className="num">{r.buyback_score}</td>
        <td>{methodLabel(r.buyback_method)}</td>
        <td>{r.latest_date || "—"}</td>
        <td className="num col-price">
          <button type="button" className="price-btn" onClick={onToggle}>
            {fmtPrice(r.price)}
          </button>
        </td>
        <td className="num">
          {r.max_price != null ? r.max_price.toLocaleString("en-IN") : "—"}
        </td>
        <td className="num">
          {r.spread_pct != null ? (
            <span
              className={r.spread_pct >= 8 ? "strategy-spread-hot" : undefined}
            >
              {r.spread_pct.toFixed(1)}%
            </span>
          ) : (
            "—"
          )}
        </td>
        <td className="num">{r.pct_equity != null ? `${r.pct_equity}%` : "—"}</td>
        <td>{r.latest_status || "—"}</td>
        <td className="strategy-reason">{r.reason}</td>
      </tr>
      <StrategyExpandDetail
        ticker={r.ticker}
        name={r.name}
        market={r.market}
        price={r.price}
        links={{ sc: r.sc, tv: r.tv, web: r.web }}
        open={open}
        panel={panel}
        onPanel={onPanel}
        colSpan={COL_SPAN}
      />
    </>
  );
}

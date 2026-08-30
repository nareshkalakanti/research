"use client";

import {
  StrategyExpandDetail,
  type StrategyExpandPanel,
  type StrategyRowLinks,
} from "@/components/StrategyExpandDetail";
import { StrategyCompanyCell } from "@/components/StrategyCompanyCell";
import { formatMcap } from "@/lib/types";

export type StrategyLiquidityRowData = {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  price: number | null;
  avg_value_20d_lakh: number | null;
  avg_value_60d_lakh: number | null;
  ramp_ratio: number | null;
  liquidity_score: number;
  reason: string;
} & StrategyRowLinks;

function fmtPrice(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

const COL_SPAN = 7;

type Props = {
  row: StrategyLiquidityRowData;
  open: boolean;
  panel: StrategyExpandPanel;
  onToggle: () => void;
  onPanel: (panel: StrategyExpandPanel) => void;
};

export function StrategyLiquidityRow({
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
        <td className="num">{r.liquidity_score}</td>
        <td className="num col-price">
          <button type="button" className="price-btn" onClick={onToggle}>
            {fmtPrice(r.price)}
          </button>
        </td>
        <td className="num">{r.avg_value_20d_lakh?.toFixed(1) ?? "—"}</td>
        <td className="num">{r.avg_value_60d_lakh?.toFixed(1) ?? "—"}</td>
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

"use client";

import { ExpandBusiness } from "@/components/ExpandBusiness";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { useExpandBrief } from "@/lib/use-expand-brief";
import { useExpandQuarters } from "@/lib/use-expand-quarters";

export type StrategyExpandPanel = "qtr" | "about";

export type StrategyRowLinks = {
  sc: string;
  tv: string;
  web: string | null;
};

type Props = {
  ticker: string;
  name: string;
  market: string;
  price: number | null;
  links: StrategyRowLinks;
  open: boolean;
  panel: StrategyExpandPanel;
  onPanel: (panel: StrategyExpandPanel) => void;
  colSpan: number;
};

export function StrategyExpandDetail({
  ticker,
  name: _name,
  market,
  price,
  links: _links,
  open,
  panel,
  onPanel,
  colSpan,
}: Props) {
  const quarterData = useExpandQuarters(ticker, market, price, open);
  const briefData = useExpandBrief(
    ticker,
    market,
    price,
    quarterData,
    open && panel === "about",
  );
  const active: StrategyExpandPanel =
    panel === "qtr" || panel === "about" ? panel : "about";

  if (!open) return null;

  return (
    <tr className="about-row">
      <td colSpan={colSpan}>
        <div className="about-box strategy-expand">
          <div className="about-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={active === "about"}
              className={`about-tab ${active === "about" ? "on" : ""}`}
              onClick={() => onPanel("about")}
            >
              About
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={active === "qtr"}
              className={`about-tab ${active === "qtr" ? "on" : ""}`}
              onClick={() => onPanel("qtr")}
            >
              Qtr
            </button>
          </div>
          {active === "about" ? (
            <ExpandBusiness data={briefData} />
          ) : (
            <ExpandQuarters data={quarterData} price={price} />
          )}
        </div>
      </td>
    </tr>
  );
}

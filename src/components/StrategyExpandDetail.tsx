"use client";

import { ExpandBusiness } from "@/components/ExpandBusiness";
import { ExpandExtraMetrics } from "@/components/ExpandExtraMetrics";
import { ExpandMetricsStrip } from "@/components/ExpandMetricsStrip";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { useExpandBrief } from "@/lib/use-expand-brief";
import { useExpandQuarters } from "@/lib/use-expand-quarters";

export type StrategyExpandPanel = "qtr" | "business";

export type StrategyRowLinks = {
  sc: string;
  tv: string;
  web: string | null;
};

function StrategyExpandLinks({ links }: { links: StrategyRowLinks }) {
  return (
    <div className="link-row link-row--compact">
      {links.web ? (
        <a
          href={links.web}
          target="_blank"
          rel="noopener noreferrer"
          className="link-chip"
        >
          Web
        </a>
      ) : (
        <span className="link-chip disabled">Web</span>
      )}
      <a
        href={links.sc}
        target="_blank"
        rel="noopener noreferrer"
        className="link-chip"
      >
        SC
      </a>
      <a
        href={links.tv}
        target="_blank"
        rel="noopener noreferrer"
        className="link-chip"
      >
        TV
      </a>
    </div>
  );
}

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
  name,
  market,
  price,
  links,
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
    open && panel === "business",
  );

  if (!open) return null;

  return (
    <tr className="about-row">
      <td colSpan={colSpan}>
        <div className="about-box">
          <div className="strategy-expand-head">
            <div className="strategy-expand-identity">
              <span className="strategy-expand-ticker">{ticker}</span>
              <span className="strategy-expand-name">{name}</span>
            </div>
            <StrategyExpandLinks links={links} />
          </div>
          <ExpandMetricsStrip
            forwardPe={quarterData.forward_pe}
            epsYoY={quarterData.yoy?.eps_yoy}
            loading={quarterData.loading}
            empty={
              !quarterData.loading &&
              !quarterData.error &&
              !quarterData.panel &&
              quarterData.forward_pe == null &&
              quarterData.yoy?.eps_yoy == null
            }
          />
          <ExpandExtraMetrics extras={quarterData.extras} />
          <div className="about-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={panel === "qtr"}
              className={`about-tab ${panel === "qtr" ? "on" : ""}`}
              onClick={() => onPanel("qtr")}
            >
              Qtr
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === "business"}
              className={`about-tab ${panel === "business" ? "on" : ""}`}
              onClick={() => onPanel("business")}
            >
              Business
            </button>
          </div>
          {panel === "qtr" ? (
            <ExpandQuarters data={quarterData} price={price} />
          ) : (
            <ExpandBusiness data={briefData} />
          )}
        </div>
      </td>
    </tr>
  );
}

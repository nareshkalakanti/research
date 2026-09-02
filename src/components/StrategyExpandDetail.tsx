"use client";

import { ExpandInvestorMaterials } from "@/components/ExpandInvestorMaterials";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { fmtYoYPct, yoyClass } from "@/lib/quarter-panel";
import { useExpandQuarters } from "@/lib/use-expand-quarters";
import { formatPeDisplay, forwardPeClass } from "@/lib/valuation";

export type StrategyExpandPanel = "qtr" | "docs" | "highlights";

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
  showFilingTabs?: boolean;
  highlights?: string[];
  docsFetching?: boolean;
  docsError?: string | null;
  onFetchDocs?: () => void;
  onDocsChange?: () => void;
};

function fmtLtp(n: number | null): string {
  if (n == null) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function StrategyExpandDetail({
  ticker,
  name: _name,
  market,
  price,
  links,
  open,
  panel,
  onPanel,
  colSpan,
  showFilingTabs = false,
  highlights = [],
  docsFetching = false,
  docsError = null,
  onFetchDocs,
  onDocsChange,
}: Props) {
  const quarterData = useExpandQuarters(ticker, market, price, open);
  const active: StrategyExpandPanel =
    showFilingTabs || panel === "qtr" ? panel : "qtr";

  if (!open) return null;

  return (
    <tr className="about-row">
      <td colSpan={colSpan}>
        <div className="about-box strategy-expand">
          <div className="sx-kpis">
            <Kpi label="LTP" value={fmtLtp(price)} />
            <Kpi
              label="Fwd PE"
              value={
                quarterData.loading
                  ? "…"
                  : quarterData.forward_pe != null
                    ? formatPeDisplay(quarterData.forward_pe)
                    : "—"
              }
              tone={
                quarterData.forward_pe != null
                  ? forwardPeClass(quarterData.forward_pe)
                  : undefined
              }
            />
            <Kpi
              label="EPS YoY"
              value={
                quarterData.loading
                  ? "…"
                  : quarterData.yoy?.eps_yoy != null
                    ? fmtYoYPct(quarterData.yoy.eps_yoy)
                    : "—"
              }
              tone={
                quarterData.yoy?.eps_yoy != null
                  ? yoyClass(quarterData.yoy.eps_yoy)
                  : undefined
              }
            />
            <Kpi
              label="QoQ Sales"
              value={
                quarterData.loading
                  ? "…"
                  : quarterData.extras?.sales_qoq != null
                    ? fmtYoYPct(quarterData.extras.sales_qoq)
                    : "—"
              }
              tone={
                quarterData.extras?.sales_qoq != null
                  ? yoyClass(quarterData.extras.sales_qoq)
                  : undefined
              }
            />
          </div>
          <div className="link-row link-row--compact sx-links">
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
          <div className="about-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={active === "qtr"}
              className={`about-tab ${active === "qtr" ? "on" : ""}`}
              onClick={() => onPanel("qtr")}
            >
              Qtr
            </button>
            {showFilingTabs ? (
              <>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active === "docs"}
                  className={`about-tab ${active === "docs" ? "on" : ""}`}
                  onClick={() => onPanel("docs")}
                >
                  Documents
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active === "highlights"}
                  className={`about-tab ${active === "highlights" ? "on" : ""}`}
                  onClick={() => onPanel("highlights")}
                >
                  Highlights
                </button>
              </>
            ) : null}
          </div>
          {active === "docs" && showFilingTabs ? (
            <ExpandInvestorMaterials
              ticker={ticker}
              market={market}
              onMaterialsChange={onDocsChange}
            />
          ) : active === "highlights" && showFilingTabs ? (
            <ExpandHighlights
              highlights={highlights}
              fetching={docsFetching}
              error={docsError}
              onFetch={onFetchDocs}
            />
          ) : (
            <ExpandQuarters data={quarterData} price={price} />
          )}
        </div>
      </td>
    </tr>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="sx-kpi">
      <span className="sx-kpi-label">{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function ExpandHighlights({
  highlights,
  fetching,
  error,
  onFetch,
}: {
  highlights: string[];
  fetching: boolean;
  error: string | null;
  onFetch?: () => void;
}) {
  return (
    <div className="sx-hi">
      {fetching && !highlights.length ? (
        <p className="sx-docs-hint">Firecrawl + LLM running on the transcript…</p>
      ) : highlights.length ? (
        <ul>
          {highlights.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      ) : (
        <p className="sx-docs-hint">
          No highlights yet. Click to parse the latest transcript with Firecrawl, then distill
          with the LLM.
        </p>
      )}
      <button
        type="button"
        className="sx-fetch-btn"
        onClick={() => void onFetch?.()}
        disabled={fetching || !onFetch}
      >
        {fetching
          ? "Fetching…"
          : highlights.length
            ? "Refresh highlights"
            : "Get highlights"}
      </button>
      {error ? <p className="inv-mat-error">{error}</p> : null}
    </div>
  );
}

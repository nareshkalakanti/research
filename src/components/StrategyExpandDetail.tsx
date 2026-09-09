"use client";

import { ExpandInvestorMaterials } from "@/components/ExpandInvestorMaterials";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { useExpandQuarters } from "@/lib/use-expand-quarters";

export type StrategyExpandPanel = "qtr" | "docs" | "highlights" | "corp";

export type StrategyCorpEnrichment = {
  sentiment: string | null;
  sentiment_score: number | null;
  sentiment_why: string | null;
  summary: string | null;
  guidance: string | null;
  din_flags: string[];
  din_summary: string | null;
  match_din: number;
  document_url: string | null;
  concall_url: string | null;
  extract_status: string | null;
  has_extract: boolean;
  keyword?: string | null;
};

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
  corp?: StrategyCorpEnrichment | null;
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
  showFilingTabs = false,
  highlights = [],
  docsFetching = false,
  docsError = null,
  onFetchDocs,
  onDocsChange,
  corp = null,
}: Props) {
  const quarterData = useExpandQuarters(ticker, market, price, open);
  const active: StrategyExpandPanel =
    showFilingTabs || panel === "qtr" ? panel : "qtr";

  if (!open) return null;

  return (
    <tr className="about-row">
      <td colSpan={colSpan}>
        <div className="about-box strategy-expand">
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
                  Con-calls
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
                <button
                  type="button"
                  role="tab"
                  aria-selected={active === "corp"}
                  className={`about-tab ${active === "corp" ? "on" : ""}`}
                  onClick={() => onPanel("corp")}
                >
                  Corp
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
          ) : active === "corp" && showFilingTabs ? (
            <ExpandCorp ticker={ticker} corp={corp} />
          ) : (
            <ExpandQuarters data={quarterData} price={price} />
          )}
        </div>
      </td>
    </tr>
  );
}

function ExpandCorp({
  ticker,
  corp,
}: {
  ticker: string;
  corp: StrategyCorpEnrichment | null;
}) {
  if (!corp?.has_extract) {
    return (
      <div className="strategy-corp-empty">
        <p>
          No corporate extract yet for <strong>{ticker}</strong>. Run the
          corporate-data extract API to scan NSE board PDFs and concall tone
          (then Push DINs / Refresh).
        </p>
      </div>
    );
  }
  return (
    <div className="strategy-corp-detail">
      <div className="strategy-corp-meta">
        {corp.sentiment ? (
          <span className={`ann-sent-pill ann-sent-pill--${corp.sentiment === "bullish" || corp.sentiment === "optimistic" ? "bullish" : corp.sentiment === "bearish" || corp.sentiment === "cautious" ? "bearish" : "neutral"}`}>
            {corp.sentiment}
            {corp.sentiment_score != null ? ` · ${corp.sentiment_score > 0 ? "+" : ""}${corp.sentiment_score}` : ""}
          </span>
        ) : null}
        {corp.din_summary ? (
          <span className="strategy-corp-din">{corp.din_summary}</span>
        ) : null}
      </div>
      {corp.sentiment_why ? (
        <p className="strategy-corp-why">{corp.sentiment_why}</p>
      ) : null}
      {corp.summary ? (
        <div className="ann-call-row">
          <span>Summary</span>
          <p>{corp.summary}</p>
        </div>
      ) : null}
      {corp.guidance ? (
        <div className="ann-call-row">
          <span>Guidance</span>
          <p>{corp.guidance}</p>
        </div>
      ) : null}
      <div className="link-row link-row--compact">
        {corp.document_url ? (
          <a
            href={corp.document_url}
            target="_blank"
            rel="noopener noreferrer"
            className="link-chip"
          >
            Board PDF
          </a>
        ) : null}
        {corp.concall_url ? (
          <a
            href={corp.concall_url}
            target="_blank"
            rel="noopener noreferrer"
            className="link-chip"
          >
            Concall
          </a>
        ) : null}
      </div>
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

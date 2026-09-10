"use client";

import {
  buildExecSummaryView,
  fmtCr,
  fmtPct,
  type ExecSummaryView,
} from "@/lib/concall-exec-summary-view";

function YoY({ n }: { n: number | null }) {
  if (n == null) return null;
  const up = n >= 0;
  return (
    <div className="exec-sum-metric">
      <span className={up ? "exec-sum-metric-up" : "exec-sum-metric-down"}>
        {fmtPct(n, true)}
      </span>
      <span className="exec-sum-metric-label">YoY</span>
    </div>
  );
}

function CatalystList({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="exec-sum-catalyst-list">
      {items.map((t) => (
        <li key={t} className="exec-sum-catalyst-item">
          <div className="exec-sum-catalyst-check" aria-hidden>
            ✓
          </div>
          <div className="exec-sum-catalyst-text">{t}</div>
        </li>
      ))}
    </ul>
  );
}

function ExecSummaryBody({ view }: { view: ExecSummaryView }) {
  const sent = (view.sentiment || "").toUpperCase();
  const sentPos = /POSITIVE|OPTIMISTIC|BULLISH|STRONG/i.test(sent);
  const guide =
    view.revenue.guideLow != null || view.revenue.guideHigh != null
      ? `Guide: ${fmtCr(view.revenue.guideLow)}–${fmtCr(view.revenue.guideHigh)}${
          view.revenue.guideGrowth != null
            ? ` (${fmtPct(view.revenue.guideGrowth, true)})`
            : ""
        }`
      : null;

  return (
    <div className="exec-sum">
      <header className="exec-sum-header">
        <div>
          <h2 className="exec-sum-title">{view.company}</h2>
          <p className="exec-sum-subtitle">
            {[view.period && `${view.period} Earnings`, view.symbol && `NSE: ${view.symbol}`]
              .filter(Boolean)
              .join(" | ") || "Executive summary"}
          </p>
        </div>
        <div className="exec-sum-header-meta">
          {view.eventDate ? (
            <div className="exec-sum-meta-item">{view.eventDate}</div>
          ) : null}
          {view.sentiment ? (
            <div
              className={`exec-sum-sentiment ${
                sentPos ? "exec-sum-sentiment--pos" : "exec-sum-sentiment--neu"
              }`}
            >
              <span aria-hidden>●</span> {sent}
            </div>
          ) : null}
          {view.score != null ? (
            <div className="exec-sum-meta-item">
              Score: {Number(view.score).toFixed(1)}
              {view.score <= 10 ? "/10" : ""}
            </div>
          ) : null}
        </div>
      </header>

      {view.hasFinancials ? (
        <>
          <div className="exec-sum-section-h">Financial Snapshot</div>
          <div className="exec-sum-grid-4">
            <div className="exec-sum-card">
              <div className="exec-sum-card-title">Revenue</div>
              <div className="exec-sum-card-value">{fmtCr(view.revenue.value)}</div>
              <div className="exec-sum-card-meta">
                <YoY n={view.revenue.yoy} />
                {guide ? (
                  <div className="exec-sum-metric">
                    <span className="exec-sum-metric-label">{guide}</span>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="exec-sum-card">
              <div className="exec-sum-card-title">EBITDA</div>
              <div className="exec-sum-card-value">{fmtCr(view.ebitda.value)}</div>
              <div className="exec-sum-card-meta">
                <YoY n={view.ebitda.yoy} />
                {view.ebitda.margin != null ? (
                  <div className="exec-sum-metric">
                    <span className="exec-sum-metric-label">
                      Margin: {fmtPct(view.ebitda.margin)}
                      {view.ebitda.marginBps != null
                        ? ` (${view.ebitda.marginBps > 0 ? "+" : ""}${view.ebitda.marginBps}bps)`
                        : ""}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="exec-sum-card">
              <div className="exec-sum-card-title">PAT</div>
              <div className="exec-sum-card-value">{fmtCr(view.pat.value)}</div>
              <div className="exec-sum-card-meta">
                <YoY n={view.pat.yoy} />
                {view.pat.margin != null ? (
                  <div className="exec-sum-metric">
                    <span className="exec-sum-metric-label">
                      Margin: {fmtPct(view.pat.margin)}
                      {view.pat.marginBps != null
                        ? ` (${view.pat.marginBps > 0 ? "+" : ""}${view.pat.marginBps}bps)`
                        : ""}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="exec-sum-card">
              <div className="exec-sum-card-title">Order Book</div>
              <div className="exec-sum-card-value">
                {fmtCr(view.orderBook.pending)}
              </div>
              <div className="exec-sum-card-meta">
                {view.orderBook.inflowYoy != null ? (
                  <YoY n={view.orderBook.inflowYoy} />
                ) : null}
                {view.orderBook.visibility ? (
                  <div className="exec-sum-metric">
                    <span className="exec-sum-metric-label">
                      Visibility: {view.orderBook.visibility}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {view.metricBoxes.length ? (
        <div className="exec-sum-metrics-row">
          {view.metricBoxes.map((m) => (
            <div key={m.label} className="exec-sum-metric-box">
              <div className="exec-sum-metric-box-label">{m.label}</div>
              <div className="exec-sum-metric-box-value">{m.value}</div>
              {m.sub ? (
                <div className="exec-sum-metric-box-sub">{m.sub}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {view.sectors.length ? (
        <>
          <div className="exec-sum-section-h">
            Order Book by Sector
            {view.period ? ` (${view.period})` : ""}
          </div>
          <div className="exec-sum-card">
            <div className="exec-sum-segment-bars">
              {view.sectors.map((s) => (
                <div key={s.label} className="exec-sum-segment-item">
                  <div className="exec-sum-segment-label">{s.label}</div>
                  <div className="exec-sum-segment-bar">
                    <div
                      className="exec-sum-segment-fill"
                      style={{ width: `${Math.min(100, Math.max(2, s.pct))}%` }}
                    >
                      <span className="exec-sum-segment-value">{s.pct}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {(view.orderBook.inflow != null ||
              view.orderBook.largest != null) && (
              <p className="exec-sum-foot-note">
                {view.orderBook.inflow != null ? (
                  <>
                    <strong>Period inflow:</strong>{" "}
                    {fmtCr(view.orderBook.inflow)}
                    {view.orderBook.inflowYoy != null
                      ? ` (${fmtPct(view.orderBook.inflowYoy, true)})`
                      : ""}
                  </>
                ) : null}
                {view.orderBook.largest != null ? (
                  <>
                    {" "}
                    | <strong>Largest:</strong> {fmtCr(view.orderBook.largest)}
                    {view.orderBook.largestSector
                      ? ` (${view.orderBook.largestSector})`
                      : ""}
                  </>
                ) : null}
              </p>
            )}
          </div>
        </>
      ) : null}

      {(view.capexItems.length ||
        view.peak.low != null ||
        view.peak.high != null) && (
        <>
          <div className="exec-sum-section-h">
            Capex Expansion & Peak Revenue Potential
          </div>
          <div className="exec-sum-grid-2">
            {view.capexItems.length ? (
              <div className="exec-sum-card">
                <div className="exec-sum-card-title">Capex Timeline</div>
                <div className="exec-sum-capex-timeline">
                  {view.capexItems.map((c) => (
                    <div key={c.title} className="exec-sum-timeline-item">
                      <div className="exec-sum-timeline-dot" />
                      <div>
                        <div className="exec-sum-timeline-title">{c.title}</div>
                        <div className="exec-sum-timeline-detail">
                          {c.detail}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {view.peak.low != null || view.peak.high != null ? (
              <div className="exec-sum-card">
                <div className="exec-sum-card-title">Peak Revenue Potential</div>
                <div className="exec-sum-peak">
                  <div>
                    <div className="exec-sum-peak-label">Post-Expansion Peak</div>
                    <div className="exec-sum-peak-value">
                      {fmtCr(view.peak.low)}–{fmtCr(view.peak.high)}
                    </div>
                  </div>
                  {view.peak.timeline ? (
                    <div>
                      <div className="exec-sum-peak-label">Timeline</div>
                      <div className="exec-sum-peak-timeline">
                        {view.peak.timeline}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="exec-sum-peak-grid">
                  {view.peak.cagrLow != null || view.peak.cagrHigh != null ? (
                    <div>
                      <div className="exec-sum-peak-label">CAGR to Peak</div>
                      <div className="exec-sum-peak-sm">
                        {view.peak.cagrLow}–{view.peak.cagrHigh}%
                      </div>
                    </div>
                  ) : null}
                  {view.peak.utilLow != null || view.peak.utilHigh != null ? (
                    <div>
                      <div className="exec-sum-peak-label">Capacity Util</div>
                      <div className="exec-sum-peak-sm">
                        {view.peak.utilLow}–{view.peak.utilHigh}%
                      </div>
                    </div>
                  ) : null}
                </div>
                {(view.peak.netCash != null || view.peak.rating) && (
                  <p className="exec-sum-foot-note">
                    {view.peak.netCash != null ? (
                      <>
                        <strong>Net Cash:</strong> {fmtCr(view.peak.netCash)}
                      </>
                    ) : null}
                    {view.peak.rating ? (
                      <>
                        {" "}
                        | <strong>Rating:</strong> {view.peak.rating}
                      </>
                    ) : null}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </>
      )}

      {view.risks.length ? (
        <>
          <div className="exec-sum-section-h">Risk Analysis</div>
          <div className="exec-sum-card exec-sum-card--table">
            <table className="exec-sum-risk-table">
              <thead>
                <tr>
                  <th>Risk Factor</th>
                  <th>Impact</th>
                  <th>Timeline</th>
                  <th>Mitigation</th>
                </tr>
              </thead>
              <tbody>
                {view.risks.map((r) => (
                  <tr key={r.factor}>
                    <td>{r.factor}</td>
                    <td>
                      <span
                        className={`exec-sum-risk-impact exec-sum-risk-impact--${r.impactLevel}`}
                      >
                        {r.impact}
                      </span>
                    </td>
                    <td>{r.timeline}</td>
                    <td>{r.mitigation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {view.nearCatalysts.length ? (
        <>
          <div className="exec-sum-section-h">Near-Term Catalysts (6 Months)</div>
          <div className="exec-sum-card">
            <CatalystList items={view.nearCatalysts} />
          </div>
        </>
      ) : null}

      {view.midCatalysts.length ? (
        <>
          <div className="exec-sum-section-h">
            Medium-Term Catalysts (12 Months)
          </div>
          <div className="exec-sum-card">
            <CatalystList items={view.midCatalysts} />
          </div>
        </>
      ) : null}

      {(view.bull || view.bear) && (
        <>
          <div className="exec-sum-section-h">Investment Thesis</div>
          <div className="exec-sum-cases">
            {view.bull ? (
              <div className="exec-sum-case exec-sum-case--bull">
                <div className="exec-sum-case-title">Bull case</div>
                <div className="exec-sum-case-text">{view.bull}</div>
              </div>
            ) : null}
            {view.bear ? (
              <div className="exec-sum-case exec-sum-case--bear">
                <div className="exec-sum-case-title">Bear case</div>
                <div className="exec-sum-case-text">{view.bear}</div>
              </div>
            ) : null}
          </div>
        </>
      )}

      {view.anchors ? (
        <>
          <div className="exec-sum-section-h">Valuation Anchors</div>
          <div className="exec-sum-card">
            <p className="exec-sum-case-text">{view.anchors}</p>
          </div>
        </>
      ) : null}

      <footer className="exec-sum-footer">
        Generated from earnings materials · facts only · not investment advice
      </footer>
    </div>
  );
}

export function ExecSummaryHtml({
  exec,
  sentiment,
  score,
  nseSymbol,
  fallbackText,
}: {
  exec?: Record<string, unknown> | null;
  sentiment?: string | null;
  score?: number | null;
  nseSymbol?: string | null;
  fallbackText?: string;
}) {
  const view = buildExecSummaryView(exec, { sentiment, score, nseSymbol });
  if (!view) {
    return (
      <pre className="concall-text-viewer-body concall-summary-body">
        {fallbackText || "No summary JSON"}
      </pre>
    );
  }
  // If JSON is too thin, still show HTML shell + plain text fallback under thesis
  if (!view.hasFinancials && !view.bull && fallbackText) {
    return (
      <div className="exec-sum">
        <header className="exec-sum-header">
          <div>
            <h2 className="exec-sum-title">{view.company}</h2>
            <p className="exec-sum-subtitle">{view.period || "Summary"}</p>
          </div>
        </header>
        <pre className="exec-sum-fallback-pre">{fallbackText}</pre>
      </div>
    );
  }
  return <ExecSummaryBody view={view} />;
}

"use client";

import { useState } from "react";
import { ExpandMetricsStrip } from "@/components/ExpandMetricsStrip";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import type { VerdictLabel, VerdictRow } from "@/lib/agents/types";
import { researchLinks } from "@/lib/links";
import { useExpandQuarters } from "@/lib/use-expand-quarters";

type VerdictPanel = "about" | "qtr";

function fmtPrice(n: number | null): string {
  if (n == null) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtChange(n: number | null): string {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtRvol(n: number | null): string {
  if (n == null) return "—";
  return `${n.toFixed(2)}×`;
}

function rvolClass(n: number | null): string {
  if (n == null) return "ag-rvol";
  if (n >= 3) return "ag-rvol hot";
  if (n >= 1.5) return "ag-rvol warm";
  if (n < 1) return "ag-rvol thin";
  return "ag-rvol";
}

export function verdictClass(v: VerdictLabel): string {
  if (v === "BUY") return "ag-verdict-buy";
  if (v === "AVOID") return "ag-verdict-avoid";
  return "ag-verdict-watch";
}

function cleanAbout(raw: string): string {
  return raw
    .replace(/^(About Us\s*)+/gi, "")
    .replace(/Home\s*\/\s*About Us\s*/gi, "")
    .replace(/^About Company\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function VerdictLinks({
  web,
  sc,
  tv,
}: {
  web: string | null;
  sc: string;
  tv: string;
}) {
  return (
    <div className="ag-verdict-links" onClick={(e) => e.stopPropagation()}>
      {web ? (
        <a
          href={web}
          target="_blank"
          rel="noopener noreferrer"
          className="ag-link-chip"
        >
          Web
        </a>
      ) : (
        <span className="ag-link-chip disabled">Web</span>
      )}
      <a
        href={sc}
        target="_blank"
        rel="noopener noreferrer"
        className="ag-link-chip"
      >
        SC
      </a>
      <a
        href={tv}
        target="_blank"
        rel="noopener noreferrer"
        className="ag-link-chip"
      >
        TV
      </a>
    </div>
  );
}

export function VerdictRowCard({
  row,
  open,
  onToggle,
}: {
  row: VerdictRow;
  open: boolean;
  onToggle: () => void;
}) {
  const [panel, setPanel] = useState<VerdictPanel>("about");
  const [showMore, setShowMore] = useState(false);
  const about = cleanAbout(row.about?.trim() || "");
  const short = about.length > 320 && !showMore;
  const text = short ? `${about.slice(0, 320).trim()}…` : about;
  const links = row.sc
    ? { web: row.web, sc: row.sc, tv: row.tv }
    : researchLinks(row.symbol, row.market);
  const up = row.day_change_pct != null && row.day_change_pct >= 0;
  const vClass = verdictClass(row.verdict);
  const quarterData = useExpandQuarters(
    row.symbol,
    row.market,
    row.price,
    open,
  );

  return (
    <li className={`ag-verdict-item ${vClass}${open ? " open" : ""}`}>
      <div className="ag-verdict-row">
        <button type="button" className="ag-verdict-toggle" onClick={onToggle}>
          <span className="ag-chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <div className="ag-verdict-main">
            <div className="ag-verdict-head">
              <div className="ag-verdict-identity">
                <strong>{row.symbol}</strong>
                <span className="ag-name" title={row.name}>
                  {row.name}
                </span>
                <span className="ag-cap-pill">{row.cap_segment}</span>
                {/\bSME\b/i.test(row.market) ? (
                  <span className="ag-mkt" title={`${row.market} listing`}>
                    SME
                  </span>
                ) : null}
                {row.has_edge ? (
                  <span className="ag-tag ag-tag-edge" title="Early Edge">
                    Edge
                  </span>
                ) : null}
                {row.has_niveshaay ? (
                  <span className="ag-tag ag-tag-niveshaay" title="Niveshaay">
                    Niveshaay
                  </span>
                ) : null}
                {row.has_negen ? (
                  <span className="ag-tag ag-tag-negen" title="Negen">
                    Negen
                  </span>
                ) : null}
                {row.has_hold ? (
                  <span className="ag-tag ag-tag-hold" title="Holdings">
                    Hold
                  </span>
                ) : null}
                {row.has_tq ? (
                  <span className="result-tag tag-scan-tq">TQ</span>
                ) : null}
                {row.has_bb ? (
                  <span className="result-tag tag-scan-bb">BB</span>
                ) : null}
                {row.fired ? <span className="ag-fired">Signal</span> : null}
              </div>
            </div>
            <div className="ag-verdict-summary">
              <span className={`ag-verdict-pill ${vClass}`}>{row.verdict}</span>
              <span className="ag-conf">{row.confidence}/10</span>
              {row.rvol != null ? (
                <span className={rvolClass(row.rvol)} title="Relative volume">
                  RVOL {fmtRvol(row.rvol)}
                </span>
              ) : null}
              {row.trend ? (
                <span className={`ag-trend ag-trend-${row.trend}`}>
                  {row.trend}
                </span>
              ) : null}
              <p className="ag-why">{row.why}</p>
            </div>
            {row.key_catalyst ? (
              <p className="ag-catalyst">{row.key_catalyst}</p>
            ) : null}
          </div>
        </button>
        <div className="ag-verdict-aside">
          <div className="ag-verdict-quote">
            <span className="ag-price">{fmtPrice(row.price)}</span>
            <span className={up ? "ag-up" : "ag-down"}>
              {fmtChange(row.day_change_pct)}
            </span>
          </div>
          <VerdictLinks {...links} />
        </div>
      </div>
      {open ? (
        <div className="ag-verdict-detail">
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
          <div className="ag-detail-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={panel === "about"}
              className={`ag-detail-tab${panel === "about" ? " on" : ""}`}
              onClick={() => setPanel("about")}
            >
              About
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === "qtr"}
              className={`ag-detail-tab${panel === "qtr" ? " on" : ""}`}
              onClick={() => setPanel("qtr")}
            >
              Qtr
            </button>
          </div>
          {panel === "about" ? (
            <div className="ag-detail-body">
              {row.headquarters ? (
                <div className="ag-detail-meta">
                  <span className="ag-detail-meta-label">HQ</span>
                  <span>{row.headquarters}</span>
                </div>
              ) : null}
              {text ? (
                <p className="ag-detail-text">{text}</p>
              ) : (
                <p className="ag-muted">No about text available.</p>
              )}
              {about.length > 320 ? (
                <button
                  type="button"
                  className="ag-detail-more"
                  onClick={() => setShowMore((v) => !v)}
                >
                  {showMore ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="ag-detail-body">
              <ExpandQuarters data={quarterData} price={row.price} />
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

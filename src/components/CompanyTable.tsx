"use client";

import { useEffect, useMemo, useState } from "react";
import { HighlightedText } from "@/components/HighlightedText";
import type { Company } from "@/lib/types";
import { capTier, formatInr, formatMcap } from "@/lib/types";

export type SortKey = "name" | "price" | "sector" | "sub_sector" | "mcap_cr";

type Props = {
  rows: Company[];
  sort: SortKey;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  showMatched?: boolean;
  showMissing?: boolean;
  /** Cap filter from toolbar — Cap tags only when a specific band is selected. */
  capFilter?: string;
};

function SortIcon({
  active,
  dir,
}: {
  active: boolean;
  dir: "asc" | "desc";
}) {
  if (!active) {
    return <span className="sort-idle">⇅</span>;
  }
  return <span className="sort-active">{dir === "asc" ? "↑" : "↓"}</span>;
}

function CapTag({ company }: { company: Company }) {
  const tier = capTier(company.mcap_cr);
  return (
    <span className={`result-tag tag-cap-${tier.toLowerCase()}`}>{tier}</span>
  );
}

function SignalTags({
  company,
  showCap,
}: {
  company: Company;
  showCap: boolean;
}) {
  return (
    <span className="result-tags">
      {showCap ? <CapTag company={company} /> : null}
      {company.has_bb ? (
        <span
          className="result-tag tag-scan-bb"
          title={
            company.bb
              ? `BB NEW ${company.bb.timeframe}${company.bb.signal_date ? ` · ${company.bb.signal_date}` : ""}`
              : "BB NEW weekly"
          }
        >
          BB
        </span>
      ) : null}
      {company.has_tq ? (
        <span
          className="result-tag tag-scan-tq"
          title={
            company.tq
              ? `TQ ${company.tq.timeframe}${company.tq.crossover_type ? ` · ${company.tq.crossover_type}` : ""}${company.tq.score != null ? ` · score ${Math.round(company.tq.score)}` : ""}`
              : "TQ weekly"
          }
        >
          TQ
        </span>
      ) : null}
    </span>
  );
}

export function CompanyTable({
  rows,
  sort,
  dir,
  onSort,
  showMatched,
  showMissing,
  capFilter = "All",
}: Props) {
  const showCap = Boolean(capFilter && capFilter !== "All");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setExpanded(null);
  }, [rows]);

  const headers = useMemo(
    () =>
      [
        { key: "name" as const, label: "Company", align: "left" },
        { key: "price" as const, label: "Price", align: "right" },
        { key: "sector" as const, label: "Sector", align: "left" },
        { key: "sub_sector" as const, label: "Sub-sector", align: "left" },
        { key: "mcap_cr" as const, label: "Mcap Cr", align: "right" },
      ] as const,
    [],
  );

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h.key}
                className={h.align === "right" ? "num" : undefined}
              >
                <button
                  type="button"
                  className="th-btn"
                  onClick={() => onSort(h.key)}
                >
                  {h.label}
                  <SortIcon active={sort === h.key} dir={dir} />
                </button>
              </th>
            ))}
            <th className="links-col">Links</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty">
                No companies match the current filters.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const open = expanded === r.ticker;
              return (
                <CompanyRows
                  key={r.ticker}
                  company={r}
                  open={open}
                  showMore={!!more[r.ticker]}
                  showMatched={showMatched}
                  showMissing={showMissing}
                  showCap={showCap}
                  onToggleAbout={() =>
                    setExpanded(open ? null : r.ticker)
                  }
                  onToggleMore={() =>
                    setMore((m) => ({ ...m, [r.ticker]: !m[r.ticker] }))
                  }
                />
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function CompanyRows({
  company: r,
  open,
  showMore,
  showMatched,
  showMissing,
  showCap,
  onToggleAbout,
  onToggleMore,
}: {
  company: Company;
  open: boolean;
  showMore: boolean;
  showMatched?: boolean;
  showMissing?: boolean;
  showCap: boolean;
  onToggleAbout: () => void;
  onToggleMore: () => void;
}) {
  const about = r.about?.trim() || "";
  const highlights = r.highlights ?? [];
  const short = about.length > 320 && !showMore;
  const text = short ? `${about.slice(0, 320).trim()}…` : about;
  const preview =
    about.length > 180 ? `${about.slice(0, 180).trim()}…` : about;

  const missingTags =
    showMissing && r.missing
      ? (
          [
            ["price", r.missing.price],
            ["mcap", r.missing.mcap],
            ["sector", r.missing.sector],
            ["about", r.missing.about],
            ["web", r.missing.web],
          ] as const
        )
          .filter(([, on]) => on)
          .map(([label]) => label)
      : [];

  return (
    <>
      <tr className={open ? "row-open" : undefined}>
        <td>
          <button type="button" className="company-cell" onClick={onToggleAbout}>
            <span className="company-name">
              {r.name}
              <SignalTags company={r} showCap={showCap} />
            </span>
            <span className="ticker">{r.ticker}</span>
          </button>
          {missingTags.length > 0 ? (
            <div className="matched-tags">
              {missingTags.map((t) => (
                <span key={t} className="tag gap-tag">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
          {showMatched && r.matched && r.matched.length > 0 ? (
            <div className="matched-tags">
              {r.matched.slice(0, 4).map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
          {!open && about && highlights.length > 0 ? (
            <button
              type="button"
              className="about-preview"
              onClick={onToggleAbout}
              title="Click to expand About"
            >
              <HighlightedText text={preview} keywords={highlights} />
            </button>
          ) : null}
        </td>
        <td className="num">
          <button
            type="button"
            className="price-btn"
            title="Click to show About"
            onClick={onToggleAbout}
          >
            {formatInr(r.price)}
          </button>
        </td>
        <td>{r.sector || "—"}</td>
        <td>{r.sub_sector || "—"}</td>
        <td className="num">{formatMcap(r.mcap_cr)}</td>
        <td>
          <div className="link-row">
            {r.web ? (
              <a
                href={r.web}
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
              href={r.sc}
              target="_blank"
              rel="noopener noreferrer"
              className="link-chip"
            >
              SC
            </a>
            <a
              href={r.tv}
              target="_blank"
              rel="noopener noreferrer"
              className="link-chip"
            >
              TV
            </a>
          </div>
        </td>
      </tr>
      {open ? (
        <tr className="about-row">
          <td colSpan={6}>
            <div className="about-box">
              {r.headquarters ? (
                <div className="about-meta">
                  <span className="about-meta-label">HQ</span>
                  <span>{r.headquarters}</span>
                </div>
              ) : null}
              <div className="about-label">About</div>
              {text ? (
                <p>
                  <HighlightedText text={text} keywords={highlights} />
                </p>
              ) : (
                <p>No about text available.</p>
              )}
              {about.length > 320 ? (
                <button
                  type="button"
                  className="show-more"
                  onClick={onToggleMore}
                >
                  {showMore ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

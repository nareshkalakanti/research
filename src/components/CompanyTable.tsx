"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { HighlightedText } from "@/components/HighlightedText";
import { forwardPeBand } from "@/lib/forward-pe-band";
import type { Company } from "@/lib/types";
import { formatInr, formatMcap } from "@/lib/types";

export type SortKey =
  | "name"
  | "price"
  | "forward_pe"
  | "sector"
  | "sub_sector"
  | "mcap_cr";

type ExpandPanel = "about" | "notes";

type Props = {
  rows: Company[];
  sort: SortKey;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  showMatched?: boolean;
  showMissing?: boolean;
  /** @deprecated Cap tags no longer shown in results — filter still works via API. */
  capFilter?: string;
  /** Called after a note is saved/cleared so parent can refresh NOTE counts. */
  onNoteChange?: () => void;
  /** Sector filter, pager, etc. — rendered above the table header row. */
  toolbar?: ReactNode;
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

function fmtPe(n: number): string {
  return n.toFixed(1);
}

function SignalTags({ company }: { company: Company }) {
  return (
    <span className="result-tags">
      {company.has_note ? (
        <span className="result-tag tag-note" title="Has research note">
          NOTE
        </span>
      ) : null}
      {company.has_edge ? (
        <span className="result-tag tag-edge" title="Edge · Early Edge / Negen / Niveshaay">
          EDGE
        </span>
      ) : null}
      {company.has_hold ? (
        <span className="result-tag tag-hold" title="In your holdings">
          HOLD
        </span>
      ) : null}
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

function ForwardPeCell({ pe }: { pe: number | null | undefined }) {
  const band = forwardPeBand(pe);
  if (band === "none") {
    return <td className="num col-forward_pe">—</td>;
  }
  return (
    <td className="num col-forward_pe">
      <span
        className={`badge-fpe ${band}`}
        title="Forward PE = price ÷ (latest quarter EPS × 4)"
      >
        {fmtPe(pe!)}
      </span>
    </td>
  );
}

export function CompanyTable({
  rows,
  sort,
  dir,
  onSort,
  showMatched,
  showMissing,
  onNoteChange,
  toolbar,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<ExpandPanel>("about");
  const [noteFlags, setNoteFlags] = useState<Record<string, boolean>>({});
  const colSpan = 7;

  useEffect(() => {
    setExpanded(null);
    setPanel("about");
  }, [rows]);

  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const r of rows) {
      if (r.has_note) next[r.ticker] = true;
    }
    setNoteFlags(next);
  }, [rows]);

  const headers = useMemo(
    () =>
      [
        { key: "name" as const, label: "Company", align: "left" as const },
        { key: "price" as const, label: "Price", align: "right" as const },
        {
          key: "forward_pe" as const,
          label: "Fwd PE",
          align: "right" as const,
        },
        { key: "sector" as const, label: "Sector", align: "left" as const },
        {
          key: "sub_sector" as const,
          label: "Sub-sector",
          align: "left" as const,
        },
        { key: "mcap_cr" as const, label: "Mcap", align: "right" as const },
      ] satisfies Array<{
        key: SortKey;
        label: string;
        align: "left" | "right";
      }>,
    [],
  );

  return (
    <div className="table-card">
      {toolbar ? <div className="table-card-toolbar">{toolbar}</div> : null}
      <div className="table-wrap">
        <table className="data-table">
          <colgroup>
            <col className="col-name" />
            <col className="col-price" />
            <col className="col-forward_pe" />
            <col className="col-sector" />
            <col className="col-sub_sector" />
            <col className="col-mcap_cr" />
            <col className="col-links" />
          </colgroup>
          <thead>
            <tr>
              {headers.map((h) => (
                <th
                  key={h.key}
                  className={[
                    h.align === "right" ? "num" : "",
                    `col-${h.key}`,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    type="button"
                    className={`th-btn${h.align === "right" ? " th-btn--end" : ""}`}
                    onClick={() => onSort(h.key)}
                  >
                    {h.label}
                    <SortIcon active={sort === h.key} dir={dir} />
                  </button>
                </th>
              ))}
              <th className="col-links">Links</th>
            </tr>
          </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="empty">
                No companies match the current filters.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const open = expanded === r.ticker;
              const hasNote = noteFlags[r.ticker] ?? !!r.has_note;
              return (
                <CompanyRows
                  key={r.ticker}
                  company={{ ...r, has_note: hasNote }}
                  open={open}
                  panel={open ? panel : "about"}
                  showMore={!!more[r.ticker]}
                  showMatched={showMatched}
                  showMissing={showMissing}
                  colSpan={colSpan}
                  onToggleAbout={() => {
                    setExpanded(open ? null : r.ticker);
                    setPanel("about");
                  }}
                  onToggleMore={() =>
                    setMore((m) => ({ ...m, [r.ticker]: !m[r.ticker] }))
                  }
                  onPanel={(p) => setPanel(p)}
                  onNoteSaved={(body) => {
                    setNoteFlags((m) => ({
                      ...m,
                      [r.ticker]: Boolean(body?.trim()),
                    }));
                    onNoteChange?.();
                  }}
                />
              );
            })
          )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompanyRows({
  company: r,
  open,
  panel,
  showMore,
  showMatched,
  showMissing,
  colSpan,
  onToggleAbout,
  onToggleMore,
  onPanel,
  onNoteSaved,
}: {
  company: Company;
  open: boolean;
  panel: ExpandPanel;
  showMore: boolean;
  showMatched?: boolean;
  showMissing?: boolean;
  colSpan: number;
  onToggleAbout: () => void;
  onToggleMore: () => void;
  onPanel: (p: ExpandPanel) => void;
  onNoteSaved: (body: string | null) => void;
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
            ["fwd pe", r.missing.forward_pe],
          ] as const
        )
          .filter(([, on]) => on)
          .map(([label]) => label)
      : [];

  return (
    <>
      <tr className={open ? "row-open" : undefined}>
        <td className="col-name">
          <button type="button" className="company-cell" onClick={onToggleAbout}>
            <span className="company-name">{r.name}</span>
            <span className="company-meta">
              <span className="ticker">{r.ticker}</span>
              {r.headquarters ? (
                <>
                  <span className="meta-sep" aria-hidden>
                    ·
                  </span>
                  <span className="hq-line" title="Headquarters">
                    {r.headquarters}
                  </span>
                </>
              ) : null}
            </span>
            <SignalTags company={r} />
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
        <td className="num col-price">
          <button
            type="button"
            className="price-btn"
            title="Click to show About / Notes"
            onClick={onToggleAbout}
          >
            {formatInr(r.price)}
          </button>
        </td>
        <ForwardPeCell pe={r.forward_pe} />
        <td className="col-sector" title={r.sector || undefined}>
          {r.sector || "—"}
        </td>
        <td className="col-sub_sector" title={r.sub_sector || undefined}>
          {r.sub_sector || "—"}
        </td>
        <td className="num col-mcap_cr">{formatMcap(r.mcap_cr)}</td>
        <td className="col-links">
          <div className="link-row link-row--compact">
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
          <td colSpan={colSpan}>
            <div className="about-box">
              <div className="about-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === "about"}
                  className={`about-tab ${panel === "about" ? "on" : ""}`}
                  onClick={() => onPanel("about")}
                >
                  About
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === "notes"}
                  className={`about-tab ${panel === "notes" ? "on" : ""}`}
                  onClick={() => onPanel("notes")}
                >
                  Notes
                  {r.has_note ? <em className="about-tab-dot" /> : null}
                </button>
              </div>

              {panel === "about" ? (
                <>
                  {r.headquarters ? (
                    <div className="about-meta">
                      <span className="about-meta-label">HQ</span>
                      <HighlightedText
                        text={r.headquarters}
                        keywords={highlights}
                      />
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
                  <ExpandQuarters ticker={r.ticker} market={r.market} />
                </>
              ) : (
                <NotesPanel ticker={r.ticker} onSaved={onNoteSaved} />
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function NotesPanel({
  ticker,
  onSaved,
}: {
  ticker: string;
  onSaved: (body: string | null) => void;
}) {
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShowMore(false);
    void fetch(`/api/notes?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then(
        (j: {
          note?: { body: string; updated_at: string } | null;
        }) => {
          if (cancelled) return;
          const text = j.note?.body?.trim() || "";
          setSaved(text || null);
          setBody(text);
          setUpdatedAt(j.note?.updated_at ?? null);
          setEditing(!text);
        },
      )
      .catch(() => {
        if (!cancelled) setError("Could not load note");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, body }),
      });
      if (!res.ok) throw new Error("save failed");
      const j = (await res.json()) as {
        note?: { body: string; updated_at: string } | null;
      };
      const text = j.note?.body?.trim() || "";
      setSaved(text || null);
      setBody(text);
      setUpdatedAt(j.note?.updated_at ?? null);
      setEditing(!text);
      onSaved(text || null);
    } catch {
      setError("Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/notes?ticker=${encodeURIComponent(ticker)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("clear failed");
      setSaved(null);
      setBody("");
      setUpdatedAt(null);
      setEditing(true);
      onSaved(null);
    } catch {
      setError("Clear failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="notes-muted">Loading note…</p>;
  }

  const display = saved || "";
  const short = display.length > 320 && !showMore;
  const text = short ? `${display.slice(0, 320).trim()}…` : display;

  if (!editing && saved) {
    return (
      <>
        <div className="about-label">Notes</div>
        <p>{text}</p>
        {display.length > 320 ? (
          <button
            type="button"
            className="show-more"
            onClick={() => setShowMore((v) => !v)}
          >
            {showMore ? "Show less" : "Show more"}
          </button>
        ) : null}
        <div className="notes-actions">
          {updatedAt ? (
            <span className="notes-muted">
              Saved {updatedAt.slice(0, 10)}
            </span>
          ) : null}
          <button
            type="button"
            className="notes-btn"
            onClick={() => {
              setBody(saved);
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="notes-btn ghost"
            disabled={busy}
            onClick={() => void clear()}
          >
            Clear
          </button>
        </div>
        {error ? <p className="notes-error">{error}</p> : null}
      </>
    );
  }

  return (
    <>
      <div className="about-label">Notes</div>
      <textarea
        className="notes-input"
        rows={6}
        value={body}
        placeholder="Thesis, risks, catalysts, valuation notes…"
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="notes-actions">
        {saved ? (
          <button
            type="button"
            className="notes-btn ghost"
            disabled={busy}
            onClick={() => {
              setBody(saved);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          className="notes-btn primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? <p className="notes-error">{error}</p> : null}
    </>
  );
}

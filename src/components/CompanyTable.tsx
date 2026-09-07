"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  companyFundTags,
  FundWatchlistTags,
} from "@/components/FundWatchlistTags";
import { ExpandBusiness } from "@/components/ExpandBusiness";
import { ExpandExtraMetrics } from "@/components/ExpandExtraMetrics";
import { ExpandMetricsStrip } from "@/components/ExpandMetricsStrip";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { HighlightedText } from "@/components/HighlightedText";
import type { Company } from "@/lib/types";
import { matchTagSource } from "@/lib/pattern";
import { useExpandBrief } from "@/lib/use-expand-brief";
import { useExpandQuarters } from "@/lib/use-expand-quarters";
import { formatInr, formatMcap, formatMomPct, formatRsiM } from "@/lib/types";
import { SecCell } from "@/components/SecCell";

export type SortKey =
  | "name"
  | "price"
  | "price_1y"
  | "price_1m"
  | "sector"
  | "sub_sector"
  | "mcap_cr"
  | "momentum_pct"
  | "momentum_rank"
  | "rsi_m"
  | "board_score"
  | "board_dirs"
  | "board_top";

type ExpandPanel =
  | "about"
  | "sector"
  | "notes"
  | "qtr";

type Props = {
  rows: Company[];
  sort: SortKey;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  showMatched?: boolean;
  showMissing?: boolean;
  /** Theme/Scan/Missing — 12m momentum column is Scan-only. */
  showMomentum?: boolean;
  /** Scan Board view — reputation score / dirs / flags / top director. */
  showBoardRep?: boolean;
  /** Allow deleting a stock from local DBs (Missing Data). */
  allowDelete?: boolean;
  onDeleteStock?: (ticker: string) => void | Promise<void>;
  /** @deprecated Cap tags no longer shown in results — filter still works via API. */
  capFilter?: string;
  /** Called after a note is saved/cleared so parent can refresh NOTE counts. */
  onNoteChange?: () => void;
  /** Called after an inline website scrape saves new text. */
  onScrapeDone?: () => void;
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

/** Shorten ALL-CAPS DIN names for the Board column (full name in title). */
function formatBoardDirectorName(name: string | null | undefined): string {
  const raw = (name || "").trim();
  if (!raw) return "—";
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length <= 2) {
    return parts
      .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
      .join(" ");
  }
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  return `${first.charAt(0) + first.slice(1).toLowerCase()} ${last.charAt(0) + last.slice(1).toLowerCase()}`;
}

function SignalTags({ company }: { company: Company }) {
  return (
    <span className="result-tags">
      {/\bSME\b/i.test(company.market) ? (
        <span className="result-tag tag-mkt-sme" title={`${company.market} listing`}>
          SME
        </span>
      ) : null}
      {company.has_note ? (
        <span className="result-tag tag-note" title="Has research note">
          Note
        </span>
      ) : null}
      {company.has_edge ? (
        <span className="result-tag tag-edge" title="Early Edge watchlist">
          Edge
        </span>
      ) : null}
      {company.has_quality ? (
        <span
          className="result-tag tag-quality"
          title="Screener quality screen (growth + ROE/ROCE + low debt + OPM)"
        >
          Quality
        </span>
      ) : null}
      <FundWatchlistTags
        tags={companyFundTags(company)}
        changes={company.fund_changes}
      />
      {company.has_hold || company.has_distress ? (
        <span className="result-tag-group" title="Holdings">
          {company.has_hold ? (
            <span className="result-tag tag-hold">Hold</span>
          ) : null}
          {company.has_distress ? (
            <span
              className="result-tag tag-distress tag-sub"
              title="Distress turnaround monitor"
            >
              distress
            </span>
          ) : null}
        </span>
      ) : null}
      {company.has_bb_w || (company.has_bb && company.bb?.timeframe !== "monthly" && !company.has_bb_m) ? (
        <span className="result-tag tag-scan-bb-w" title="BB NEW weekly">
          BB W
        </span>
      ) : null}
      {company.has_bb_m || company.bb?.timeframe === "monthly" ? (
        <span className="result-tag tag-scan-bb-m" title="BB NEW monthly">
          BB M
        </span>
      ) : null}
      {company.has_tq ? (
        <span className="result-tag tag-scan-tq">TQ</span>
      ) : null}
      {company.has_ema ? (
        <span className="result-tag tag-scan-ema" title="Daily close above 10/20/50/200 EMA">
          EMA
        </span>
      ) : null}
      {company.has_ath ? (
        <span className="result-tag tag-scan-ath" title="NEW all-time high">
          ATH
        </span>
      ) : null}
      {company.has_high52 ? (
        <span className="result-tag tag-scan-high52" title="NEW 52-week high">
          52W
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
  showMomentum,
  showBoardRep,
  allowDelete,
  onDeleteStock,
  onNoteChange,
  onScrapeDone,
  toolbar,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<ExpandPanel>("about");
  const [noteFlags, setNoteFlags] = useState<Record<string, boolean>>({});
  const colSpan = showBoardRep ? 9 : showMomentum ? 10 : 5;
  const headers = useMemo(
    () =>
      (showBoardRep
        ? [
            { key: "name" as const, label: "Company", align: "left" as const },
            { key: "sector" as const, label: "Sec", align: "left" as const },
            { key: "mcap_cr" as const, label: "Mcap", align: "right" as const },
            {
              key: "board_score" as const,
              label: "Score",
              align: "right" as const,
            },
            {
              key: "board_dirs" as const,
              label: "Dirs",
              align: "right" as const,
            },
            {
              key: "board_top" as const,
              label: "Director",
              align: "left" as const,
            },
            { key: "price" as const, label: "LTP", align: "right" as const },
          ]
        : showMomentum
          ? [
              {
                key: "momentum_rank" as const,
                label: "Rank",
                align: "left" as const,
              },
              { key: "name" as const, label: "Company", align: "left" as const },
              { key: "sector" as const, label: "Sec", align: "left" as const },
              {
                key: "mcap_cr" as const,
                label: "Mcap",
                align: "right" as const,
              },
              { key: "price" as const, label: "LTP", align: "right" as const },
              {
                key: "price_1y" as const,
                label: "1Y",
                align: "right" as const,
              },
              {
                key: "price_1m" as const,
                label: "1M",
                align: "right" as const,
              },
              {
                key: "momentum_pct" as const,
                label: "Mom",
                align: "right" as const,
              },
              {
                key: "rsi_m" as const,
                label: "RSI M",
                align: "right" as const,
              },
            ]
          : [
              { key: "name" as const, label: "Company", align: "left" as const },
              { key: "sector" as const, label: "Sec", align: "left" as const },
              {
                key: "mcap_cr" as const,
                label: "Mcap",
                align: "right" as const,
              },
              {
                key: "price" as const,
                label: "Price",
                align: "right" as const,
              },
            ]) satisfies Array<{
        key: SortKey;
        label: string;
        align: "left" | "right";
      }>,
    [showMomentum, showBoardRep],
  );
  const rowIdentity = useMemo(
    () => rows.map((r) => `${r.market}:${r.ticker}`).join("|"),
    [rows],
  );

  useEffect(() => {
    setExpanded(null);
    setPanel("about");
  }, [rowIdentity]);

  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const r of rows) {
      if (r.has_note) next[r.ticker] = true;
    }
    setNoteFlags(next);
  }, [rowIdentity]);

  return (
    <div className="table-card">
      {toolbar ? <div className="table-card-toolbar">{toolbar}</div> : null}
      <div className="table-wrap">
        <table
          className={`data-table${showMomentum ? " data-table--mom" : ""}${showBoardRep ? " data-table--board" : ""}`}
        >
          <colgroup>
            {showBoardRep ? (
              <>
                <col className="col-name" />
                <col className="col-sec" />
                <col className="col-mcap_cr" />
                <col className="col-board-score" />
                <col className="col-board-dirs" />
                <col className="col-board-top" />
                <col className="col-price" />
                <col className="col-links" />
              </>
            ) : showMomentum ? (
              <>
                <col className="col-rank" />
                <col className="col-name" />
                <col className="col-sec" />
                <col className="col-mcap_cr" />
                <col className="col-price" />
                <col className="col-p1y" />
                <col className="col-p1m" />
                <col className="col-mom" />
                <col className="col-rsi-m" />
                <col className="col-links" />
              </>
            ) : (
              <>
                <col className="col-name" />
                <col className="col-sec" />
                <col className="col-mcap_cr" />
                <col className="col-price" />
                <col className="col-links" />
              </>
            )}
          </colgroup>
          <thead>
            <tr>
              {headers.map((h) => (
                <th
                  key={h.key}
                  className={[
                    h.align === "right" ? "num" : "",
                    h.key === "sector"
                      ? "col-sec"
                      : h.key === "momentum_pct"
                        ? "col-mom"
                    : h.key === "momentum_rank"
                      ? "col-rank"
                          : h.key === "price_1y"
                            ? "col-p1y"
                            : h.key === "price_1m"
                              ? "col-p1m"
                              : h.key === "rsi_m"
                                ? "col-rsi-m"
                              : h.key === "board_score"
                                ? "col-board-score"
                                : h.key === "board_dirs"
                                  ? "col-board-dirs"
                                  : h.key === "board_top"
                                    ? "col-board-top"
                              : `col-${h.key}`,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    type="button"
                    className={`th-btn${h.align === "right" ? " th-btn--end" : ""}`}
                    title={
                      h.key === "momentum_pct"
                        ? "Rounded 12−1 momentum (price 1m vs price 1y)"
                        : h.key === "momentum_rank"
                          ? "1 = highest rounded momentum in this list"
                          : h.key === "rsi_m"
                            ? "Monthly RSI(14). Green = 70–90 momentum zone; red = ≥90 stretched. Filter RSI M = new cross above 70"
                          : h.key === "price_1y"
                            ? "Price ~1 year ago"
                            : h.key === "price_1m"
                              ? "Price ~1 month ago"
                              : h.key === "price" && showMomentum
                                ? "Last traded price"
                                : h.key === "mcap_cr"
                                  ? "Market cap in ₹ crore"
                                  : undefined
                    }
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
                  key={`${r.market}:${r.ticker}`}
                  company={{ ...r, has_note: hasNote }}
                  open={open}
                  panel={open ? panel : "about"}
                  showMore={!!more[`${r.ticker}:${open ? panel : "about"}`]}
                  showMatched={showMatched}
                  showMissing={showMissing}
                  showMomentum={showMomentum}
                  showBoardRep={showBoardRep}
                  allowDelete={allowDelete}
                  onDeleteStock={onDeleteStock}
                  colSpan={colSpan}
                  onToggleAbout={() => {
                    setExpanded(open ? null : r.ticker);
                    setPanel("about");
                  }}
                  onToggleMore={() =>
                    setMore((m) => ({
                      ...m,
                      [`${r.ticker}:${panel}`]: !m[`${r.ticker}:${panel}`],
                    }))
                  }
                  onPanel={(p) => setPanel(p)}
                  onNoteSaved={(body) => {
                    setNoteFlags((m) => ({
                      ...m,
                      [r.ticker]: Boolean(body?.trim()),
                    }));
                    onNoteChange?.();
                  }}
                  onScrapeDone={onScrapeDone}
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

function SectorEditPanel({
  company,
  onSaved,
}: {
  company: Company;
  onSaved: (patch: { sector: string; sub_sector: string }) => void;
}) {
  const [sector, setSector] = useState(company.sector || "");
  const [subSector, setSubSector] = useState(company.sub_sector || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sectors, setSectors] = useState<string[]>([]);
  const [subSectors, setSubSectors] = useState<string[]>([]);

  useEffect(() => {
    setSector(company.sector || "");
    setSubSector(company.sub_sector || "");
    setSaved(null);
    setErr(null);
  }, [company.ticker, company.sector, company.sub_sector]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/classification?taxonomy=1")
      .then((r) => r.json())
      .then((json: { ok?: boolean; pairs?: Array<{ sector: string; sub_sector: string }>; sectors?: string[] }) => {
        if (cancelled || !json.ok) return;
        setSectors(json.sectors ?? []);
        setSubSectors(
          (json.pairs ?? [])
            .map((p) => p.sub_sector)
            .filter((s, i, a) => a.indexOf(s) === i)
            .slice(0, 120),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredSubSectors = useMemo(() => {
    const s = sector.trim().toLowerCase();
    if (!s) return subSectors;
    return subSectors.filter((sub) => sub.toLowerCase().includes(s) || s.includes(sub.toLowerCase().slice(0, 4)));
  }, [sector, subSectors]);

  const save = useCallback(async () => {
    const sec = sector.trim();
    const sub = subSector.trim();
    if (!sec || !sub) {
      setErr("Sector and sub-sector are both required");
      return;
    }
    setSaving(true);
    setErr(null);
    setSaved(null);
    try {
      const res = await fetch("/api/classification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: company.ticker,
          market: company.market,
          name: company.name,
          sector: sec,
          sub_sector: sub,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Save failed");
      }
      onSaved({ sector: sec, sub_sector: sub });
      setSaved("Saved to classifications.db — commit data/ to sync other machines");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [company, onSaved, sector, subSector]);

  return (
    <div className="missing-edit-block">
      <p className="hint tight">
        Saved in <strong>data/classifications.db</strong>. Run{" "}
        <code>git add data/classifications.db &amp;&amp; git commit &amp;&amp; git push</code>{" "}
        so another machine gets it on pull.
      </p>
      <form
        className="scrapper-web-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="scrapper-web-form-label" htmlFor={`missing-sector-${company.ticker}`}>
          Sector
        </label>
        <input
          id={`missing-sector-${company.ticker}`}
          className="scrapper-web-input"
          value={sector}
          onChange={(e) => setSector(e.target.value)}
          placeholder="e.g. Healthcare"
          list={`sector-list-${company.ticker}`}
          spellCheck={false}
        />
        <datalist id={`sector-list-${company.ticker}`}>
          {sectors.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        <label className="scrapper-web-form-label" htmlFor={`missing-sub-${company.ticker}`}>
          Sub-sector
        </label>
        <input
          id={`missing-sub-${company.ticker}`}
          className="scrapper-web-input"
          value={subSector}
          onChange={(e) => setSubSector(e.target.value)}
          placeholder="e.g. Pharmaceuticals"
          list={`sub-sector-list-${company.ticker}`}
          spellCheck={false}
        />
        <datalist id={`sub-sector-list-${company.ticker}`}>
          {filteredSubSectors.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        <div className="scrapper-web-form-actions">
          <button type="submit" className="btn-fill" disabled={saving}>
            {saving ? "Saving…" : "Save sector"}
          </button>
          {saved ? <span className="missing-edit-ok">{saved}</span> : null}
          {err ? <span className="hint tight website-scrape-error">{err}</span> : null}
        </div>
      </form>
    </div>
  );
}

function MomTag({ value }: { value: number | null | undefined }) {
  const label = formatMomPct(value);
  if (value == null || Number.isNaN(value)) {
    return <span className="mom-tag mom-tag--empty">—</span>;
  }
  const rounded = Math.round(value);
  const tone = rounded > 0 ? "pos" : rounded < 0 ? "neg" : "flat";
  return <span className={`mom-tag mom-tag--${tone}`}>{label}</span>;
}

/** Monthly RSI tag: good 70–85, excellent 85–90, overbought ≥90. */
function RsiMTag({ value }: { value: number | null | undefined }) {
  const label = formatRsiM(value);
  if (value == null || Number.isNaN(value)) {
    return <span className="mom-tag mom-tag--empty">—</span>;
  }
  const tone =
    value >= 90
      ? "rsi-hot"
      : value >= 85
        ? "rsi-great"
        : value >= 70
          ? "rsi-ok"
          : "flat";
  const title =
    value >= 90
      ? "Monthly RSI ≥ 90 — extended / overbought"
      : value >= 85
        ? "Monthly RSI 85–90 — excellent momentum window"
        : value >= 70
          ? "Monthly RSI 70–85 — constructive"
          : "Monthly RSI below 70";
  return (
    <span className={`mom-tag mom-tag--${tone}`} title={title}>
      {label}
    </span>
  );
}

function CompanyLinks({
  web,
  sc,
  tv,
}: {
  web?: string | null;
  sc: string;
  tv: string;
}) {
  return (
    <div className="link-row link-row--compact">
      {web ? (
        <a
          href={web}
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
        href={sc}
        target="_blank"
        rel="noopener noreferrer"
        className="link-chip"
      >
        SC
      </a>
      <a
        href={tv}
        target="_blank"
        rel="noopener noreferrer"
        className="link-chip"
      >
        TV
      </a>
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
  showMomentum,
  showBoardRep,
  allowDelete,
  onDeleteStock,
  colSpan,
  onToggleAbout,
  onToggleMore,
  onPanel,
  onNoteSaved,
  onScrapeDone,
}: {
  company: Company;
  open: boolean;
  panel: ExpandPanel;
  showMore: boolean;
  showMatched?: boolean;
  showMissing?: boolean;
  showMomentum?: boolean;
  showBoardRep?: boolean;
  allowDelete?: boolean;
  onDeleteStock?: (ticker: string) => void | Promise<void>;
  colSpan: number;
  onToggleAbout: () => void;
  onToggleMore: () => void;
  onPanel: (p: ExpandPanel) => void;
  onNoteSaved: (body: string | null) => void;
  onScrapeDone?: () => void;
}) {
  const [sectorPatch, setSectorPatch] = useState<{
    sector: string;
    sub_sector: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    setSectorPatch(null);
  }, [r.ticker, r.sector, r.sub_sector]);

  const displaySector = sectorPatch?.sector ?? r.sector;
  const displaySubSector = sectorPatch?.sub_sector ?? r.sub_sector;

  const about = r.about?.trim() || "";
  const scraped = r.scraped_about?.trim() || "";
  const highlights = r.highlights ?? [];
  const scrapeHighlights = r.scrape_highlights ?? [];
  const short = about.length > 320 && !showMore;
  const text = short ? `${about.slice(0, 320).trim()}…` : about;

  /** One chip per term: About (or both) → blue; scrape-only → orange. */
  const displayMatchTags = useMemo(() => {
    const aboutNorm = new Set(
      highlights.map((t) => t.trim().toLowerCase()).filter(Boolean),
    );
    const tags: Array<{ term: string; source: "about" | "scrape" }> = [];
    const seen = new Set<string>();
    for (const t of highlights) {
      const key = t.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tags.push({ term: t, source: "about" });
    }
    for (const t of scrapeHighlights) {
      const key = t.trim().toLowerCase();
      if (!key || seen.has(key) || aboutNorm.has(key)) continue;
      seen.add(key);
      tags.push({ term: t, source: "scrape" });
    }
    return tags.slice(0, 6);
  }, [highlights, scrapeHighlights]);

  const quarterData = useExpandQuarters(
    r.ticker,
    r.market,
    r.price,
    open,
  );
  const briefData = useExpandBrief(
    r.ticker,
    r.market,
    r.price,
    quarterData,
    open && panel === "about",
  );

  const matchWhy =
    showMatched && r.matched?.length
      ? r.matched.find((t) => t.trim().length > 28)?.trim() ?? null
      : null;
  const matchChips =
    showMatched && r.matched?.length && !matchWhy
      ? r.matched.filter((t) => t.trim().length > 0)
      : [];

  const missingTags =
    showMissing && r.missing
      ? (
          [
            ["price", r.missing.price],
            ["mcap", r.missing.mcap],
            ["sector", r.missing.sector],
            ["sub_sector", r.missing.sub_sector],
            ["about", r.missing.about],
            ["web", r.missing.web],
            ["scrape", r.missing.scrape],
            ["board", Boolean(r.missing.board)],
          ] as const
        )
          .filter(([, on]) => on)
          .map(([label]) =>
            label === "sub_sector"
              ? "sub-sector"
              : label === "scrape"
                ? "scrape"
                : label,
          )
      : [];

  return (
    <>
      <tr className={open ? "row-open" : undefined}>
        {showMomentum ? (
          <td className="col-rank">
            {r.momentum_rank != null ? r.momentum_rank : "—"}
          </td>
        ) : null}
        <td className="col-name">
          <button type="button" className="company-cell" onClick={onToggleAbout}>
            <span className="company-name">{r.name}</span>
            {!open ? (
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
            ) : null}
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
          {matchWhy ? <p className="match-why">{matchWhy}</p> : null}
          {displayMatchTags.length > 0 ? (
            <div className="matched-tags">
              {displayMatchTags.map(({ term, source }) => (
                <span
                  key={term.toLowerCase()}
                  className={`tag ${source === "scrape" ? "tag-scrape-hit" : "tag-about-hit"}`}
                  title={
                    source === "scrape"
                      ? "Matched in website scrape only"
                      : "Matched in About"
                  }
                >
                  {term}
                </span>
              ))}
            </div>
          ) : matchChips.length > 0 ? (
            <div className="matched-tags">
              {matchChips.slice(0, 4).map((t) => {
                const src = matchTagSource(t, about, scraped);
                return (
                  <span
                    key={t}
                    className={`tag ${src === "scrape" ? "tag-scrape-hit" : "tag-about-hit"}`}
                    title={
                      src === "scrape"
                        ? "Matched in website scrape only"
                        : "Matched in About"
                    }
                  >
                    {t}
                  </span>
                );
              })}
            </div>
          ) : null}
        </td>
        {showBoardRep ? (
          <>
            <SecCell
              className="cd-sec col-sec"
              sector={displaySector}
              subSector={displaySubSector}
            />
            <td className="num col-mcap_cr">{formatMcap(r.mcap_cr)}</td>
            <td className="num col-board-score" title="Best DIN-backed director score">
              {r.board_score != null ? r.board_score.toFixed(1) : "—"}
            </td>
            <td className="num col-board-dirs" title="Qualifying directors on this board">
              {r.board_dirs != null ? r.board_dirs : "—"}
            </td>
            <td className="col-board-top">
              <span
                className="board-top-name"
                title={r.board_top || undefined}
              >
                {formatBoardDirectorName(r.board_top)}
              </span>
              <span className="board-flag-row">
                {r.board_bridge ? (
                  <span
                    className="result-tag tag-scan-board"
                    title="Cap bridge director"
                  >
                    Bridge
                  </span>
                ) : null}
                {r.board_multi_lc ? (
                  <span
                    className="result-tag tag-scan-board"
                    title="Multi large-cap director"
                  >
                    Multi-LC
                  </span>
                ) : null}
                {r.board_sme_cross ? (
                  <span
                    className="result-tag tag-scan-board"
                    title="SME ↔ mainboard director"
                  >
                    SME×
                  </span>
                ) : null}
              </span>
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
            <td className="col-links">
              <CompanyLinks web={r.web} sc={r.sc} tv={r.tv} />
            </td>
          </>
        ) : showMomentum ? (
          <>
            <SecCell
              className="cd-sec col-sec"
              sector={displaySector}
              subSector={displaySubSector}
            />
            <td className="num col-mcap_cr">{formatMcap(r.mcap_cr)}</td>
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
            <td className="num col-p1y">{formatInr(r.price_1y)}</td>
            <td className="num col-p1m">{formatInr(r.price_1m)}</td>
            <td className="num col-mom">
              <MomTag value={r.momentum_score ?? r.momentum_pct} />
            </td>
            <td className="num col-rsi-m">
              <RsiMTag value={r.rsi_m} />
            </td>
            <td className="col-links">
              <CompanyLinks web={r.web} sc={r.sc} tv={r.tv} />
            </td>
          </>
        ) : (
          <>
            <SecCell
              className="cd-sec col-sec"
              sector={displaySector}
              subSector={displaySubSector}
            />
            <td className="num col-mcap_cr">{formatMcap(r.mcap_cr)}</td>
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
            <td className="col-links">
              <CompanyLinks web={r.web} sc={r.sc} tv={r.tv} />
            </td>
          </>
        )}
      </tr>
      {open ? (
        <tr className="about-row">
          <td colSpan={colSpan}>
            <div className="about-box">
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
                  aria-selected={panel === "about"}
                  className={`about-tab ${panel === "about" ? "on" : ""}`}
                  onClick={() => onPanel("about")}
                >
                  About
                  {highlights.length > 0 ? (
                    <em
                      className="about-tab-dot about-tab-dot--about"
                      title="Keyword match in About"
                    />
                  ) : null}
                </button>
                {showMissing ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={panel === "sector"}
                    className={`about-tab ${panel === "sector" ? "on" : ""}`}
                    onClick={() => onPanel("sector")}
                  >
                    Sector
                    {r.missing?.sector || r.missing?.sub_sector ? (
                      <em
                        className="about-tab-dot about-tab-dot--scrape"
                        title="Sector gap"
                      />
                    ) : null}
                  </button>
                ) : null}
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
                  aria-selected={panel === "notes"}
                  className={`about-tab ${panel === "notes" ? "on" : ""}`}
                  onClick={() => onPanel("notes")}
                >
                  Notes
                  {r.has_note ? <em className="about-tab-dot" /> : null}
                </button>
                {allowDelete && onDeleteStock ? (
                  <button
                    type="button"
                    className="about-tab about-tab-delete"
                    disabled={deleting}
                    title="Remove this stock from local research databases"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Delete ${r.ticker} from local DBs? This cannot be undone.`,
                        )
                      ) {
                        return;
                      }
                      setDeleting(true);
                      void Promise.resolve(onDeleteStock(r.ticker)).finally(
                        () => setDeleting(false),
                      );
                    }}
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                ) : null}
              </div>

              {panel === "qtr" ? (
                <ExpandQuarters data={quarterData} price={r.price} />
              ) : panel === "sector" ? (
                <SectorEditPanel
                  company={{
                    ...r,
                    sector: displaySector,
                    sub_sector: displaySubSector,
                  }}
                  onSaved={(patch) => {
                    setSectorPatch(patch);
                    onScrapeDone?.();
                  }}
                />
              ) : panel === "about" ? (
                <>
                  {r.headquarters ? (
                    <div className="about-meta">
                      <span className="about-meta-label">Location</span>
                      <span>{r.headquarters}</span>
                    </div>
                  ) : null}
                  {(() => {
                    const ceo = r.ceo?.trim() || "";
                    const md = r.managing_director?.trim() || "";
                    const leaderName = ceo || md;
                    const leaderLabel = ceo ? "CEO" : "MD";
                    if (!leaderName && !r.founded_year) return null;
                    return (
                      <div className="about-meta">
                        {leaderName ? (
                          <>
                            <span className="about-meta-label">{leaderLabel}</span>
                            <span>{leaderName}</span>
                          </>
                        ) : null}
                        {r.founded_year ? (
                          <>
                            <span className="about-meta-label">Founded</span>
                            <span>{r.founded_year}</span>
                          </>
                        ) : null}
                      </div>
                    );
                  })()}
                  {highlights.length > 0 ? (
                    <div className="matched-tags about-match-tags">
                      {highlights.map((t) => (
                        <span key={t} className="tag tag-about-hit">
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {text ? (
                    <>
                      <div className="about-label">About</div>
                      <p>
                        <HighlightedText
                          text={text}
                          keywords={highlights}
                          source="about"
                        />
                      </p>
                    </>
                  ) : !briefData.brief && !briefData.loading ? (
                    <p>No about text available.</p>
                  ) : null}
                  {about.length > 320 ? (
                    <button
                      type="button"
                      className="show-more"
                      onClick={onToggleMore}
                    >
                      {showMore ? "Show less" : "Show more"}
                    </button>
                  ) : null}
                  <ExpandBusiness data={briefData} />
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
  type Attachment = {
    id: number;
    ticker: string;
    filename: string;
    mime: string;
    size: number;
    ocr_text: string | null;
    created_at: string;
    url: string;
  };

  const [body, setBody] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [ocrOpen, setOcrOpen] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch(`/api/notes?ticker=${encodeURIComponent(ticker)}`);
    const j = (await res.json()) as {
      note?: { body: string; updated_at: string } | null;
      attachments?: Attachment[];
    };
    const text = j.note?.body?.trim() || "";
    const atts = j.attachments ?? [];
    setSaved(text || null);
    setBody(text);
    setAttachments(atts);
    setUpdatedAt(j.note?.updated_at ?? null);
    setEditing(!text && atts.length === 0);
    return { text, atts };
  }, [ticker]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShowMore(false);
    setOcrOpen(null);
    void reload()
      .catch(() => {
        if (!cancelled) setError("Could not load note");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

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
      const { text, atts } = await reload();
      setEditing(!(text || atts.length));
      onSaved(text || atts.length ? text || "(screenshots)" : null);
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
      setAttachments([]);
      setUpdatedAt(null);
      setEditing(true);
      onSaved(null);
    } catch {
      setError("Clear failed");
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    if (!list.length) {
      setError("Pick image screenshots (PNG, JPEG, WebP, GIF)");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("ticker", ticker);
      for (const f of list) form.append("files", f);
      const res = await fetch("/api/notes/attachments", {
        method: "POST",
        body: form,
      });
      const j = (await res.json()) as {
        ok?: boolean;
        attachments?: Attachment[];
        errors?: string[];
        error?: string;
      };
      if (!res.ok && !j.attachments?.length) {
        throw new Error(j.error || "Upload failed");
      }
      setAttachments(j.attachments ?? []);
      if (j.errors?.length) setError(j.errors.join(" · "));
      onSaved(saved || body.trim() || "(screenshots)");
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeAttachment(id: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/notes/attachments?id=${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("delete failed");
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch {
      setError("Could not remove screenshot");
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
  const hasContent = Boolean(saved) || attachments.length > 0;

  const shots = (
    <div className="notes-shots">
      <div className="notes-shots-head">
        <span className="about-label">Screenshots</span>
        <span className="notes-muted">
          {attachments.length
            ? `${attachments.length} saved · OCR for AI`
            : "Attach charts / filings for AI to read"}
        </span>
      </div>
      {attachments.length > 0 ? (
        <ul className="notes-shot-grid">
          {attachments.map((a) => (
            <li key={a.id} className="notes-shot">
              <a href={a.url} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={`Screenshot ${a.id}`} />
              </a>
              <div className="notes-shot-meta">
                {a.ocr_text ? (
                  <button
                    type="button"
                    className="notes-shot-ocr"
                    onClick={() =>
                      setOcrOpen((cur) => (cur === a.id ? null : a.id))
                    }
                  >
                    {ocrOpen === a.id ? "Hide OCR" : "OCR text"}
                  </button>
                ) : (
                  <span className="notes-muted" title="Install tesseract for OCR">
                    No OCR
                  </span>
                )}
                {(editing || !saved) && (
                  <button
                    type="button"
                    className="notes-shot-del"
                    disabled={busy}
                    onClick={() => void removeAttachment(a.id)}
                  >
                    Remove
                  </button>
                )}
              </div>
              {ocrOpen === a.id && a.ocr_text ? (
                <pre className="notes-shot-ocr-text">{a.ocr_text}</pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {(editing || !hasContent) && (
        <div className="notes-upload">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void uploadFiles(e.target.files);
            }}
          />
          <button
            type="button"
            className="notes-btn"
            disabled={uploading || busy}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "Uploading…" : "Add screenshots"}
          </button>
          <span className="notes-muted">Multiple PNG/JPEG · max 8 MB each</span>
        </div>
      )}
    </div>
  );

  if (!editing && hasContent) {
    return (
      <>
        <div className="about-label">Notes</div>
        {display ? <p>{text}</p> : <p className="notes-muted">No text note — screenshots only.</p>}
        {display.length > 320 ? (
          <button
            type="button"
            className="show-more"
            onClick={() => setShowMore((v) => !v)}
          >
            {showMore ? "Show less" : "Show more"}
          </button>
        ) : null}
        {shots}
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
              setBody(saved || "");
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
            Clear all
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
      {shots}
      <div className="notes-actions">
        {hasContent ? (
          <button
            type="button"
            className="notes-btn ghost"
            disabled={busy}
            onClick={() => {
              setBody(saved || "");
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

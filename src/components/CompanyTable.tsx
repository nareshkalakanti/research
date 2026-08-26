"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExpandExtraMetrics } from "@/components/ExpandExtraMetrics";
import { ExpandMetricsStrip } from "@/components/ExpandMetricsStrip";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { HighlightedText } from "@/components/HighlightedText";
import type { Company } from "@/lib/types";
import { scrapeHighlightsForRow, matchTagSource } from "@/lib/pattern";
import { useExpandQuarters } from "@/lib/use-expand-quarters";
import { formatInr, formatMcap } from "@/lib/types";

export type SortKey =
  | "name"
  | "price"
  | "sector"
  | "sub_sector"
  | "mcap_cr"
  | "momentum_pct";

type ExpandPanel = "about" | "website" | "notes" | "qtr";

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
      {company.has_niveshaay ? (
        <span className="result-tag tag-niveshaay" title="Niveshaay fund watchlist">
          Niveshaay
        </span>
      ) : null}
      {company.has_negen ? (
        <span className="result-tag tag-negen" title="Negen fund watchlist">
          Negen
        </span>
      ) : null}
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
      {company.has_bb ? (
        <span className="result-tag tag-scan-bb">BB</span>
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
      {company.has_dd ? (
        <span
          className="result-tag tag-scan-dd"
          title="Weekly Dragonfly Doji"
        >
          DD
        </span>
      ) : null}
      {company.has_mom && company.momentum_pct != null ? (
        <span
          className="result-tag tag-scan-mom"
          title={`12−1 momentum: +${company.momentum_pct}% (Price 1M / Price 1Y − 1)`}
        >
          +{Math.round(company.momentum_pct)}%
        </span>
      ) : null}
      {(company.matched_themes ?? []).slice(0, 4).map((t) => (
        <span
          key={t.id}
          className="result-tag tag-theme"
          title={t.name}
        >
          {t.tag}
        </span>
      ))}
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
  onNoteChange,
  onScrapeDone,
  toolbar,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<ExpandPanel>("about");
  const [noteFlags, setNoteFlags] = useState<Record<string, boolean>>({});
  const colSpan = 6;
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

  const headers = useMemo(
    () =>
      [
        { key: "name" as const, label: "Company", align: "left" as const },
        { key: "price" as const, label: "Price", align: "right" as const },
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
                  key={`${r.market}:${r.ticker}`}
                  company={{ ...r, has_note: hasNote }}
                  open={open}
                  panel={open ? panel : "about"}
                  showMore={!!more[`${r.ticker}:${open ? panel : "about"}`]}
                  showMatched={showMatched}
                  showMissing={showMissing}
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

function WebsiteScrapePanel({
  company,
  themeHighlights,
  showMore,
  editable,
  onToggleMore,
  onScrapeDone,
  onUpdated,
}: {
  company: Company;
  themeHighlights: string[];
  showMore: boolean;
  editable?: boolean;
  onToggleMore: () => void;
  onScrapeDone?: () => void;
  onUpdated: (patch: {
    scraped_about: string | null;
    scrape_source_url: string | null;
    scrape_highlights: string[];
  }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webValue, setWebValue] = useState(company.website || "");
  const [scrapeValue, setScrapeValue] = useState(company.scraped_about || "");
  const [webSaving, setWebSaving] = useState(false);
  const [scrapeSaving, setScrapeSaving] = useState(false);
  const [webErr, setWebErr] = useState<string | null>(null);
  const [scrapeErr, setScrapeErr] = useState<string | null>(null);
  const [webSaved, setWebSaved] = useState<string | null>(null);
  const [scrapeSaved, setScrapeSaved] = useState<string | null>(null);

  useEffect(() => {
    setWebValue(company.website || "");
    setScrapeValue(company.scraped_about || "");
    setWebErr(null);
    setScrapeErr(null);
  }, [company.ticker, company.website, company.scraped_about]);

  const scraped = company.scraped_about?.trim() || "";
  const scrapeHighlights = company.scrape_highlights ?? [];
  const scrapedShort = scraped.length > 320 && !showMore;
  const scrapedText = scrapedShort
    ? `${scraped.slice(0, 320).trim()}…`
    : scraped;
  const canScrape = !!(company.web || company.website);

  const runScrape = useCallback(async (rescan = false) => {
    if (!canScrape || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/about-scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tickers: [company.ticker],
          limit: 1,
          rescan,
          missingOnly: false,
        }),
      });
      const raw = await res.text();
      let json: {
        ok?: boolean;
        error?: string;
        message?: string;
        scraped_about?: string | null;
        source_url?: string | null;
      } = {};
      try {
        json = JSON.parse(raw) as typeof json;
      } catch {
        throw new Error(`Scrape failed (${res.status})`);
      }
      if (!res.ok || !json.ok) {
        throw new Error(json.error || json.message || `Scrape failed (${res.status})`);
      }
      const text = json.scraped_about?.trim() || "";
      const source = json.source_url?.trim() || company.scrape_source_url || null;
      const scrapeHits = scrapeHighlightsForRow(text, themeHighlights);
      onUpdated({
        scraped_about: text || null,
        scrape_source_url: source,
        scrape_highlights: scrapeHits,
      });
      onScrapeDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scrape failed");
    } finally {
      setBusy(false);
    }
  }, [busy, canScrape, company, onScrapeDone, onUpdated, themeHighlights]);

  const saveField = useCallback(
    async (action: "website" | "scraped_about", value: string) => {
      const res = await fetch("/api/scrapper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: company.ticker,
          name: company.name,
          market: company.market,
          action,
          website: action === "website" ? value : undefined,
          scraped_about: action === "scraped_about" ? value : undefined,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Save failed");
      }
    },
    [company.market, company.name, company.ticker],
  );

  const saveWebsite = useCallback(async () => {
    setWebSaving(true);
    setWebErr(null);
    setWebSaved(null);
    try {
      await saveField("website", webValue);
      setWebSaved("Website saved");
      onScrapeDone?.();
    } catch (e) {
      setWebErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setWebSaving(false);
    }
  }, [onScrapeDone, saveField, webValue]);

  const saveScrapeText = useCallback(async () => {
    setScrapeSaving(true);
    setScrapeErr(null);
    setScrapeSaved(null);
    try {
      await saveField("scraped_about", scrapeValue);
      const text = scrapeValue.trim();
      const scrapeHits = scrapeHighlightsForRow(text, themeHighlights);
      onUpdated({
        scraped_about: text || null,
        scrape_source_url: company.scrape_source_url || company.web || null,
        scrape_highlights: scrapeHits,
      });
      setScrapeSaved("Scrape text saved");
      onScrapeDone?.();
    } catch (e) {
      setScrapeErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setScrapeSaving(false);
    }
  }, [
    company.scrape_source_url,
    company.web,
    onScrapeDone,
    onUpdated,
    saveField,
    scrapeValue,
    themeHighlights,
  ]);

  return (
    <>
      {editable ? (
        <div className="missing-edit-block">
          <form
            className="scrapper-web-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveWebsite();
            }}
          >
            <label
              className="scrapper-web-form-label"
              htmlFor={`missing-web-${company.ticker}`}
            >
              Website URL
            </label>
            <input
              id={`missing-web-${company.ticker}`}
              className="scrapper-web-input"
              value={webValue}
              onChange={(e) => setWebValue(e.target.value)}
              placeholder="https://example.com"
              spellCheck={false}
            />
            <div className="scrapper-web-form-actions">
              <button type="submit" className="btn-fill" disabled={webSaving}>
                {webSaving ? "Saving…" : "Save URL"}
              </button>
              {webSaved ? (
                <span className="missing-edit-ok">{webSaved}</span>
              ) : null}
            </div>
            {webErr ? <p className="scrapper-form-err">{webErr}</p> : null}
          </form>

          <form
            className="scrapper-about-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveScrapeText();
            }}
          >
            <label
              className="scrapper-web-form-label"
              htmlFor={`missing-scrape-${company.ticker}`}
            >
              Website scrape text
            </label>
            <textarea
              id={`missing-scrape-${company.ticker}`}
              className="scrapper-about-input"
              value={scrapeValue}
              onChange={(e) => setScrapeValue(e.target.value)}
              placeholder="Paste company about text from the website…"
              rows={6}
            />
            <div className="scrapper-web-form-actions scrapper-about-form-actions">
              <button type="submit" className="btn-fill" disabled={scrapeSaving}>
                {scrapeSaving ? "Saving…" : "Save scrape"}
              </button>
              <span className="scrapper-about-hint">
                Min 40 characters
              </span>
              {scrapeSaved ? (
                <span className="missing-edit-ok">{scrapeSaved}</span>
              ) : null}
            </div>
            {scrapeErr ? (
              <p className="scrapper-form-err scrapper-about-form-err">
                {scrapeErr}
              </p>
            ) : null}
          </form>
        </div>
      ) : null}
      {company.scrape_source_url || company.web ? (
        <div className="about-meta">
          <span className="about-meta-label">Source</span>
          {company.scrape_source_url ? (
            <a
              href={company.scrape_source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="about-source-link"
            >
              {company.scrape_source_url}
            </a>
          ) : company.web ? (
            <a
              href={company.web}
              target="_blank"
              rel="noopener noreferrer"
              className="about-source-link"
            >
              {company.web}
            </a>
          ) : null}
        </div>
      ) : null}
      {scrapeHighlights.length > 0 ? (
        <div className="matched-tags scrape-match-tags">
          {scrapeHighlights.map((t) => (
            <span key={t} className="tag tag-scrape-hit">
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <div className="about-label">Website scrape</div>
      {scraped ? (
        <>
          <p>
            <HighlightedText
              text={scrapedText}
              keywords={scrapeHighlights}
              source="scrape"
            />
          </p>
          {scraped.length > 320 ? (
            <button type="button" className="show-more" onClick={onToggleMore}>
              {showMore ? "Show less" : "Show more"}
            </button>
          ) : null}
          {canScrape ? (
            <div className="website-scrape-actions">
              <button
                type="button"
                className="show-more"
                disabled={busy}
                onClick={() => void runScrape(true)}
              >
                {busy ? "Scraping…" : "Re-scrape website"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="hint tight">
            {canScrape
              ? "No website text scraped yet."
              : "No website on file for this company."}
          </p>
          {canScrape ? (
            <div className="website-scrape-actions">
              <button
                type="button"
                className="btn-scrape-website"
                disabled={busy}
                onClick={() => void runScrape()}
              >
                {busy ? "Scraping…" : "Scrape website"}
              </button>
            </div>
          ) : null}
        </>
      )}
      {error ? <p className="hint tight website-scrape-error">{error}</p> : null}
    </>
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
  onScrapeDone,
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
  onScrapeDone?: () => void;
}) {
  const [scrapePatch, setScrapePatch] = useState<{
    scraped_about: string | null;
    scrape_source_url: string | null;
    scrape_highlights: string[];
  } | null>(null);

  useEffect(() => {
    setScrapePatch(null);
  }, [r.ticker, r.scraped_about, r.scrape_source_url, r.scrape_highlights]);

  const websiteCompany = useMemo(
    () =>
      scrapePatch
        ? {
            ...r,
            scraped_about: scrapePatch.scraped_about,
            scrape_source_url: scrapePatch.scrape_source_url,
            scrape_highlights: scrapePatch.scrape_highlights,
          }
        : r,
    [r, scrapePatch],
  );

  const about = r.about?.trim() || "";
  const scraped = websiteCompany.scraped_about?.trim() || "";
  const highlights = r.highlights ?? [];
  const scrapeHighlights = websiteCompany.scrape_highlights ?? [];
  const short = about.length > 320 && !showMore;
  const text = short ? `${about.slice(0, 320).trim()}…` : about;
  const preview =
    about.length > 180 ? `${about.slice(0, 180).trim()}…` : about;

  const matchHighlights = useMemo(
    () => [...new Set([...highlights, ...scrapeHighlights])],
    [highlights, scrapeHighlights],
  );

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
          ) : showMatched && r.matched && r.matched.length > 0 ? (
            <div className="matched-tags">
              {r.matched.slice(0, 4).map((t) => {
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
          {!open && about ? (
            <button
              type="button"
              className="about-preview"
              onClick={onToggleAbout}
              title="Click to expand About"
            >
              <HighlightedText
                text={preview}
                keywords={highlights}
                source="about"
              />
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
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === "website"}
                  className={`about-tab ${panel === "website" ? "on" : ""}`}
                  onClick={() => onPanel("website")}
                >
                  Website
                  {scraped && scrapeHighlights.length > 0 ? (
                    <em
                      className="about-tab-dot about-tab-dot--scrape"
                      title="Keyword match in scrape"
                    />
                  ) : scraped ? (
                    <em
                      className="about-tab-dot about-tab-dot--muted"
                      title="Scraped"
                    />
                  ) : null}
                </button>
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
              </div>

              {panel === "qtr" ? (
                <ExpandQuarters data={quarterData} />
              ) : panel === "website" ? (
                <WebsiteScrapePanel
                  company={websiteCompany}
                  themeHighlights={matchHighlights}
                  showMore={showMore}
                  editable={showMissing}
                  onToggleMore={onToggleMore}
                  onScrapeDone={onScrapeDone}
                  onUpdated={setScrapePatch}
                />
              ) : panel === "about" ? (
                <>
                  {r.headquarters ? (
                    <div className="about-meta">
                      <span className="about-meta-label">HQ</span>
                      <HighlightedText
                        text={r.headquarters}
                        keywords={highlights}
                        source="about"
                      />
                    </div>
                  ) : null}
                  <div className="about-label">About</div>
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
                    <p>
                      <HighlightedText
                        text={text}
                        keywords={highlights}
                        source="about"
                      />
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

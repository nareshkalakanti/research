"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GovernanceScanBar } from "@/components/GovernanceScanBar";
import { HighlightedText } from "@/components/HighlightedText";
import { ThemeMultiselect } from "@/components/ThemeMultiselect";
import { formatMcap, type ThemeGroup } from "@/lib/types";

type View = "director" | "company" | "role";

type Stats = {
  directors: number;
  din_backed: number;
  name_only: number;
  bridges: number;
  sme_cross: number;
  companies: number;
};

type Seat = {
  ticker: string;
  name: string;
  market: string;
  designation: string;
  category: string | null;
  market_cap_cr: number | null;
  cap_code: string | null;
  about: string | null;
  about_search?: string;
  highlights?: string[];
  sector: string | null;
  is_sme: boolean;
  has_bb: boolean;
  has_tq: boolean;
  web: string | null;
  sc: string;
  tv: string;
};

type DirectorRow = {
  person_id: string;
  din: string | null;
  name: string;
  board_count: number;
  dir_score: number;
  din_backed: boolean;
  name_collision: boolean;
  bridge: boolean;
  sme_cross: boolean;
  companies: Seat[];
};

type CompanyRow = {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  cap_code: string | null;
  has_bb: boolean;
  has_tq: boolean;
  about?: string | null;
  highlights?: string[];
  sc: string;
  tv: string;
  web: string | null;
  directors: Array<{
    person_id: string;
    name: string;
    din: string | null;
    dir_score: number;
    din_backed: boolean;
    designation: string;
    category: string | null;
  }>;
};

type RoleRow = {
  role: string;
  count: number;
  directors: Array<{
    person_id: string;
    name: string;
    dir_score: number;
    ticker: string;
    company: string;
  }>;
};

type ApiResponse = {
  view: View;
  stats: Stats;
  total: number;
  page: number;
  pages: number;
  themePattern?: string | null;
  rows: DirectorRow[] | CompanyRow[] | RoleRow[];
};

function GovAbout({
  about,
  highlights = [],
}: {
  about: string;
  highlights?: string[];
}) {
  const [more, setMore] = useState(false);
  const text = about.trim();
  if (!text) return null;
  const short = text.length > 320 && !more;
  const display = short ? `${text.slice(0, 320).trim()}…` : text;

  return (
    <div className="gov-about">
      <p>
        <HighlightedText text={display} keywords={highlights} />
      </p>
      {text.length > 320 ? (
        <button
          type="button"
          className="show-more"
          onClick={() => setMore((m) => !m)}
        >
          {more ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export function GovernanceMapPanel() {
  const [view, setView] = useState<View>("director");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [dinOnly, setDinOnly] = useState(false);
  const [bridge, setBridge] = useState(false);
  const [smeCross, setSmeCross] = useState(false);
  const [filterBb, setFilterBb] = useState(false);
  const [filterTq, setFilterTq] = useState(false);
  const [hideCollision, setHideCollision] = useState(true);
  const [minScore, setMinScore] = useState(0);
  const [themeGroups, setThemeGroups] = useState<ThemeGroup[]>([]);
  const [selectedThemes, setSelectedThemes] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [debouncedCustom, setDebouncedCustom] = useState("");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/themes")
      .then((r) => r.json())
      .then((j: { groups?: ThemeGroup[] }) => {
        setThemeGroups(j.groups ?? []);
      });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedCustom(custom), 300);
    return () => clearTimeout(t);
  }, [custom]);

  useEffect(() => {
    setPage(1);
    setOpenId(null);
  }, [
    view,
    debouncedQ,
    dinOnly,
    bridge,
    smeCross,
    filterBb,
    filterTq,
    hideCollision,
    minScore,
    selectedThemes,
    debouncedCustom,
  ]);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      setLoading(true);
      const params = new URLSearchParams({
        view,
        q: debouncedQ,
        page: String(page),
        pageSize: "40",
        minScore: String(minScore),
      });
      if (dinOnly) params.set("dinOnly", "1");
      if (bridge) params.set("bridge", "1");
      if (smeCross) params.set("smeCross", "1");
      if (filterBb) params.set("bb", "1");
      if (filterTq) params.set("tq", "1");
      if (!hideCollision) params.set("hideCollision", "0");
      if (selectedThemes.length) params.set("themes", selectedThemes.join(","));
      if (debouncedCustom.trim()) params.set("custom", debouncedCustom.trim());
      if (opts?.refresh) params.set("refresh", "1");
      try {
        const res = await fetch(`/api/governance-map?${params}`);
        const json = (await res.json()) as ApiResponse;
        setData(json);
      } finally {
        setLoading(false);
      }
    },
    [
      view,
      debouncedQ,
      page,
      dinOnly,
      bridge,
      smeCross,
      filterBb,
      filterTq,
      hideCollision,
      minScore,
      selectedThemes,
      debouncedCustom,
    ],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const stats = data?.stats;
  const start = data ? (data.page - 1) * 40 + 1 : 0;
  const end = data ? Math.min(data.page * 40, data.total) : 0;
  // Avoid rendering stale rows while a different view is loading.
  const ready = data?.view === view;
  const directorRows = ready && view === "director" ? (data.rows as DirectorRow[]) : [];
  const companyRows = ready && view === "company" ? (data.rows as CompanyRow[]) : [];
  const roleRows = ready && view === "role" ? (data.rows as RoleRow[]) : [];
  const themeActive =
    selectedThemes.length > 0 || debouncedCustom.trim().length > 0;

  const activeThemeMeta = useMemo(() => {
    const all = themeGroups.flatMap((g) => g.themes);
    return selectedThemes
      .map((id) => all.find((t) => t.id === id))
      .filter(Boolean) as Array<{ id: string; name: string; display_pattern: string }>;
  }, [themeGroups, selectedThemes]);

  function clearThemeFilter() {
    setSelectedThemes([]);
    setCustom("");
    setDebouncedCustom("");
  }

  const pageTickers = useMemo(() => {
    const set = new Set<string>();
    if (view === "director") {
      for (const r of directorRows) {
        for (const c of r.companies ?? []) {
          if (c.ticker) set.add(c.ticker.toUpperCase());
        }
      }
    } else if (view === "company") {
      for (const c of companyRows) {
        if (c.ticker) set.add(c.ticker.toUpperCase());
      }
    } else {
      for (const r of roleRows) {
        for (const d of r.directors ?? []) {
          if (d.ticker) set.add(d.ticker.toUpperCase());
        }
      }
    }
    return [...set];
  }, [view, directorRows, companyRows, roleRows]);

  return (
    <div className="panel">
      <div className="scanner-controls gov-theme-controls">
        <div className="scanner-col">
          <label className="field-label">Themes</label>
          <ThemeMultiselect
            groups={themeGroups}
            selected={selectedThemes}
            onChange={setSelectedThemes}
          />
        </div>
        <div className="scanner-col">
          <label className="field-label" htmlFor="gov-custom-kw">
            Custom keywords
          </label>
          <div className="search-bar">
            <span className="search-icon" aria-hidden>
              ⌕
            </span>
            <input
              id="gov-custom-kw"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="acsr | copper | transformer oil"
            />
          </div>
          <p className="hint tight">
            Match themes against company About text (not name / ticker)
          </p>
        </div>
      </div>

      {activeThemeMeta.length > 0 ? (
        <div className="active-themes">
          {activeThemeMeta.map((t) => (
            <button
              key={t.id}
              type="button"
              className="active-theme"
              onClick={() =>
                setSelectedThemes((s) => s.filter((id) => id !== t.id))
              }
              title={t.display_pattern}
            >
              {t.name}
              <span aria-hidden>×</span>
            </button>
          ))}
          <button
            type="button"
            className="clear-filter"
            onClick={clearThemeFilter}
          >
            Clear filter
          </button>
        </div>
      ) : custom.trim() || debouncedCustom.trim() ? (
        <div className="active-themes">
          <button
            type="button"
            className="clear-filter"
            onClick={clearThemeFilter}
          >
            Clear filter
          </button>
        </div>
      ) : null}

      {themeActive && data?.themePattern ? (
        <div className="pattern-preview">
          <span>Filtering</span>
          <code>{data.themePattern}</code>
        </div>
      ) : null}

      <div className="toolbar gov-toolbar">
        <div className="gov-view-tabs" role="tablist" aria-label="Map view">
          {(
            [
              ["director", "By director"],
              ["company", "By company"],
              ["role", "By role"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={view === id ? "tab on" : "tab"}
              aria-selected={view === id}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="field grow">
          <span>Search</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Director, DIN, ticker…"
          />
        </label>

        <label className="field">
          <span>Min score</span>
          <select
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
          >
            <option value={0}>Any</option>
            <option value={40}>40+</option>
            <option value={55}>55+</option>
            <option value={70}>70+</option>
          </select>
        </label>

        <button
          type="button"
          className="btn-ghost"
          disabled={loading}
          onClick={() => load({ refresh: true })}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="gov-filters">
        <label className="chk">
          <input
            type="checkbox"
            checked={dinOnly}
            onChange={(e) => setDinOnly(e.target.checked)}
          />
          DIN only
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={bridge}
            onChange={(e) => setBridge(e.target.checked)}
          />
          Big↔small bridge
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={smeCross}
            onChange={(e) => setSmeCross(e.target.checked)}
          />
          SME ↔ main
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={filterBb}
            onChange={(e) => setFilterBb(e.target.checked)}
          />
          BB
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={filterTq}
            onChange={(e) => setFilterTq(e.target.checked)}
          />
          TQ
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={hideCollision}
            onChange={(e) => setHideCollision(e.target.checked)}
          />
          Hide name collisions
        </label>
      </div>

      <GovernanceScanBar
        market="All"
        pageTickers={pageTickers}
        onDone={() => load({ refresh: true })}
      />

      {stats ? (
        <div className="gov-stats">
          <span>
            <strong>{stats.directors.toLocaleString()}</strong> directors
          </span>
          <span>
            <strong>{stats.companies.toLocaleString()}</strong> companies
          </span>
          <span>
            <strong>{stats.din_backed.toLocaleString()}</strong> DIN
          </span>
          <span>
            <strong>{stats.bridges.toLocaleString()}</strong> bridges
          </span>
          <span>
            <strong>{stats.sme_cross.toLocaleString()}</strong> SME-cross
          </span>
        </div>
      ) : null}

      <div className="table-meta">
        {loading && !data ? (
          <span>Loading governance map…</span>
        ) : data ? (
          <span>
            Showing {start.toLocaleString()}–{end.toLocaleString()} of{" "}
            {data.total.toLocaleString()}
            {themeActive ? " · theme filter on" : ""}
          </span>
        ) : null}
      </div>

      {!ready && loading ? (
        <div className="table-meta">Loading…</div>
      ) : null}

      {view === "director" && ready ? (
        <div className="gov-list">
          {directorRows.map((r) => {
            const open = openId === r.person_id;
            const companies = r.companies ?? [];
            return (
              <article key={r.person_id} className="gov-card">
                <button
                  type="button"
                  className="gov-card-head"
                  onClick={() =>
                    setOpenId(open ? null : r.person_id)
                  }
                >
                  <div className="gov-dir">
                    <div className="gov-dir-name">
                      {r.name}
                      {r.din_backed ? (
                        <span className="gov-badge">DIN</span>
                      ) : (
                        <span className="gov-badge name">name</span>
                      )}
                      {r.bridge ? (
                        <span className="gov-badge bridge">bridge</span>
                      ) : null}
                      {r.sme_cross ? (
                        <span className="gov-badge cross">SME↔main</span>
                      ) : null}
                      {r.name_collision ? (
                        <span className="gov-badge suspect">collision?</span>
                      ) : null}
                    </div>
                    <div className="gov-dir-sub">
                      {r.din ? `DIN ${r.din} · ` : null}
                      {r.board_count} boards · {companies.map((c) => c.ticker).join(", ")}
                    </div>
                  </div>
                  <div className="gov-score" title="Director network score">
                    {r.dir_score.toFixed(1)}
                  </div>
                </button>
                {open ? (
                  <div className="gov-cos">
                    {companies.map((c) => (
                      <div key={`${r.person_id}-${c.ticker}`} className="gov-co">
                        <div className="gov-co-top">
                          <div>
                            <div className="gov-co-name">
                              {c.name}{" "}
                              <span className="mono">({c.ticker})</span>
                              {c.cap_code ? (
                                <span
                                  className={`result-tag tag-cap-${c.cap_code.toLowerCase()}`}
                                >
                                  {c.cap_code}
                                </span>
                              ) : null}
                              {c.is_sme ? (
                                <span className="gov-tag gov-tag-sme">SME</span>
                              ) : null}
                              {c.has_bb ? (
                                <span className="gov-tag gov-tag-bb">BB</span>
                              ) : null}
                              {c.has_tq ? (
                                <span className="gov-tag gov-tag-tq">TQ</span>
                              ) : null}
                            </div>
                            <div className="gov-co-meta">
                              {[c.designation, c.category]
                                .filter(Boolean)
                                .join(" · ")}
                              {c.sector ? ` · ${c.sector}` : ""}
                              {c.market_cap_cr != null
                                ? ` · ₹${formatMcap(c.market_cap_cr)} Cr`
                                : ""}
                            </div>
                          </div>
                          <div className="gov-co-links">
                            {c.web ? (
                              <a href={c.web} target="_blank" rel="noreferrer">
                                Web
                              </a>
                            ) : null}
                            <a href={c.sc} target="_blank" rel="noreferrer">
                              SC
                            </a>
                            <a href={c.tv} target="_blank" rel="noreferrer">
                              TV
                            </a>
                          </div>
                        </div>
                        {c.about ? (
                          <GovAbout
                            about={c.about}
                            highlights={c.highlights}
                          />
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {view === "company" && ready ? (
        <div className="gov-list">
          {companyRows.map((c) => {
            const directors = c.directors ?? [];
            return (
            <article key={c.ticker} className="gov-card">
              <div className="gov-card-head static">
                <div className="gov-dir">
                  <div className="gov-dir-name">
                    {c.name}{" "}
                    <span className="mono">({c.ticker})</span>
                    {c.cap_code ? (
                      <span
                        className={`result-tag tag-cap-${c.cap_code.toLowerCase()}`}
                      >
                        {c.cap_code}
                      </span>
                    ) : null}
                    {c.has_bb ? (
                      <span className="gov-tag gov-tag-bb">BB</span>
                    ) : null}
                    {c.has_tq ? (
                      <span className="gov-tag gov-tag-tq">TQ</span>
                    ) : null}
                  </div>
                  <div className="gov-dir-sub">
                    {c.market}
                    {c.market_cap_cr != null
                      ? ` · ₹${formatMcap(c.market_cap_cr)} Cr`
                      : ""}
                    {` · ${directors.length} multi-board directors`}
                  </div>
                </div>
                <div className="gov-co-links">
                  {c.web ? (
                    <a href={c.web} target="_blank" rel="noreferrer">
                      Web
                    </a>
                  ) : null}
                  <a href={c.sc} target="_blank" rel="noreferrer">
                    SC
                  </a>
                  <a href={c.tv} target="_blank" rel="noreferrer">
                    TV
                  </a>
                </div>
              </div>
              {c.about ? (
                <GovAbout about={c.about} highlights={c.highlights} />
              ) : null}
              <ul className="gov-dir-list">
                {directors
                  .slice()
                  .sort((a, b) => b.dir_score - a.dir_score)
                  .map((d) => (
                    <li key={`${c.ticker}-${d.person_id}`}>
                      <span className="gov-score inline">
                        {d.dir_score.toFixed(1)}
                      </span>
                      <span>
                        {d.name}
                        {d.din_backed ? (
                          <span className="gov-badge">DIN</span>
                        ) : null}
                      </span>
                      <span className="muted">
                        {[d.designation, d.category].filter(Boolean).join(" · ")}
                      </span>
                    </li>
                  ))}
              </ul>
            </article>
            );
          })}
        </div>
      ) : null}

      {view === "role" && ready ? (
        <div className="gov-list">
          {roleRows.map((r) => (
            <article key={r.role} className="gov-card">
              <div className="gov-card-head static">
                <div className="gov-dir">
                  <div className="gov-dir-name">{r.role}</div>
                  <div className="gov-dir-sub">{r.count} seats</div>
                </div>
              </div>
              <ul className="gov-dir-list">
                {(r.directors ?? []).map((d, i) => (
                  <li key={`${r.role}-${d.person_id}-${d.ticker}-${i}`}>
                    <span className="gov-score inline">
                      {d.dir_score.toFixed(1)}
                    </span>
                    <span>
                      {d.name} · {d.ticker}
                    </span>
                    <span className="muted">{d.company}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      ) : null}

      {data && data.pages > 1 ? (
        <div className="pager">
          <button
            type="button"
            className="btn-ghost"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <span>
            Page {data.page} / {data.pages}
          </span>
          <button
            type="button"
            className="btn-ghost"
            disabled={page >= data.pages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

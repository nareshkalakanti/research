"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tagPostTone } from "@/lib/valuepickr-themes";

type Momentum = {
  current: number;
  previous: number;
  pct: number | null;
  label: string;
};

type Components = {
  mentions_1d: number;
  mentions_30d: number;
  mentions_90d: number;
  mentions_12m: number;
  mentions_all: number;
  momentum_30d: Momentum;
  contributors_30d: number;
  contributors_90d: number;
  contributors_12m: number;
  new_contributors_30d: number;
  new_contributors_90d: number;
  returning_30d: number;
  posts_per_contributor_30d: number | null;
  persistence: {
    active_months_all: number;
    active_months_12: number;
    consecutive: number;
    longest_streak: number;
  };
};

type Quality = {
  grade: string;
  posts: number;
  contributors: number;
  months: number;
  why: string;
};

type Row = {
  signal: number | null;
  signal_label: string;
  components: Components;
  quality: Quality;
};

type Card = {
  company_id: string;
  company_name: string;
  ticker: string | null;
  initials: string;
  why: string;
  row: Row;
};

type MonthBar = {
  month: string;
  pos: number;
  neg: number;
  neu: number;
  q: number;
  total: number;
};

type Evidence = {
  company: { company_id: string; company_name: string; ticker: string | null };
  row: Row;
  posts: {
    author: string;
    date: string | null;
    thread: string;
    excerpt: string;
    url: string;
    themes: string[];
  }[];
  themes: { theme: string; posts: number; pct: number }[];
  months: MonthBar[];
};

type Board = {
  ingested_at: string | null;
  unmapped_threads: number;
  posts_total: number;
  companies: Card[];
  latest: {
    author: string;
    date: string | null;
    company: string;
    company_id: string | null;
    thread: string;
    excerpt: string;
    url: string;
  }[];
  sources: { name: string; posts: number; avg_signal: number | null }[];
};

function fmtN(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return String(n);
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtDay(iso: string | null): string {
  if (!iso) return "N/A";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "N/A";
  return d.toISOString().slice(0, 10);
}

function scoreClass(n: number | null): "g" | "p" | "a" {
  if (n == null) return "a";
  if (n >= 80) return "g";
  if (n >= 60) return "p";
  return "a";
}

function sourceInitials(name: string): string {
  const p = name.trim().split(/\s+/);
  if (!p.length) return "VP";
  if (p.length === 1) return p[0]!.slice(0, 2).toUpperCase();
  return (p[0]![0]! + p[1]![0]!).toUpperCase();
}

export function ValuePickrSignalsPanel() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Evidence | null>(null);
  const [evidenceOn, setEvidenceOn] = useState(false);
  const [themeFilter, setThemeFilter] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    setError(null);
    const res = await fetch(
      `/api/valuepickr/signals?q=${encodeURIComponent(query)}`,
      { cache: "no-store" },
    );
    const json = (await res.json()) as Board & { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    setBoard(json);
    return json;
  }, []);

  useEffect(() => {
    let dead = false;
    void (async () => {
      setLoading(true);
      try {
        const json = await load("");
        if (dead) return;
        if (json.posts_total === 0) {
          setIngesting(true);
          const ing = await fetch("/api/valuepickr/ingest", { method: "POST" });
          const body = (await ing.json()) as { ok?: boolean; error?: string };
          if (!ing.ok || body.ok === false) {
            throw new Error(body.error || "Ingest failed");
          }
          await load("");
        }
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!dead) {
          setLoading(false);
          setIngesting(false);
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, [load]);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(
          `/api/valuepickr/company/${encodeURIComponent(openId)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as Evidence & {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || json.ok === false) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        setDetail(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [openId]);

  const cards = board?.companies ?? [];
  const selected = useMemo(() => {
    if (openId) return cards.find((c) => c.company_id === openId) ?? cards[0];
    return cards[0];
  }, [cards, openId]);

  const months = detail?.months?.length
    ? detail.months
    : [];
  const maxBar = Math.max(1, ...months.map((m) => m.total));
  const tonePosts = (detail?.posts ?? []).slice(0, 16);
  const posN = tonePosts.filter((p) => tagPostTone(p.excerpt) === "pos").length;
  const negN = tonePosts.filter((p) => tagPostTone(p.excerpt) === "neg").length;

  const evidencePosts = themeFilter
    ? (detail?.posts ?? []).filter((p) => p.themes.includes(themeFilter))
    : detail?.posts ?? [];

  const refresh = async () => {
    setIngesting(true);
    setError(null);
    try {
      const ing = await fetch("/api/valuepickr/ingest", { method: "POST" });
      const body = (await ing.json()) as { ok?: boolean; error?: string };
      if (!ing.ok || body.ok === false) throw new Error(body.error || "Ingest failed");
      await load(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIngesting(false);
    }
  };

  return (
    <div className="vp-page">
      <div className="vp-top">
        <div>
          <div className="vp-brand">
            VALUE<span>PICKR</span> <span className="vp-brand-muted">SIGNALS</span>
          </div>
          <div className="vp-sub">
            Evidence-driven discussion intelligence · ValuePickr posts only · not a
            recommendation
          </div>
        </div>
        <div className="vp-top-actions">
          <input
            className="vp-search"
            placeholder="Search company or contributor…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(q);
            }}
            aria-label="Search ValuePickr companies"
          />
          <button
            type="button"
            className="btn-ghost"
            disabled={ingesting}
            onClick={() => void refresh()}
          >
            {ingesting ? "Reading ValuePickr…" : "Refresh from ValuePickr"}
          </button>
        </div>
      </div>

      {error ? <div className="table-meta">{error}</div> : null}
      {loading ? (
        <div className="table-meta">Loading ValuePickr signals…</div>
      ) : null}

      {!loading && board && board.posts_total === 0 ? (
        <div className="vp-empty">
          <strong>NO VALUEPICKR DATA</strong>
          <p>No qualifying ValuePickr discussions found.</p>
        </div>
      ) : null}

      {board && board.posts_total > 0 ? (
        <div className="vp-grid">
          <section className="vp-card vp-combined">
            <div className="vp-col">
              <div className="vp-label">Top signals</div>
              <div className="vp-title">
                Companies with the strongest activity right now
              </div>
              {cards.length === 0 ? (
                <p className="vp-empty-inline">
                  No mapped companies match. Unmapped threads:{" "}
                  {board.unmapped_threads}.
                </p>
              ) : null}
              {cards.slice(0, 8).map((c) => (
                <button
                  key={c.company_id}
                  type="button"
                  className={
                    selected?.company_id === c.company_id
                      ? "vp-signal is-on"
                      : "vp-signal"
                  }
                  onClick={() => {
                    setOpenId(c.company_id);
                    setThemeFilter(null);
                    setEvidenceOn(false);
                  }}
                >
                  <div className="vp-icon">{c.initials}</div>
                  <div>
                    <div className="vp-name">{c.company_name}</div>
                    <div className="vp-meta">
                      {c.ticker || "UNMAPPED"} · {c.row.components.contributors_30d}{" "}
                      contributors · {c.row.components.mentions_30d} in 30D
                    </div>
                    <div className="vp-why">{c.why}</div>
                  </div>
                  <div className={`vp-score ${scoreClass(c.row.signal)}`}>
                    {c.row.signal == null ? "—" : c.row.signal}
                  </div>
                </button>
              ))}
            </div>
            <div className="vp-divider" />
            <div className="vp-col vp-mentions">
              {selected ? (
                <>
                  <div className="vp-metric">
                    <div>
                      <div className="vp-label">Mentions</div>
                      <div className="vp-big">
                        {selected.row.components.mentions_all}
                      </div>
                      <div
                        className={
                          (selected.row.components.momentum_30d.pct ?? 0) >= 0
                            ? "vp-delta"
                            : "vp-delta is-down"
                        }
                      >
                        {selected.row.components.momentum_30d.label ===
                        "NEW ACTIVITY"
                          ? "NEW ACTIVITY"
                          : selected.row.components.momentum_30d.label ===
                              "NO ACTIVITY"
                            ? "No 30D activity"
                            : `↑ ${fmtPct(selected.row.components.momentum_30d.pct)} vs previous 30D`}
                      </div>
                    </div>
                    <div className="vp-metric-r">
                      <div className="vp-label">Signal</div>
                      <div className="vp-big vp-big-sm">
                        {selected.row.signal == null
                          ? "N/A"
                          : selected.row.signal}
                      </div>
                      <div className="vp-delta">{selected.row.signal_label}</div>
                    </div>
                  </div>
                  {months.length ? (
                    <div className="vp-chart" aria-label="Monthly mentions">
                      {months.map((m) => {
                        const h = (n: number) =>
                          Math.max(n ? 4 : 0, (n / maxBar) * 160);
                        return (
                          <div key={m.month} className="vp-bar" title={m.month}>
                            {m.pos ? (
                              <i className="vp-seg pos" style={{ height: h(m.pos) }} />
                            ) : null}
                            {m.neu ? (
                              <i className="vp-seg neu" style={{ height: h(m.neu) }} />
                            ) : null}
                            {m.q ? (
                              <i className="vp-seg q" style={{ height: h(m.q) }} />
                            ) : null}
                            {m.neg ? (
                              <i className="vp-seg neg" style={{ height: h(m.neg) }} />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="vp-empty-inline">
                      Not enough ValuePickr history for a trend.
                    </p>
                  )}
                  <div className="vp-legend">
                    <span>
                      <i className="vp-dot pos" />
                      Positive keywords
                    </span>
                    <span>
                      <i className="vp-dot neg" />
                      Negative keywords
                    </span>
                    <span>
                      <i className="vp-dot neu" />
                      Other
                    </span>
                    <span>
                      <i className="vp-dot q" />
                      Questions
                    </span>
                  </div>
                  <div className="vp-stat-row">
                    <span>30D {fmtN(selected.row.components.mentions_30d)}</span>
                    <span>90D {fmtN(selected.row.components.mentions_90d)}</span>
                    <span>12M {fmtN(selected.row.components.mentions_12m)}</span>
                  </div>
                </>
              ) : (
                <p className="vp-empty-inline">
                  Awaiting ValuePickr data for mention activity.
                </p>
              )}
            </div>
          </section>

          <section className="vp-card">
            {selected ? (
              <>
                <div className="vp-company-head">
                  <div className="vp-company-icon">{selected.initials}</div>
                  <div>
                    <div className="vp-company-name">{selected.company_name}</div>
                    <div className="vp-company-meta">
                      {selected.ticker || "UNMAPPED COMPANY"} · VALUEPICKR ·{" "}
                      {selected.row.components.contributors_30d} contributors ·{" "}
                      {selected.row.components.mentions_all} mentions
                    </div>
                  </div>
                </div>
                <div className="vp-rings">
                  <div className="vp-ring-box">
                    <div className="vp-period">1D</div>
                    <div className="vp-ring">
                      {selected.row.components.mentions_1d || "—"}
                    </div>
                    <div className="vp-ring-label">Mentions</div>
                  </div>
                  <div className="vp-ring-box">
                    <div className="vp-period">30D</div>
                    <div className="vp-ring">
                      {selected.row.signal == null ? "—" : selected.row.signal}
                    </div>
                    <div className="vp-ring-label">{selected.row.signal_label}</div>
                  </div>
                </div>
                <div className="vp-quality">
                  Data quality: {selected.row.quality.grade}
                  <div className="vp-quality-why">{selected.row.quality.why}</div>
                </div>
              </>
            ) : (
              <p className="vp-empty-inline">INSUFFICIENT DATA</p>
            )}
          </section>

          <section className="vp-card">
            <div className="vp-label">Contributor mix</div>
            {selected ? (
              <>
                <div className="vp-track">
                  <div>
                    <div className="vp-elite">
                      {selected.row.components.contributors_30d} authors
                    </div>
                    <div className="vp-track-desc">
                      Distinct ValuePickr accounts in 30D ·{" "}
                      {selected.row.components.new_contributors_30d} new ·{" "}
                      {selected.row.components.returning_30d} returning ·{" "}
                      {selected.row.components.posts_per_contributor_30d == null
                        ? "N/A"
                        : `${selected.row.components.posts_per_contributor_30d.toFixed(1)} posts/author`}
                    </div>
                  </div>
                  <div className="vp-crown" aria-hidden>
                    ♛
                  </div>
                </div>
                <div className="vp-calls">
                  {tonePosts.length
                    ? tonePosts.map((p, i) => {
                        const t = tagPostTone(p.excerpt);
                        const cls =
                          t === "q" ? "q" : t === "pos" ? "" : t === "neg" ? "bad" : "neu";
                        return <i key={`${p.url}-${i}`} className={`vp-call ${cls}`} />;
                      })
                    : null}
                </div>
                <div className="vp-track-desc">
                  Last {tonePosts.length} posts tagged by keyword · {posN} growth
                  language · {negN} risk language
                </div>
              </>
            ) : (
              <p className="vp-empty-inline">
                Not enough ValuePickr history to calculate this signal.
              </p>
            )}
          </section>

          <section className="vp-card">
            <div className="vp-label">ValuePickr sources</div>
            {(board.sources ?? []).length === 0 ? (
              <p className="vp-empty-inline">Awaiting ValuePickr data.</p>
            ) : (
              board.sources.map((s) => (
                <div key={s.name} className="vp-source">
                  <div className="vp-source-left">
                    <div className="vp-source-icon">{sourceInitials(s.name)}</div>
                    <div>
                      <div className="vp-source-name">{s.name}</div>
                      <div className="vp-source-meta">{s.posts} posts ingested</div>
                    </div>
                  </div>
                  <div className="vp-source-score">
                    {s.avg_signal == null ? "N/A" : s.avg_signal}
                  </div>
                </div>
              ))
            )}
            <p className="vp-foot-note">
              {board.unmapped_threads} unmapped threads kept for review ·{" "}
              {board.posts_total} posts · ingested{" "}
              {board.ingested_at ? fmtDay(board.ingested_at) : "never"}
            </p>
          </section>
        </div>
      ) : null}

      {detail?.themes?.length ? (
        <section className="vp-card vp-wide">
          <div className="vp-label">Discussion themes</div>
          <div className="vp-title">Keyword matches in qualifying posts</div>
          <table className="vp-table">
            <thead>
              <tr>
                <th>Theme</th>
                <th>Posts</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {detail.themes.map((t) => (
                <tr
                  key={t.theme}
                  className={themeFilter === t.theme ? "is-on" : ""}
                  onClick={() => {
                    setThemeFilter((cur) => (cur === t.theme ? null : t.theme));
                    setEvidenceOn(true);
                  }}
                >
                  <td>{t.theme}</td>
                  <td>{t.posts}</td>
                  <td>{t.pct.toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {board?.latest?.length ? (
        <section className="vp-card vp-wide">
          <div className="vp-label">Recent ValuePickr discussions</div>
          <table className="vp-table">
            <thead>
              <tr>
                <th>Author</th>
                <th>Date</th>
                <th>Company</th>
                <th>Thread</th>
                <th>Excerpt</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {board.latest.slice(0, 20).map((p, i) => (
                <tr key={`${p.url}-${i}`}>
                  <td>{p.author}</td>
                  <td>{fmtDay(p.date)}</td>
                  <td>{p.company}</td>
                  <td>{p.thread}</td>
                  <td>{p.excerpt}</td>
                  <td>
                    <a href={p.url} target="_blank" rel="noopener noreferrer">
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {selected ? (
        <section className="vp-card vp-wide">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setEvidenceOn((v) => !v)}
          >
            {evidenceOn ? "Hide evidence" : "View evidence"}
          </button>
          {evidenceOn && detail?.row ? (
            <div className="vp-evidence">
              <p>
                Activity signal:{" "}
                {detail.row.signal == null ? "INSUFFICIENT DATA" : detail.row.signal}
              </p>
              <ul>
                <li>{detail.row.components.mentions_all} total mentions</li>
                <li>
                  {detail.row.quality.contributors} unique contributors
                </li>
                <li>
                  {detail.row.components.mentions_30d} mentions in last 30D
                </li>
                <li>
                  {detail.row.components.momentum_30d.previous} mentions in previous
                  30D
                </li>
                <li>
                  {detail.row.components.contributors_30d} current contributors
                </li>
                <li>
                  {detail.row.components.new_contributors_30d} new contributors
                </li>
                <li>
                  {detail.row.components.persistence.active_months_all} active
                  months
                </li>
              </ul>
              {themeFilter ? (
                <p className="vp-foot-note">Filtered to theme: {themeFilter}</p>
              ) : null}
              <table className="vp-table">
                <thead>
                  <tr>
                    <th>Author</th>
                    <th>Date</th>
                    <th>Thread</th>
                    <th>Excerpt</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {evidencePosts.map((p, i) => (
                    <tr key={`${p.url}-e-${i}`}>
                      <td>{p.author}</td>
                      <td>{fmtDay(p.date)}</td>
                      <td>{p.thread}</td>
                      <td>{p.excerpt}</td>
                      <td>
                        <a href={p.url} target="_blank" rel="noopener noreferrer">
                          Open
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="vp-footer">
        ValuePickr evidence first · deterministic signals · zero fabrication
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tradingviewUrl } from "@/lib/links";

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
};

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function fmtN(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(n);
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function scoreClass(n: number | null): "g" | "m" | "a" {
  if (n == null) return "a";
  if (n >= 80) return "g";
  if (n >= 60) return "m";
  return "a";
}

function momentumLine(m: Momentum): string {
  if (m.label === "NEW ACTIVITY") return "New 30D activity";
  if (m.label === "NO ACTIVITY") return "No 30D activity";
  return `${fmtPct(m.pct)} vs prior 30D`;
}

function monthLabel(ym: string): string {
  const mo = Number(ym.slice(5, 7));
  if (!Number.isFinite(mo) || mo < 1 || mo > 12) return ym;
  return MONTH_SHORT[mo - 1]!;
}

function mentionTicks(max: number): number[] {
  const m = Math.max(1, Math.ceil(max));
  const step =
    m <= 5 ? 1 : m <= 20 ? 5 : m <= 50 ? 10 : m <= 100 ? 25 : m <= 250 ? 50 : 100;
  const top = Math.max(step, Math.ceil(m / step) * step);
  const ticks: number[] = [];
  for (let v = top; v >= 0; v -= step) ticks.push(v);
  return ticks;
}

function last12Months(months: MonthBar[], asOf = new Date()): MonthBar[] {
  const by = new Map(months.map((m) => [m.month, m]));
  const end = months.length
    ? months[months.length - 1]!.month
    : `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`;
  const [ey, em] = end.split("-").map(Number);
  let y = ey!;
  let mo = em!;
  const keys: string[] = [];
  for (let i = 0; i < 12; i++) {
    keys.push(`${y}-${String(mo).padStart(2, "0")}`);
    mo -= 1;
    if (mo < 1) {
      mo = 12;
      y -= 1;
    }
  }
  keys.reverse();
  return keys.map(
    (month) =>
      by.get(month) ?? { month, pos: 0, neg: 0, neu: 0, q: 0, total: 0 },
  );
}

function SentimentGraph({ months }: { months: MonthBar[] }) {
  const series = last12Months(months);
  const maxTotal = Math.max(1, ...series.map((m) => m.total));
  const ticks = mentionTicks(maxTotal);
  const top = ticks[0] ?? 1;
  const chartH = 160;

  return (
    <div className="vp-sentiment">
      <div className="vp-label">Mentions</div>
      <div className="vp-sentiment-body">
        <div className="vp-sentiment-y" style={{ height: chartH }} aria-hidden>
          {ticks.map((t) => (
            <span
              key={t}
              className="vp-sentiment-tick"
              style={{ bottom: `${(t / top) * 100}%` }}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="vp-sentiment-main">
          <div className="vp-sentiment-plot" style={{ height: chartH }}>
            <div className="vp-sentiment-grid" aria-hidden>
              {ticks.map((t) => (
                <i
                  key={t}
                  className="vp-sentiment-gridline"
                  style={{ bottom: `${(t / top) * 100}%` }}
                />
              ))}
            </div>
            <div className="vp-sentiment-bars">
              {series.map((m) => {
                const stackH = (m.total / top) * chartH;
                const seg = (n: number) =>
                  m.total ? (n / m.total) * stackH : 0;
                return (
                  <div key={m.month} className="vp-sentiment-col">
                    <div
                      className="vp-sentiment-stack"
                      style={{ height: Math.max(stackH, m.total ? 4 : 0) }}
                      title={`${m.month}: ${m.total} · +${m.pos} / ?${m.q} / −${m.neg} / ·${m.neu}`}
                    >
                      {m.pos ? (
                        <i
                          className="vp-seg pos"
                          style={{ height: seg(m.pos) }}
                        />
                      ) : null}
                      {m.q ? (
                        <i className="vp-seg q" style={{ height: seg(m.q) }} />
                      ) : null}
                      {m.neg ? (
                        <i
                          className="vp-seg neg"
                          style={{ height: seg(m.neg) }}
                        />
                      ) : null}
                      {m.neu ? (
                        <i
                          className="vp-seg neu"
                          style={{ height: seg(m.neu) }}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="vp-sentiment-xrow">
            {series.map((m) => (
              <span key={m.month} className="vp-sentiment-x">
                {monthLabel(m.month)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="vp-legend">
        <span>
          <i className="vp-dot pos" />
          Growth
        </span>
        <span>
          <i className="vp-dot q" />
          Questions
        </span>
        <span>
          <i className="vp-dot neg" />
          Risk
        </span>
        <span>
          <i className="vp-dot neu" />
          Other
        </span>
      </div>
    </div>
  );
}

export function ValuePickrSignalsPanel() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Evidence | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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
        let json = await load("");
        if (dead) return;
        if (json.posts_total === 0) {
          setIngesting(true);
          const ing = await fetch("/api/valuepickr/ingest", { method: "POST" });
          const body = (await ing.json()) as { ok?: boolean; error?: string };
          if (!ing.ok || body.ok === false) {
            throw new Error(body.error || "Ingest failed");
          }
          json = await load("");
          if (dead) return;
        }
        if (json.companies[0]) setOpenId(json.companies[0].company_id);
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
    let dead = false;
    void (async () => {
      setDetailLoading(true);
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
        if (!dead) setDetail(json);
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!dead) setDetailLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [openId]);

  const cards = board?.companies ?? [];
  const selected = useMemo(() => {
    if (openId) return cards.find((c) => c.company_id === openId) ?? cards[0];
    return cards[0];
  }, [cards, openId]);

  const months = detail?.months ?? [];

  const refresh = async () => {
    setIngesting(true);
    setError(null);
    try {
      const ing = await fetch("/api/valuepickr/ingest", { method: "POST" });
      const body = (await ing.json()) as { ok?: boolean; error?: string };
      if (!ing.ok || body.ok === false) {
        throw new Error(body.error || "Ingest failed");
      }
      const json = await load(q);
      if (
        json.companies[0] &&
        !json.companies.some((c) => c.company_id === openId)
      ) {
        setOpenId(json.companies[0].company_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIngesting(false);
    }
  };

  return (
    <div className="vp-page">
      <header className="vp-top">
        <div className="vp-card-meta">
          {board
            ? `${cards.length} companies · ${board.posts_total} posts`
            : "\u00a0"}
        </div>
        <div className="vp-top-actions">
          <input
            className="vp-search"
            placeholder="Search company…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void load(q).then((json) => {
                  if (json.companies[0]) setOpenId(json.companies[0].company_id);
                });
              }
            }}
            aria-label="Search companies"
          />
          <button
            type="button"
            className="btn-ghost"
            disabled={ingesting}
            onClick={() => void refresh()}
          >
            {ingesting ? "Reading forum…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <div className="vp-banner is-err">{error}</div> : null}
      {loading ? <div className="vp-banner">Loading…</div> : null}

      {!loading && board && board.posts_total === 0 ? (
        <div className="vp-empty">
          <strong>No forum data yet</strong>
          <p>Refresh to pull latest ValuePickr discussions.</p>
        </div>
      ) : null}

      {board && board.posts_total > 0 ? (
        <div className="vp-grid">
          <section className="vp-card vp-list-card">
            <div className="vp-card-head">
              <div className="vp-label">Top signals</div>
            </div>
            {cards.length === 0 ? (
              <p className="vp-empty-inline">
                No mapped companies match. Unmapped threads:{" "}
                {board.unmapped_threads}.
              </p>
            ) : (
              <div className="vp-signal-list">
                {cards.slice(0, 12).map((c) => {
                  const tv = c.ticker ? tradingviewUrl(c.ticker) : null;
                  return (
                    <div
                      key={c.company_id}
                      role="button"
                      tabIndex={0}
                      className={
                        selected?.company_id === c.company_id
                          ? "vp-signal is-on"
                          : "vp-signal"
                      }
                      onClick={() => setOpenId(c.company_id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenId(c.company_id);
                        }
                      }}
                    >
                      <div className="vp-icon">{c.initials}</div>
                      <div className="vp-signal-body">
                        {tv ? (
                          <a
                            className="vp-name vp-tv-name"
                            href={tv}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open ${c.ticker} on TradingView`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {c.company_name}
                          </a>
                        ) : (
                          <div className="vp-name">{c.company_name}</div>
                        )}
                        <div className="vp-meta">
                          {tv ? (
                            <a
                              className="vp-tv-chip"
                              href={tv}
                              target="_blank"
                              rel="noreferrer"
                              title={`Open ${c.ticker} on TradingView`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {c.ticker} · TV
                            </a>
                          ) : (
                            "UNMAPPED"
                          )}{" "}
                          · {c.row.components.contributors_30d} auth ·{" "}
                          {c.row.components.mentions_30d} / 30D
                        </div>
                        <div className="vp-why">{c.why}</div>
                      </div>
                      <div className={`vp-score ${scoreClass(c.row.signal)}`}>
                        {c.row.signal == null ? "—" : c.row.signal}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="vp-card vp-detail-card">
            {selected ? (
              <>
                <div className="vp-company-head">
                  <div className="vp-company-icon">{selected.initials}</div>
                  <div>
                    {selected.ticker ? (
                      <a
                        className="vp-company-name vp-tv-name"
                        href={tradingviewUrl(selected.ticker)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${selected.ticker} on TradingView`}
                      >
                        {selected.company_name}
                      </a>
                    ) : (
                      <div className="vp-company-name">
                        {selected.company_name}
                      </div>
                    )}
                    <div className="vp-company-meta">
                      {selected.ticker ? (
                        <a
                          className="vp-tv-chip"
                          href={tradingviewUrl(selected.ticker)}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open ${selected.ticker} on TradingView`}
                        >
                          {selected.ticker} · TV
                        </a>
                      ) : (
                        "UNMAPPED"
                      )}{" "}
                      · {selected.row.components.contributors_30d} contributors ·{" "}
                      {selected.row.components.mentions_all} mentions
                    </div>
                  </div>
                </div>

                <div className="vp-metric">
                  <div>
                    <div className="vp-label">Total</div>
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
                      {momentumLine(selected.row.components.momentum_30d)}
                    </div>
                  </div>
                  <div className="vp-metric-r">
                    <div className="vp-label">Signal</div>
                    <div className="vp-big vp-big-sm">
                      {selected.row.signal == null ? "—" : selected.row.signal}
                    </div>
                    <div className="vp-delta">{selected.row.signal_label}</div>
                  </div>
                </div>

                <div className="vp-stat-row">
                  <span>1D {fmtN(selected.row.components.mentions_1d)}</span>
                  <span>30D {fmtN(selected.row.components.mentions_30d)}</span>
                  <span>90D {fmtN(selected.row.components.mentions_90d)}</span>
                  <span>12M {fmtN(selected.row.components.mentions_12m)}</span>
                </div>

                {detailLoading ? (
                  <p className="vp-empty-inline">Loading sentiment…</p>
                ) : months.length ? (
                  <SentimentGraph months={months} />
                ) : (
                  <p className="vp-empty-inline">
                    Not enough dated posts for a sentiment graph.
                  </p>
                )}
              </>
            ) : (
              <p className="vp-empty-inline">Select a company.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

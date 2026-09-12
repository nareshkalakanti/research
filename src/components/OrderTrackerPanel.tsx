"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { tradingviewUrl } from "@/lib/links";
import { WatchButton } from "@/components/WatchButton";

type TrackerOrder = {
  id: string;
  history_id: number;
  source_url: string | null;
  ticker: string;
  company: string;
  customer: string;
  order_type: string;
  order_date: string | null;
  news_date: string | null;
  contract_value_cr: number | null;
  duration: string;
  duration_months: number | null;
  annual_value_cr: number | null;
  order_size_pct: number | null;
  sales_cr: number | null;
  sales_year: string | null;
  market_cap_cr: number | null;
  decision: "pass" | "fail" | "pending";
  prior_count: number;
  screened_at: string;
};

type TrackerCompany = {
  ticker: string;
  company: string;
  order_count: number;
  total_order_value_cr: number;
  sales_cr: number | null;
  sales_year: string | null;
  orders_as_pct_of_revenue: number | null;
  market_cap_cr: number | null;
  orders: TrackerOrder[];
};

type TrackerResponse = {
  ok: boolean;
  orders: TrackerOrder[];
  companies: TrackerCompany[];
  customers: string[];
  companies_filter: Array<{ ticker: string; company: string }>;
  pass_min_pct?: number;
  error?: string;
};

type ViewMode = "all" | "company";

const MCAP_STEPS = [
  { label: "0", value: "" },
  { label: "100", value: "100" },
  { label: "500", value: "500" },
  { label: "2k", value: "2000" },
  { label: "10k", value: "10000" },
  { label: "Max", value: "100000" },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "Not mentioned";
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "Not mentioned";
  const abs = Math.abs(n);
  if (abs >= 1) {
    return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
  }
  if (abs >= 0.01) {
    return `₹${(n * 100).toLocaleString("en-IN", {
      maximumFractionDigits: 1,
    })} L`;
  }
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

function pctTone(n: number | null | undefined): "hi" | "mid" | "lo" | "none" {
  if (n == null || !Number.isFinite(n) || n <= 0) return "none";
  if (n >= 5) return "hi";
  if (n >= 0.5) return "mid";
  return "lo";
}

function displayType(t: string): string {
  if (!t || t === "Not disclosed") return "Not mentioned";
  return t;
}

function pdfHref(url: string | null): string | null {
  if (!url?.trim()) return null;
  return `/api/orderbook-screen?pdf=${encodeURIComponent(url.trim())}`;
}

function PdfIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CompanyLink({
  ticker,
  company,
  onOpen,
}: {
  ticker: string;
  company: string;
  /** When set, click opens company accordion instead of TradingView. */
  onOpen?: (ticker: string) => void;
}) {
  return (
    <div className="company-watch-cell otrd-watch-cell">
      <WatchButton ticker={ticker} />
      {onOpen ? (
        <button
          type="button"
          className="otrd-co-link"
          title={`Open ${ticker} orders`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(ticker);
          }}
        >
          {company}
        </button>
      ) : (
        <a
          className="otrd-co-link"
          href={tradingviewUrl(ticker, "NSE")}
          target="_blank"
          rel="noreferrer"
          title={ticker}
          onClick={(e) => e.stopPropagation()}
        >
          {company}
        </a>
      )}
    </div>
  );
}

function PctPill({ value }: { value: number | null }) {
  return (
    <span className={`otrd-pct otrd-pct-${pctTone(value)}`}>
      {fmtPct(value)}
    </span>
  );
}

function DurationCell({ order }: { order: TrackerOrder }) {
  if (order.duration_months != null) {
    return <>{order.duration_months} months</>;
  }
  if (!order.duration || order.duration === "Not mentioned") {
    return <>Not mentioned</>;
  }
  return <>{order.duration}</>;
}

function OrdersTable({
  orders,
  compact,
  onOpenCompany,
}: {
  orders: TrackerOrder[];
  compact?: boolean;
  onOpenCompany?: (ticker: string) => void;
}) {
  if (!orders.length) {
    return <p className="otrd-empty">No orders match these filters.</p>;
  }
  return (
    <div className="otrd-table-wrap">
      <table className="otrd-table">
        <thead>
          <tr>
            {!compact ? <th>Company</th> : (
              <th>
                Date <span className="otrd-sort">↓</span>
              </th>
            )}
            <th>Customer</th>
            <th>Order Type</th>
            {!compact ? (
              <th>
                Date <span className="otrd-sort">↓</span>
              </th>
            ) : null}
            <th>Contract Value</th>
            <th>Duration</th>
            <th>Annual Value</th>
            <th>{compact ? "Revenue %" : "Order Size %"}</th>
            {!compact ? <th>Company Revenue</th> : null}
            <th>PDF</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const pdf = pdfHref(o.source_url);
            return (
              <tr key={o.id}>
                {!compact ? (
                  <td>
                    <CompanyLink
                      ticker={o.ticker}
                      company={o.company}
                      onOpen={onOpenCompany}
                    />
                  </td>
                ) : (
                  <td>{fmtDate(o.order_date || o.news_date)}</td>
                )}
                <td className="otrd-muted">{o.customer}</td>
                <td className="otrd-muted">{displayType(o.order_type)}</td>
                {!compact ? (
                  <td>{fmtDate(o.order_date || o.news_date)}</td>
                ) : null}
                <td className="otrd-money">{fmtCr(o.contract_value_cr)}</td>
                <td className="otrd-muted">
                  <DurationCell order={o} />
                </td>
                <td className="otrd-money">{fmtCr(o.annual_value_cr)}</td>
                <td>
                  <PctPill value={o.order_size_pct} />
                </td>
                {!compact ? (
                  <td className="otrd-muted">
                    {o.sales_cr != null
                      ? `${fmtCr(o.sales_cr)}${
                          o.sales_year ? ` (${o.sales_year})` : ""
                        }`
                      : "Not mentioned"}
                  </td>
                ) : null}
                <td>
                  <div className="otrd-pdf-cell">
                    {pdf ? (
                      <a
                        className="otrd-pdf"
                        href={pdf}
                        target="_blank"
                        rel="noreferrer"
                        title="Open PDF"
                      >
                        <PdfIcon />
                      </a>
                    ) : (
                      <span className="otrd-muted">—</span>
                    )}
                    {o.prior_count > 0 ? (
                      <span
                        className="otrd-his"
                        title={`${o.prior_count} earlier win(s) for this ticker`}
                      >
                        His
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Props = {
  /** Standalone page chrome (back link to app). */
  standalone?: boolean;
};

export function OrderTrackerPanel({ standalone = false }: Props) {
  const [view, setView] = useState<ViewMode>("all");
  const [ticker, setTicker] = useState("");
  const [customer, setCustomer] = useState("");
  const [minPct, setMinPct] = useState("0");
  const [months, setMonths] = useState("6");
  const [minMcap, setMinMcap] = useState("");
  const [passOnly, setPassOnly] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<TrackerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Pinned company shown first in By Company; others stay below. */
  const [focusTicker, setFocusTicker] = useState<string | null>(null);

  const companyStack = useMemo(() => {
    const list = data?.companies ?? [];
    const needle = view === "company" ? q.trim() : "";
    const resolved = needle
      ? resolveLocalCompanyKey(needle, data?.companies_filter ?? list)
      : null;
    const filtered = needle
      ? list.filter((c) => {
          const n = needle.toLowerCase();
          return (
            c.ticker === resolved ||
            c.ticker.toLowerCase().includes(n) ||
            c.company.toLowerCase().includes(n)
          );
        })
      : list;
    const focus = focusTicker;
    if (!focus) return filtered;
    const hit = filtered.find((c) => c.ticker === focus);
    if (!hit) return filtered;
    return [hit, ...filtered.filter((c) => c.ticker !== focus)];
  }, [data?.companies, data?.companies_filter, focusTicker, q, view]);

  // Hoisted for useMemo — same rules as openCompany.
  function resolveLocalCompanyKey(
    raw: string,
    pool: Array<{ ticker: string; company: string }>,
  ): string | null {
    const text = raw.trim();
    if (!text) return null;
    const upper = text.toUpperCase();
    const exact = pool.find((c) => c.ticker === upper);
    if (exact) return exact.ticker;
    if (!/\s/.test(text) && text.length >= 2) {
      const prefs = pool.filter((c) => c.ticker.startsWith(upper));
      if (prefs.length === 1) return prefs[0]!.ticker;
    }
    const needle = text.toLowerCase();
    const names = pool.filter(
      (c) =>
        c.company.toLowerCase().includes(needle) ||
        c.ticker.toLowerCase().includes(needle),
    );
    if (names.length === 1) return names[0]!.ticker;
    if (names.length > 1) {
      const ranked = [...names].sort(
        (a, b) => a.ticker.length - b.ticker.length,
      );
      if (
        ranked[0] &&
        ranked[0].ticker.length < (ranked[1]?.ticker.length ?? 99)
      ) {
        return ranked[0].ticker;
      }
    }
    return null;
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ tracker: "1", limit: "200" });
      // All Orders may filter by one ticker; By Company always loads the stack.
      if (view === "all" && ticker) params.set("ticker", ticker);
      if (view === "all" && customer) params.set("customer", customer);
      // Company search is client-side so other companies stay in the stack.
      if (view === "all" && q.trim()) params.set("q", q.trim());
      if (minPct !== "" && minPct !== "0") params.set("minPct", minPct);
      if (months) params.set("months", months);
      if (minMcap) params.set("minMcap", minMcap);
      if (passOnly) params.set("passOnly", "1");
      const res = await fetch(`/api/orderbook-screen?${params}`);
      const json = (await res.json()) as TrackerResponse;
      if (!res.ok || json.error) {
        setError(json.error || "Tracker load failed");
        setData(null);
        return;
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tracker load failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [
    view,
    ticker,
    customer,
    minPct,
    months,
    minMcap,
    passOnly,
    // Only All Orders text search should refetch.
    view === "all" ? q : "",
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const companyOptions = data?.companies_filter ?? [];
  const customerOptions = data?.customers ?? [];

  function openCompany(t: string) {
    const key =
      resolveLocalCompanyKey(t, data?.companies_filter ?? data?.companies ?? []) ||
      t.trim().toUpperCase();
    if (!key) return;
    setFocusTicker(key);
    setExpanded(new Set([key]));
    setTicker("");
    setQ("");
    setView("company");
  }

  function toggleExpand(t: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
    setFocusTicker(t);
  }

  function salesLabel(c: TrackerCompany): string {
    if (c.sales_cr == null) return "Not mentioned";
    const yr = c.sales_year ? ` (${c.sales_year})` : "";
    return `${fmtCr(c.sales_cr)}${yr}`;
  }

  return (
    <div className="otrd-page">
      <div className="otrd-shell">
        {standalone ? (
          <div className="otrd-view-tabs" role="tablist">
            <button
              type="button"
              className={view === "all" ? "on" : ""}
              onClick={() => setView("all")}
            >
              All Orders
            </button>
            <button
              type="button"
              className={view === "company" ? "on" : ""}
              onClick={() => setView("company")}
            >
              By Company
            </button>
          </div>
        ) : null}

        <header className="otrd-head">
          <div>
            <h1 className="otrd-title">
              {view === "all" ? "All Orders" : "Consolidated Company View"}
            </h1>
            {view === "company" ? (
              <p className="otrd-sub">
                View all orders for each company as a percentage of their
                revenue.
              </p>
            ) : null}
          </div>
          {!standalone ? (
            <div className="otrd-view-tabs" role="tablist">
              <button
                type="button"
                className={view === "all" ? "on" : ""}
                onClick={() => setView("all")}
              >
                All Orders
              </button>
              <button
                type="button"
                className={view === "company" ? "on" : ""}
                onClick={() => setView("company")}
              >
                By Company
              </button>
            </div>
          ) : null}
        </header>

        <div className="otrd-filters">
          {view === "company" ? (
            <label className="otrd-field otrd-grow">
              <span className="otrd-sr">Search company</span>
              <input
                type="search"
                placeholder="Search Company"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
          ) : (
            <label className="otrd-field">
              <span className="otrd-sr">Company</span>
              <select
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
              >
                <option value="">Company</option>
                {companyOptions.map((c) => (
                  <option key={c.ticker} value={c.ticker}>
                    {c.company} ({c.ticker})
                  </option>
                ))}
              </select>
            </label>
          )}

          {view === "all" ? (
            <label className="otrd-field">
              <span className="otrd-sr">Customer</span>
              <select
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
              >
                <option value="">Customer</option>
                {customerOptions.map((c) => (
                  <option key={c} value={c}>
                    {c.length > 50 ? `${c.slice(0, 47)}…` : c}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="otrd-field">
              <span className="otrd-sr">Timeframe</span>
              <select
                value={months}
                onChange={(e) => setMonths(e.target.value)}
              >
                <option value="">All time</option>
                <option value="1">1 month</option>
                <option value="3">3 months</option>
                <option value="6">6 months</option>
                <option value="12">12 months</option>
              </select>
            </label>
          )}

          <label className="otrd-field otrd-narrow">
            <span className="otrd-sr">
              {view === "company" ? "Min revenue %" : "Min order size %"}
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              placeholder={
                view === "company" ? "Min Revenue %" : "Min Order Size %"
              }
              value={minPct}
              onChange={(e) => setMinPct(e.target.value)}
            />
          </label>

          {view === "company" ? (
            <div className="otrd-mcap">
              <span className="otrd-mcap-label">
                Market Cap:{" "}
                {minMcap
                  ? `Over ₹${Number(minMcap).toLocaleString("en-IN")} cr`
                  : "Any"}
              </span>
              <div className="otrd-mcap-steps">
                {MCAP_STEPS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className={minMcap === s.value ? "on" : ""}
                    onClick={() => setMinMcap(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <label className="otrd-pass">
            <input
              type="checkbox"
              checked={passOnly}
              onChange={(e) => setPassOnly(e.target.checked)}
            />
            PASS only
          </label>

          <button
            type="button"
            className="otrd-refresh"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshIcon />
            REFRESH
          </button>
        </div>

        {error ? <p className="otrd-error">{error}</p> : null}
        {loading && !data ? <p className="otrd-empty">Loading orders…</p> : null}

        {!loading && data && view === "all" ? (
          <OrdersTable orders={data.orders} onOpenCompany={openCompany} />
        ) : null}

        {!loading && data && view === "company" ? (
          <div className="otrd-companies">
            {companyStack.length === 0 ? (
              <p className="otrd-empty">No companies match these filters.</p>
            ) : (
              companyStack.map((c) => {
                const open = expanded.has(c.ticker);
                return (
                  <section
                    key={c.ticker}
                    className={`otrd-co-card${
                      focusTicker === c.ticker ? " is-focus" : ""
                    }`}
                  >
                    <div className="otrd-co-summary">
                      <WatchButton ticker={c.ticker} />
                      <button
                        type="button"
                        className="otrd-co-expand"
                        onClick={() => toggleExpand(c.ticker)}
                        aria-expanded={open}
                      >
                        <span className="otrd-chev">{open ? "▴" : "▾"}</span>
                        <span className="otrd-co-link">{c.company}</span>
                        <PctPill value={c.orders_as_pct_of_revenue} />
                        <span className="otrd-co-count">
                          {c.order_count} order{c.order_count === 1 ? "" : "s"}
                        </span>
                        <span className="otrd-money otrd-co-total">
                          {fmtCr(c.total_order_value_cr)}
                        </span>
                        <span className="otrd-muted otrd-co-sales">
                          {salesLabel(c)}
                        </span>
                      </button>
                      <a
                        className="otrd-tv"
                        href={tradingviewUrl(c.ticker, "NSE")}
                        target="_blank"
                        rel="noreferrer"
                        title="TradingView"
                      >
                        TV
                      </a>
                    </div>
                    {open ? (
                      <div className="otrd-co-body">
                        <h3 className="otrd-co-orders-title">
                          Individual Orders
                        </h3>
                        <OrdersTable orders={c.orders} compact />
                      </div>
                    ) : null}
                  </section>
                );
              })
            )}
          </div>
        ) : null}

        <p className="otrd-disclaimer">
          Order details are extracted using AI and may contain errors. Please
          verify the information by checking the PDF documents before making any
          business decisions.
        </p>
      </div>
    </div>
  );
}

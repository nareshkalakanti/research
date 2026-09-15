"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { tradingviewUrl, bseScripCodeFromTicker } from "@/lib/links";
import { WatchButton } from "@/components/WatchButton";
import { LiveNseFeedBadge } from "@/components/LiveNseFeedBadge";
import { LiveBseFeedBadge } from "@/components/LiveBseFeedBadge";
import type { NseFeedStatus } from "@/lib/nse-feed-status-types";

type TrackerOrder = {
  id: string;
  history_id: number;
  source_url: string | null;
  ticker: string;
  company: string;
  market: string | null;
  customer: string;
  order_type: string;
  order_date: string | null;
  news_date: string | null;
  contract_value_cr: number | null;
  contract_value_note?: string | null;
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
  market: string | null;
  order_count: number;
  total_order_value_cr: number | null;
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
  nse_feed?: NseFeedStatus;
  bse_feed?: NseFeedStatus;
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
  // Treat explicit 0 as unknown for display — never show a fake ₹0 Cr total.
  if (n === 0) return "—";
  const abs = Math.abs(n);
  if (abs >= 1) {
    // Up to 2 decimals so 8.42 Cr isn't rounded to 8.4 (breaks % checks).
    return `₹${n.toLocaleString("en-IN", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
    })} Cr`;
  }
  if (abs >= 0.01) {
    return `₹${(n * 100).toLocaleString("en-IN", {
      maximumFractionDigits: 1,
      minimumFractionDigits: 0,
    })} L`;
  }
  return `₹${n.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })} Cr`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })}%`;
}

function orderPctTitle(opts: {
  pct: number | null | undefined;
  orderCr: number | null | undefined;
  salesCr: number | null | undefined;
  salesYear?: string | null;
}): string | undefined {
  const { pct, orderCr, salesCr, salesYear } = opts;
  if (pct == null || orderCr == null || salesCr == null || salesCr <= 0) {
    return undefined;
  }
  const yr = salesYear ? ` (${salesYear})` : "";
  return `Order ${fmtCr(orderCr)} ÷ sales ${fmtCr(salesCr)}${yr} = ${fmtPct(pct)}`;
}

function annualValueTitle(opts: {
  contractCr: number | null | undefined;
  annualCr: number | null | undefined;
  months: number | null | undefined;
}): string | undefined {
  const { contractCr, annualCr, months } = opts;
  if (contractCr == null || annualCr == null) return undefined;
  if (months == null || months <= 0) {
    return "Annual value = contract (no usable duration)";
  }
  if (months <= 12) {
    return `Duration ${months} mo ≤ 12 — annual value = full contract ${fmtCr(contractCr)} (not annualized up)`;
  }
  const years = Math.round((months / 12) * 100) / 100;
  return `Duration ${months} mo (~${years}y) — annual value = ${fmtCr(contractCr)} ÷ ${years} = ${fmtCr(annualCr)}`;
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

function exchangeLabel(ticker: string, market?: string | null): "NSE" | "BSE" {
  if (bseScripCodeFromTicker(ticker)) return "BSE";
  const mk = (market || "").toUpperCase();
  if (mk.includes("BSE") || /^BSE/i.test(ticker)) return "BSE";
  return "NSE";
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
  market,
  onOpen,
}: {
  ticker: string;
  company: string;
  market?: string | null;
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
          href={tradingviewUrl(ticker, market)}
          target="_blank"
          rel="noreferrer"
          title={
            bseScripCodeFromTicker(ticker)
              ? `${ticker} — BSE India`
              : `${ticker} — TradingView`
          }
          onClick={(e) => e.stopPropagation()}
        >
          {company}
        </a>
      )}
    </div>
  );
}

function PctPill({
  value,
  title,
}: {
  value: number | null;
  title?: string;
}) {
  return (
    <span className={`otrd-pct otrd-pct-${pctTone(value)}`} title={title}>
      {fmtPct(value)}
    </span>
  );
}

function DurationCell({ order }: { order: TrackerOrder }) {
  const raw = (order.duration || "").trim();
  // Prefer filing text ("2-3 months") over parsed midpoint ("3 months").
  if (raw && raw !== "Not mentioned" && !/^not\s+disclosed$/i.test(raw)) {
    return (
      <span
        title={
          order.duration_months != null
            ? `Parsed ~${order.duration_months} months for annualization`
            : undefined
        }
      >
        {raw}
      </span>
    );
  }
  if (order.duration_months != null) {
    return <>{order.duration_months} months</>;
  }
  return <>Not mentioned</>;
}

function salesYearLabel(year: string | null | undefined): string {
  if (!year?.trim()) return "";
  const y = year.trim();
  // ISO period end → FY label (Indian FY ends Mar).
  const m = y.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const yr = Number(m[1]);
    const mo = Number(m[2]);
    const fy = mo >= 4 ? yr + 1 : yr;
    return ` (FY${fy})`;
  }
  if (/^FY/i.test(y)) return ` (${y})`;
  return ` (${y})`;
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
            <th>Order Size %</th>
            <th>Company Revenue</th>
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
                      market={o.market}
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
                <td
                  className="otrd-money"
                  title={
                    o.contract_value_note ||
                    (o.contract_value_cr == null
                      ? "Order value not stated in filing"
                      : undefined)
                  }
                >
                  {fmtCr(o.contract_value_cr)}
                </td>
                <td className="otrd-muted">
                  <DurationCell order={o} />
                </td>
                <td
                  className="otrd-money"
                  title={annualValueTitle({
                    contractCr: o.contract_value_cr,
                    annualCr: o.annual_value_cr,
                    months: o.duration_months,
                  })}
                >
                  {fmtCr(o.annual_value_cr)}
                </td>
                <td>
                  <PctPill
                    value={o.order_size_pct}
                    title={orderPctTitle({
                      pct: o.order_size_pct,
                      orderCr: o.contract_value_cr,
                      salesCr: o.sales_cr,
                      salesYear: o.sales_year,
                    })}
                  />
                </td>
                <td
                  className="otrd-muted"
                  title={
                    o.sales_cr != null
                      ? `Latest annual sales used for Order Size %${
                          o.sales_year ? ` · ${o.sales_year}` : ""
                        }`
                      : "Company revenue not available"
                  }
                >
                  {o.sales_cr != null
                    ? `${fmtCr(o.sales_cr)}${salesYearLabel(o.sales_year)}`
                    : "—"}
                </td>
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
  /**
   * Controlled view when embedded under OrderBookIQ tabs.
   * Omit for internal All / By Company toggle.
   */
  view?: ViewMode;
  onViewChange?: (v: ViewMode) => void;
  /** Hide All / By Company tabs — parent chrome owns them. */
  hideViewTabs?: boolean;
  /** Skip page shell — parent already wraps with otrd-page / otrd-shell. */
  embedInParent?: boolean;
};

export function OrderTrackerPanel({
  view: viewProp,
  onViewChange,
  hideViewTabs = false,
  embedInParent = false,
}: Props) {
  const [viewInternal, setViewInternal] = useState<ViewMode>("all");
  const view = viewProp ?? viewInternal;
  const setView = (v: ViewMode) => {
    if (onViewChange) onViewChange(v);
    else setViewInternal(v);
  };
  const [ticker, setTicker] = useState("");
  const [customer, setCustomer] = useState("");
  const [minPct, setMinPct] = useState("0");
  const [months, setMonths] = useState("6");
  const [minMcap, setMinMcap] = useState("");
  const [passOnly, setPassOnly] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<TrackerResponse | null>(null);
  const [nseFeed, setNseFeed] = useState<NseFeedStatus | null>(null);
  const [bseFeed, setBseFeed] = useState<NseFeedStatus | null>(null);
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
      if (json.nse_feed) setNseFeed(json.nse_feed);
      if (json.bse_feed) setBseFeed(json.bse_feed);
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
    if (c.sales_cr == null) return "—";
    return `${fmtCr(c.sales_cr)}${salesYearLabel(c.sales_year)}`;
  }

  function salesTitle(c: TrackerCompany): string | undefined {
    if (c.sales_cr == null) return "Company revenue not available";
    const yr = c.sales_year ? ` · ${c.sales_year}` : "";
    return `Company annual sales used for Order Size %${yr}`;
  }

  return (
    <div className={embedInParent ? "otrd-embed" : "otrd-page"}>
      <div className={embedInParent ? "otrd-embed-inner" : "otrd-shell"}>
        {!hideViewTabs ? (
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
          <div className="otrd-head-feeds">
            <LiveNseFeedBadge status={nseFeed} compact />
            <LiveBseFeedBadge status={bseFeed} compact />
          </div>
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
              <div className="otrd-table-wrap otrd-co-table-wrap">
                <table className="otrd-table otrd-co-table">
                  <thead>
                    <tr>
                      <th>Company Name</th>
                      <th>
                        Orders as % of Revenue{" "}
                        <span className="otrd-sort">↓</span>
                      </th>
                      <th>Order Count</th>
                      <th>Total Order Value</th>
                      <th>Company Revenue</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {companyStack.map((c) => {
                      const open = expanded.has(c.ticker);
                      return (
                        <Fragment key={c.ticker}>
                          <tr
                            className={`otrd-co-row${
                              focusTicker === c.ticker ? " is-focus" : ""
                            }${open ? " is-open" : ""}`}
                          >
                            <td>
                              <div className="otrd-co-name">
                                <WatchButton ticker={c.ticker} />
                                <button
                                  type="button"
                                  className="otrd-co-expand-btn"
                                  onClick={() => toggleExpand(c.ticker)}
                                  aria-expanded={open}
                                >
                                  <span className="otrd-chev">
                                    {open ? "▴" : "▾"}
                                  </span>
                                  <span className="otrd-co-link">
                                    {c.company}
                                  </span>
                                </button>
                                <span
                                  className={`exch-chip exch-${exchangeLabel(c.ticker, c.market).toLowerCase()}`}
                                >
                                  {exchangeLabel(c.ticker, c.market)}
                                </span>
                              </div>
                            </td>
                            <td>
                              <PctPill
                                value={c.orders_as_pct_of_revenue}
                                title={orderPctTitle({
                                  pct: c.orders_as_pct_of_revenue,
                                  orderCr: c.total_order_value_cr,
                                  salesCr: c.sales_cr,
                                  salesYear: c.sales_year,
                                })}
                              />
                            </td>
                            <td className="otrd-muted">
                              {c.order_count} order
                              {c.order_count === 1 ? "" : "s"}
                            </td>
                            <td
                              className="otrd-money"
                              title={
                                c.total_order_value_cr == null
                                  ? "No stated ₹ order size in filing(s)"
                                  : undefined
                              }
                            >
                              {c.total_order_value_cr == null
                                ? "—"
                                : fmtCr(c.total_order_value_cr)}
                            </td>
                            <td className="otrd-muted" title={salesTitle(c)}>
                              {salesLabel(c)}
                            </td>
                            <td>
                              <a
                                className="otrd-tv"
                                href={tradingviewUrl(c.ticker, c.market)}
                                target="_blank"
                                rel="noreferrer"
                                title={
                                  bseScripCodeFromTicker(c.ticker)
                                    ? "BSE India quote"
                                    : "TradingView"
                                }
                              >
                                {bseScripCodeFromTicker(c.ticker) ? "BSE" : "TV"}
                              </a>
                            </td>
                          </tr>
                          {open ? (
                            <tr className="otrd-co-detail-row">
                              <td colSpan={6}>
                                <div className="otrd-co-body">
                                  <h3 className="otrd-co-orders-title">
                                    Individual Orders
                                  </h3>
                                  <OrdersTable orders={c.orders} compact />
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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

"use client";

import { useCallback, useEffect, useState } from "react";

type InvestorStats = {
  id: string;
  label: string;
  short: string;
  primary: boolean;
  deal_count: number;
  buy_count: number;
  sme_count: number;
  note?: string;
};

type RadarDeal = {
  trade_date: string;
  symbol: string;
  security_name: string | null;
  client_name: string;
  side: string;
  quantity: number | null;
  price: number | null;
  deal_type: string;
  investor_ids: string[];
  primary_hit: boolean;
  in_sme_universe: boolean;
  value_cr: number | null;
};

type SmeHit = {
  symbol: string;
  name: string | null;
  investors: string[];
  last_date: string;
  last_side: string;
  deal_count: number;
};

type ShareholdingRow = {
  symbol: string;
  company_name: string | null;
  holder_name: string;
  investor_ids: string[];
  primary_hit: boolean;
  pct: number | null;
  shares: number | null;
  as_of_date: string | null;
  in_sme_universe: boolean;
};

type NewsRow = {
  investor_ids: string[];
  headline: string;
  link: string;
  published: string | null;
};

type SmeWhaleBuy = {
  trade_date: string;
  symbol: string;
  security_name: string | null;
  client_name: string;
  quantity: number | null;
  price: number | null;
  value_cr: number | null;
  deal_type: string;
  exchange: string;
};

type RadarResponse = {
  ok: boolean;
  error?: string;
  sme_universe_count?: number;
  days?: number;
  latest_date?: string | null;
  total_deals?: number;
  smart_deals?: number;
  primary_deals?: number;
  sme_smart_deals?: number;
  investors?: InvestorStats[];
  deals?: RadarDeal[];
  sme_hits?: SmeHit[];
  sme_whale_buys?: SmeWhaleBuy[];
  shareholding?: ShareholdingRow[];
  news?: NewsRow[];
  sync?: {
    nse_fetched?: number;
    bse_fetched?: number;
    deals_inserted?: number;
    shareholding_hits?: number;
    news_signals?: number;
    trilithon_deals?: number;
    devabhaktuni_deals?: number;
  };
};

type Filter = {
  investor: string | null;
  smeOnly: boolean;
  buysOnly: boolean;
  days: number;
};

const INVESTOR_COLORS: Record<string, string> = {
  trilithon: "inv-trilithon",
  devabhaktuni: "inv-devabhaktuni",
  whiteoak: "inv-other",
  kacholia: "inv-other",
  kedia: "inv-other",
  aif: "inv-aif",
  pms: "inv-pms",
};

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function fmtQty(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function investorLabel(id: string, investors: InvestorStats[]): string {
  return investors.find((i) => i.id === id)?.short ?? id;
}

export function HiddenPortfolioPanel() {
  const [data, setData] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "err" } | null>(
    null,
  );
  const [filter, setFilter] = useState<Filter>({
    investor: null,
    smeOnly: false,
    buysOnly: true,
    days: 90,
  });
  const [showAllInvestors, setShowAllInvestors] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        days: String(filter.days),
        limit: "120",
        buys: filter.buysOnly ? "1" : "0",
        ...(filter.smeOnly ? { sme: "1" } : {}),
        ...(filter.investor ? { investor: filter.investor } : { primary: "1" }),
      });
      const res = await fetch(`/api/smart-money?${params}`);
      const json = (await res.json()) as RadarResponse;
      setData(json);
      if (!json.ok) {
        setMessage({ text: json.error || "Failed to load radar", kind: "err" });
      }
    } catch (e) {
      setMessage({
        text: e instanceof Error ? e.message : String(e),
        kind: "err",
      });
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncDeals() {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/smart-money", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 30 }),
      });
      const json = (await res.json()) as RadarResponse;
      if (!json.ok) {
        setMessage({ text: json.error || "Sync failed", kind: "err" });
        return;
      }
      setData(json);
      const s = json.sync;
      setMessage({
        text: s
          ? `Synced · NSE ${s.nse_fetched ?? 0} · BSE ${s.bse_fetched ?? 0} · Trilithon ${s.trilithon_deals ?? 0} · Devabhaktuni ${s.devabhaktuni_deals ?? 0} · Holdings ${s.shareholding_hits ?? 0} · News ${s.news_signals ?? 0}`
          : "Sync complete",
        kind: "ok",
      });
    } catch (e) {
      setMessage({
        text: e instanceof Error ? e.message : String(e),
        kind: "err",
      });
    } finally {
      setSyncing(false);
    }
  }

  const investors = data?.investors ?? [];
  const primaryInvestors = investors.filter((i) => i.primary);
  const secondaryInvestors = investors.filter((i) => !i.primary);
  const deals = data?.deals ?? [];
  const shareholding = data?.shareholding ?? [];
  const news = data?.news ?? [];
  const whaleBuys = data?.sme_whale_buys ?? [];
  const smeHits = data?.sme_hits ?? [];
  const trilithonSh = new Set(
    shareholding.filter((h) => h.investor_ids.includes("trilithon")).map((h) => h.symbol),
  ).size;
  const devSh = new Set(
    shareholding.filter((h) => h.investor_ids.includes("devabhaktuni")).map((h) => h.symbol),
  ).size;
  const trilithon = investors.find((i) => i.id === "trilithon");
  const devabhaktuni = investors.find((i) => i.id === "devabhaktuni");
  const noPrimaryHits =
    !loading &&
    (trilithon?.deal_count ?? 0) === 0 &&
    (devabhaktuni?.deal_count ?? 0) === 0 &&
    trilithonSh === 0 &&
    devSh === 0;

  return (
    <div className="panel sm-panel">
      <div className="scanner-hero sm-hero">
        <div>
          <h2>Smart Money Radar</h2>
          <p>
            Track what <strong>Trilithon</strong> and{" "}
            <strong>Manohar Devabhaktuni</strong> are buying in NSE bulk/block
            deals — cross-checked against your {data?.sme_universe_count ?? "—"}{" "}
            name SME universe (₹20–200 Cr).
          </p>
        </div>
        <div className="sm-hero-actions">
          <button
            type="button"
            className="btn-fill"
            disabled={syncing}
            onClick={() => void syncDeals()}
          >
            {syncing ? "Syncing all sources…" : "Fetch data (NSE + BSE + holdings + news)"}
          </button>
          <button
            type="button"
            className="btn-refresh"
            disabled={loading || syncing}
            onClick={() => void load()}
          >
            Refresh
          </button>
        </div>
      </div>

      {message ? (
        <div className={`sm-banner ${message.kind === "err" ? "is-error" : ""}`}>
          {message.text}
        </div>
      ) : null}

      <div className="sm-targets">
        {primaryInvestors.map((inv) => (
          <button
            key={inv.id}
            type="button"
            className={`sm-target-card ${filter.investor === inv.id ? "on" : ""} ${INVESTOR_COLORS[inv.id] ?? ""}`}
            onClick={() =>
              setFilter((f) => ({
                ...f,
                investor: f.investor === inv.id ? null : inv.id,
              }))
            }
          >
            <span className="sm-target-name">{inv.label}</span>
            {inv.note ? (
              <span className="sm-target-note">{inv.note}</span>
            ) : null}
            <div className="sm-target-stats">
              <span>
                <strong>{inv.deal_count}</strong> deals
              </span>
              <span>
                <strong>{inv.buy_count}</strong> buys
              </span>
              <span>
                <strong>{inv.sme_count + (inv.id === "trilithon" ? trilithonSh : inv.id === "devabhaktuni" ? devSh : 0)}</strong> SME
              </span>
            </div>
          </button>
        ))}
      </div>

      <div className="sm-stats">
        <div className="sm-stat">
          <span className="sm-stat-label">SME universe</span>
          <strong>{data?.sme_universe_count ?? "—"}</strong>
        </div>
        <div className="sm-stat">
          <span className="sm-stat-label">Deals in DB</span>
          <strong>{data?.total_deals ?? "—"}</strong>
        </div>
        <div className="sm-stat">
          <span className="sm-stat-label">Latest trade</span>
          <strong>{data?.latest_date ?? "—"}</strong>
        </div>
        <div className="sm-stat sm-stat-highlight">
          <span className="sm-stat-label">Primary hits</span>
          <strong>{data?.primary_deals ?? "—"}</strong>
        </div>
        <div className="sm-stat sm-stat-highlight">
          <span className="sm-stat-label">SME + primary</span>
          <strong>{data?.sme_smart_deals ?? "—"}</strong>
        </div>
      </div>

      <div className="sm-toolbar">
        <div className="sm-filters">
          <label className="sm-chip-toggle">
            <input
              type="checkbox"
              checked={filter.buysOnly}
              onChange={(e) =>
                setFilter((f) => ({ ...f, buysOnly: e.target.checked }))
              }
            />
            Buys only
          </label>
          <label className="sm-chip-toggle">
            <input
              type="checkbox"
              checked={filter.smeOnly}
              onChange={(e) =>
                setFilter((f) => ({ ...f, smeOnly: e.target.checked }))
              }
            />
            SME universe only
          </label>
          <label className="sm-days">
            <span>Window</span>
            <select
              value={filter.days}
              onChange={(e) =>
                setFilter((f) => ({ ...f, days: Number(e.target.value) }))
              }
            >
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
            </select>
          </label>
          {filter.investor ? (
            <button
              type="button"
              className="sm-clear-filter"
              onClick={() => setFilter((f) => ({ ...f, investor: null }))}
            >
              Clear {investorLabel(filter.investor, investors)} filter
            </button>
          ) : null}
        </div>
      </div>

      {noPrimaryHits && !filter.investor ? (
        <div className="sm-empty-state">
          <h3>No Trilithon or Devabhaktuni deals yet</h3>
          <p>
            Bulk/block disclosures use the <em>client name on the ticket</em> —
            Trilithon often routes via broker or PMS names, and individual HNIs
            may not appear in bulk windows at all (check SAST filings separately).
          </p>
          <ul>
            <li>Sync after market close (~6 PM IST) when NSE publishes deals</li>
            <li>Try widening to 90–180 days</li>
            <li>Turn off &quot;Buys only&quot; to see sells and exits</li>
            <li>Expand to boutique AIF/PMS hits below while patterns are tuned</li>
          </ul>
        </div>
      ) : null}

      {whaleBuys.length > 0 ? (
        <section className="sm-section">
          <div className="sm-section-head">
            <h3>SME whale buys (≥ ₹0.5 Cr)</h3>
            <span className="sm-section-sub">
              {whaleBuys.length} recent large buys in your universe
            </span>
          </div>
          <div className="table-card sm-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Symbol</th>
                  <th>Client</th>
                  <th className="num">₹ Cr</th>
                  <th className="num">Qty</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {whaleBuys.map((w, i) => (
                  <tr key={`${w.trade_date}-${w.symbol}-${i}`}>
                    <td className="mono">{w.trade_date}</td>
                    <td className="mono">{w.symbol}</td>
                    <td title={w.client_name}>{clip(w.client_name, 40)}</td>
                    <td className="num">{w.value_cr ?? "—"}</td>
                    <td className="num">{fmtQty(w.quantity)}</td>
                    <td>
                      <span className="sm-type">
                        {w.exchange} {w.deal_type}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {shareholding.length > 0 ? (
        <section className="sm-section">
          <div className="sm-section-head">
            <h3>Shareholding filings</h3>
            <span className="sm-section-sub">
              {shareholding.length} Trilithon / Devabhaktuni positions
            </span>
          </div>
          <div className="table-card sm-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Holder (NSE filing)</th>
                  <th>Tagged</th>
                  <th className="num">%</th>
                  <th className="num">Shares</th>
                  <th>As of</th>
                  <th>SME</th>
                </tr>
              </thead>
              <tbody>
                {shareholding.map((h) => (
                  <tr key={`${h.symbol}-${h.holder_name}`} className="sm-row-hot">
                    <td className="mono">{h.symbol}</td>
                    <td title={h.holder_name}>{clip(h.holder_name, 48)}</td>
                    <td className="sm-tags">
                      {h.investor_ids.map((id) => (
                        <span
                          key={id}
                          className={`sm-tag ${INVESTOR_COLORS[id] ?? "inv-other"}`}
                        >
                          {investorLabel(id, investors)}
                        </span>
                      ))}
                    </td>
                    <td className="num">{h.pct ?? "—"}</td>
                    <td className="num">
                      {h.shares?.toLocaleString("en-IN") ?? "—"}
                    </td>
                    <td className="mono">{h.as_of_date ?? "—"}</td>
                    <td>
                      {h.in_sme_universe ? (
                        <span className="sm-sme-yes">Yes</span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {news.length > 0 ? (
        <section className="sm-section">
          <div className="sm-section-head">
            <h3>News mentions</h3>
            <span className="sm-section-sub">{news.length} headlines</span>
          </div>
          <ul className="sm-news-list">
            {news.map((n) => (
              <li key={n.link || n.headline}>
                <div className="sm-tags">
                  {n.investor_ids.map((id) => (
                    <span
                      key={id}
                      className={`sm-tag ${INVESTOR_COLORS[id] ?? "inv-other"}`}
                    >
                      {investorLabel(id, investors)}
                    </span>
                  ))}
                </div>
                {n.link ? (
                  <a href={n.link} target="_blank" rel="noreferrer">
                    {n.headline}
                  </a>
                ) : (
                  <span>{n.headline}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {smeHits.length > 0 ? (
        <section className="sm-section">
          <div className="sm-section-head">
            <h3>SME names they touched</h3>
            <span className="sm-section-sub">
              {smeHits.length} symbols in your universe
            </span>
          </div>
          <div className="table-card sm-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Company</th>
                  <th>Investors</th>
                  <th>Last</th>
                  <th>Side</th>
                  <th className="num">Deals</th>
                </tr>
              </thead>
              <tbody>
                {smeHits.map((h) => (
                  <tr key={h.symbol} className="sm-row-sme-hit">
                    <td className="mono">{h.symbol}</td>
                    <td>{h.name ?? "—"}</td>
                    <td className="sm-tags">
                      {h.investors.map((id) => (
                        <span
                          key={id}
                          className={`sm-tag ${INVESTOR_COLORS[id] ?? "inv-other"}`}
                        >
                          {investorLabel(id, investors)}
                        </span>
                      ))}
                    </td>
                    <td className="mono">{h.last_date}</td>
                    <td>
                      <span
                        className={`sm-side ${h.last_side === "BUY" ? "buy" : h.last_side === "SELL" ? "sell" : ""}`}
                      >
                        {h.last_side}
                      </span>
                    </td>
                    <td className="num">{h.deal_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="sm-section">
        <div className="sm-section-head">
          <h3>
            {filter.investor
              ? `${investorLabel(filter.investor, investors)} deals`
              : "Trilithon & Devabhaktuni deals"}
          </h3>
          <span className="sm-section-sub">
            {loading ? "Loading…" : `${deals.length} shown`}
          </span>
        </div>

        {loading && !deals.length ? (
          <p className="muted sm-muted">Loading deals…</p>
        ) : deals.length === 0 ? (
          <p className="muted sm-muted">
            No matching deals for current filters.
          </p>
        ) : (
          <div className="table-card sm-table-wrap">
            <table className="data-table sm-deals-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Symbol</th>
                  <th>Company</th>
                  <th>Client (NSE)</th>
                  <th>Tagged</th>
                  <th>Side</th>
                  <th className="num">Qty</th>
                  <th className="num">Price</th>
                  <th className="num">₹ Cr</th>
                  <th>Type</th>
                  <th>SME</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((d, i) => (
                  <tr
                    key={`${d.trade_date}-${d.symbol}-${i}`}
                    className={
                      d.in_sme_universe && d.primary_hit
                        ? "sm-row-hot"
                        : d.primary_hit
                          ? "sm-row-primary"
                          : undefined
                    }
                  >
                    <td className="mono">{d.trade_date}</td>
                    <td className="mono">{d.symbol}</td>
                    <td>{clip(d.security_name || "—", 28)}</td>
                    <td className="sm-client" title={d.client_name}>
                      {clip(d.client_name, 36)}
                    </td>
                    <td className="sm-tags">
                      {d.investor_ids.length ? (
                        d.investor_ids.map((id) => (
                          <span
                            key={id}
                            className={`sm-tag ${INVESTOR_COLORS[id] ?? "inv-other"}`}
                          >
                            {investorLabel(id, investors)}
                          </span>
                        ))
                      ) : (
                        <span className="sm-tag inv-muted">smart</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`sm-side ${d.side === "BUY" ? "buy" : d.side === "SELL" ? "sell" : ""}`}
                      >
                        {d.side}
                      </span>
                    </td>
                    <td className="num">{fmtQty(d.quantity)}</td>
                    <td className="num">{d.price ?? "—"}</td>
                    <td className="num">{d.value_cr ?? "—"}</td>
                    <td>
                      <span className="sm-type">{d.deal_type}</span>
                    </td>
                    <td>
                      {d.in_sme_universe ? (
                        <span className="sm-sme-yes">Yes</span>
                      ) : (
                        <span className="sm-sme-no">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="sm-section sm-section-secondary">
        <button
          type="button"
          className="sm-section-toggle"
          onClick={() => setShowAllInvestors((o) => !o)}
          aria-expanded={showAllInvestors}
        >
          <h3>Other boutique funds (AIF, PMS, WhiteOak…)</h3>
          <span className="sm-section-sub">
            {secondaryInvestors.reduce((n, i) => n + i.deal_count, 0)} deals
          </span>
          <span className="sm-chevron">{showAllInvestors ? "▾" : "▸"}</span>
        </button>

        {showAllInvestors ? (
          <div className="sm-secondary-grid">
            {secondaryInvestors.map((inv) => (
              <button
                key={inv.id}
                type="button"
                className={`sm-secondary-card ${filter.investor === inv.id ? "on" : ""}`}
                onClick={() =>
                  setFilter((f) => ({
                    ...f,
                    investor: f.investor === inv.id ? null : inv.id,
                  }))
                }
              >
                <span className="sm-secondary-name">{inv.label}</span>
                <span className="sm-secondary-count">
                  {inv.deal_count} deals · {inv.sme_count} SME
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

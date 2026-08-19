"use client";

import { useCallback, useEffect, useState } from "react";

export type PaperPosition = {
  id: number;
  symbol: string;
  name: string;
  market: string;
  amount_inr: number;
  entry_price: number;
  qty: number;
  confidence: number | null;
  source: string | null;
  opened_at: string;
  closed_at: string | null;
  close_price: number | null;
  status: "open" | "closed";
  live_price: number | null;
  day_change_pct: number | null;
  market_value: number | null;
  pnl_inr: number | null;
  pnl_pct: number | null;
  held_days: number;
  has_hold?: boolean;
  has_edge?: boolean;
  has_niveshaay?: boolean;
  has_negen?: boolean;
};

type PaperSummary = {
  open_count: number;
  invested: number;
  market_value: number;
  pnl_inr: number;
  pnl_pct: number | null;
};

type PaperResponse = {
  positions: PaperPosition[];
  summary: PaperSummary;
  error?: string;
};

const PRESETS = [5_000, 10_000, 25_000, 50_000] as const;

function fmtInr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** P&L with paise so row totals match the summary. */
function fmtPnl(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "" : "";
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) {
    return `${sign}₹${Math.round(n).toLocaleString("en-IN")}`;
  }
  return `${sign}₹${rounded.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function fmtHeld(days: number): string {
  if (days <= 0) return "Held today";
  if (days === 1) return "Held 1 day";
  return `Held ${days} days`;
}

function PaperTags({
  market,
  hasHold,
  hasEdge,
  hasNiveshaay,
  hasNegen,
}: {
  market?: string | null;
  hasHold?: boolean;
  hasEdge?: boolean;
  hasNiveshaay?: boolean;
  hasNegen?: boolean;
}) {
  if (
    !/\bSME\b/i.test(market || "") &&
    !hasHold &&
    !hasEdge &&
    !hasNiveshaay &&
    !hasNegen
  ) {
    return null;
  }
  return (
    <span className="ag-paper-tags">
      {/\bSME\b/i.test(market || "") ? (
        <span className="ag-mkt" title={`${market} listing`}>
          SME
        </span>
      ) : null}
      {hasEdge ? (
        <span className="ag-tag ag-tag-edge" title="Early Edge">
          Edge
        </span>
      ) : null}
      {hasNiveshaay ? (
        <span className="ag-tag ag-tag-niveshaay" title="Niveshaay">
          Niveshaay
        </span>
      ) : null}
      {hasNegen ? (
        <span className="ag-tag ag-tag-negen" title="Negen">
          Negen
        </span>
      ) : null}
      {hasHold ? (
        <span className="ag-tag ag-tag-hold" title="Holdings">
          Hold
        </span>
      ) : null}
    </span>
  );
}

type TopPick = {
  symbol: string;
  name?: string | null;
  market?: string | null;
  confidence: number;
  price?: number | null;
  has_hold?: boolean;
  has_edge?: boolean;
  has_niveshaay?: boolean;
  has_negen?: boolean;
};

type Props = {
  topPick: TopPick | null;
  /** Shown when topPick is null */
  emptyHint?: string;
};

export function PaperMockPanel({
  topPick,
  emptyHint = "Run agents to get a top pick",
}: Props) {
  const [amount, setAmount] = useState(10_000);
  const [custom, setCustom] = useState("10000");
  const [data, setData] = useState<PaperResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/paper?status=all");
      const json = (await res.json()) as PaperResponse;
      if (!res.ok) {
        setError(json.error || "Failed to load");
        return;
      }
      setData(json);
    } catch {
      setError("Failed to load mock trades");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pickAmount = (n: number) => {
    setAmount(n);
    setCustom(String(n));
  };

  const onCustom = (v: string) => {
    setCustom(v);
    const n = Number(v.replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 100) setAmount(Math.round(n));
  };

  const buy = async () => {
    if (!topPick) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/paper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: topPick.symbol,
          name: topPick.name,
          market: topPick.market,
          amountInr: amount,
          entryPrice: topPick.price,
          confidence: topPick.confidence,
          source: "top_pick",
        }),
      });
      const json = (await res.json()) as PaperResponse & { error?: string };
      if (!res.ok) {
        setError(json.error || "Mock buy failed");
        return;
      }
      setData(json);
    } catch {
      setError("Mock buy failed");
    } finally {
      setBusy(false);
    }
  };

  const closeTrade = async (id: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/paper", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "close", id }),
      });
      const json = (await res.json()) as PaperResponse & { error?: string };
      if (!res.ok) {
        setError(json.error || "Close failed");
        return;
      }
      setData(json);
    } catch {
      setError("Close failed");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/paper", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      });
      const json = (await res.json()) as PaperResponse & { error?: string };
      if (!res.ok) {
        setError(json.error || "Refresh failed");
        return;
      }
      setData(json);
    } catch {
      setError("Refresh failed");
    } finally {
      setBusy(false);
    }
  };

  const summary = data?.summary;
  const open = (data?.positions ?? []).filter((p) => p.status === "open");
  const closed = (data?.positions ?? []).filter((p) => p.status === "closed");
  const pnlUp = (summary?.pnl_inr ?? 0) >= 0;

  return (
    <section className="ag-paper">
      <div className="ag-paper-head">
        <div>
          <h3>Mock buy</h3>
          <p>
            Paper trade only — add ₹ and track what would happen. No real orders.
          </p>
        </div>
        <button
          type="button"
          className="ag-paper-refresh"
          disabled={busy || loading}
          onClick={() => void refresh()}
        >
          {busy ? "…" : "Refresh prices"}
        </button>
      </div>

      <div className="ag-paper-buy">
        <div className="ag-paper-pick">
          <span className="ag-paper-pick-label">Top pick</span>
          {topPick ? (
            <>
              <strong>{topPick.symbol}</strong>
              <PaperTags
                market={topPick.market}
                hasHold={topPick.has_hold}
                hasEdge={topPick.has_edge}
                hasNiveshaay={topPick.has_niveshaay}
                hasNegen={topPick.has_negen}
              />
              <span className="ag-paper-conf">{topPick.confidence}/10</span>
              {topPick.price != null ? (
                <span className="ag-paper-entry">{fmtPrice(topPick.price)}</span>
              ) : null}
              {topPick.name ? (
                <span className="ag-paper-name" title={topPick.name}>
                  {topPick.name}
                </span>
              ) : null}
            </>
          ) : (
            <span className="ag-muted">{emptyHint}</span>
          )}
        </div>

        <div className="ag-paper-amount">
          <span className="ag-paper-amount-label">Amount</span>
          <div className="ag-paper-presets">
            {PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                className={amount === n ? "on" : undefined}
                onClick={() => pickAmount(n)}
              >
                ₹{(n / 1000).toFixed(0)}k
              </button>
            ))}
          </div>
          <label className="ag-paper-custom">
            <span>₹</span>
            <input
              inputMode="numeric"
              value={custom}
              onChange={(e) => onCustom(e.target.value)}
              aria-label="Mock buy amount in rupees"
            />
          </label>
          <button
            type="button"
            className="ag-paper-buy-btn"
            disabled={!topPick || busy || amount < 100}
            onClick={() => void buy()}
          >
            {busy ? "Buying…" : `Mock buy ${fmtInr(amount)}`}
          </button>
        </div>
      </div>

      {error ? <div className="ag-banner err">{error}</div> : null}

      {summary && summary.open_count > 0 ? (
        <div className="ag-paper-summary">
          <div>
            <span>Invested</span>
            <strong>{fmtInr(summary.invested)}</strong>
          </div>
          <div>
            <span>Value</span>
            <strong>{fmtInr(summary.market_value)}</strong>
          </div>
          <div className={pnlUp ? "up" : "down"}>
            <span>P&amp;L</span>
            <strong>
              {fmtPnl(summary.pnl_inr)}{" "}
              <em>({fmtPct(summary.pnl_pct)})</em>
            </strong>
          </div>
          <div>
            <span>Open</span>
            <strong>{summary.open_count}</strong>
          </div>
        </div>
      ) : null}

      {loading && !data ? (
        <p className="ag-muted">Loading mock trades…</p>
      ) : open.length === 0 ? (
        <p className="ag-paper-empty">
          No open mocks yet. Pick an amount and mock-buy the top pick.
        </p>
      ) : (
        <ul className="ag-paper-list">
          {open.map((p) => {
            const up = (p.pnl_inr ?? 0) >= 0;
            const days = p.held_days ?? 0;
            return (
              <li key={p.id} className="ag-paper-row">
                <div className="ag-paper-row-main">
                  <div className="ag-paper-row-title">
                    <strong>{p.symbol}</strong>
                    <PaperTags
                      market={p.market}
                      hasHold={p.has_hold}
                      hasEdge={p.has_edge}
                      hasNiveshaay={p.has_niveshaay}
                      hasNegen={p.has_negen}
                    />
                  </div>
                  <span className="ag-paper-row-meta">
                    {fmtInr(p.amount_inr)} · {p.qty.toFixed(2)} sh @{" "}
                    {fmtPrice(p.entry_price)}
                  </span>
                  <span className="ag-paper-row-when">
                    {fmtHeld(days)} · bought {fmtWhen(p.opened_at)}
                    {p.confidence != null ? ` · conf ${p.confidence}/10` : ""}
                  </span>
                  <span className={`ag-paper-profit ${up ? "up" : "down"}`}>
                    Profit {fmtPnl(p.pnl_inr)} ({fmtPct(p.pnl_pct)}) · value{" "}
                    {fmtInr(p.market_value)}
                  </span>
                </div>
                <div className="ag-paper-row-side">
                  <span className="ag-paper-live">{fmtPrice(p.live_price)}</span>
                  <span className="ag-paper-held">{fmtHeld(days)}</span>
                  <span className={up ? "ag-up" : "ag-down"}>
                    {fmtPnl(p.pnl_inr)} ({fmtPct(p.pnl_pct)})
                  </span>
                  <button
                    type="button"
                    className="ag-paper-close"
                    disabled={busy}
                    onClick={() => void closeTrade(p.id)}
                  >
                    Close
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {closed.length > 0 ? (
        <div className="ag-paper-closed">
          <button
            type="button"
            className="ag-paper-closed-toggle"
            onClick={() => setShowClosed((v) => !v)}
          >
            {showClosed ? "Hide" : "Show"} closed ({closed.length})
          </button>
          {showClosed ? (
            <ul className="ag-paper-list closed">
              {closed.map((p) => {
                const up = (p.pnl_inr ?? 0) >= 0;
                const days = p.held_days ?? 0;
                return (
                  <li key={p.id} className="ag-paper-row">
                    <div className="ag-paper-row-main">
                      <div className="ag-paper-row-title">
                        <strong>{p.symbol}</strong>
                        <PaperTags
                          market={p.market}
                          hasHold={p.has_hold}
                          hasEdge={p.has_edge}
                        />
                      </div>
                      <span className="ag-paper-row-meta">
                        {fmtInr(p.amount_inr)} → {fmtPrice(p.close_price)}
                      </span>
                      <span className="ag-paper-row-when">
                        {fmtHeld(days)}
                        {p.closed_at ? ` · closed ${fmtWhen(p.closed_at)}` : ""}
                      </span>
                    </div>
                    <div className="ag-paper-row-side">
                      <span className={up ? "ag-up" : "ag-down"}>
                        Profit {fmtPnl(p.pnl_inr)} ({fmtPct(p.pnl_pct)})
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { FamilyRow } from "@/components/FamilyMapCards";

export type GroupCompanyRow = {
  ticker: string;
  name: string;
  cap_code: string | null;
  market_cap_cr: number | null;
  group_count: number;
  house_cos: number;
  houses: Array<{ key: string; label: string }>;
};

type CapBand = "lc" | "mc" | "sc" | "sub500";

const CAP_FILTERS: Array<{ id: CapBand | "all"; label: string; cls: string }> = [
  { id: "all", label: "All caps", cls: "tag-cap-all" },
  { id: "lc", label: "Large", cls: "tag-cap-lc" },
  { id: "mc", label: "Mid", cls: "tag-cap-mc" },
  { id: "sc", label: "Small", cls: "tag-cap-sc" },
  { id: "sub500", label: "Under ₹500 Cr", cls: "tag-cap-mic" },
];

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 10_000) return `₹${(n / 1000).toFixed(1)}k Cr`;
  return `₹${Math.round(n).toLocaleString("en-IN")} Cr`;
}

function capBand(
  cap_code?: string | null,
  market_cap_cr?: number | null,
): CapBand | null {
  const mcap = market_cap_cr == null ? null : Number(market_cap_cr);
  if (mcap != null && Number.isFinite(mcap) && mcap > 0 && mcap < 500) {
    return "sub500";
  }
  const cap = (cap_code || "").toLowerCase();
  if (cap === "ti" || cap === "mic") return "sub500";
  if (cap === "lc" || cap === "mc" || cap === "sc") return cap;
  if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) return null;
  if (mcap >= 20_000) return "lc";
  if (mcap >= 5_000) return "mc";
  return "sc";
}

function capLabel(band: CapBand | null): string {
  if (band === "lc") return "Large";
  if (band === "mc") return "Mid";
  if (band === "sc") return "Small";
  if (band === "sub500") return "<₹500 Cr";
  return "—";
}

/** Rank in-group companies (member listings only — not Outside boards). */
export function buildGroupCompanies(
  rows: FamilyRow[],
  minHouseCos = 3,
): GroupCompanyRow[] {
  const byTicker = new Map<
    string,
    {
      ticker: string;
      name: string;
      cap_code: string | null;
      market_cap_cr: number | null;
      groups: Map<string, { label: string; cos: number }>;
    }
  >();

  for (const f of rows) {
    const groupLabel = (f.family_name || "").trim() || "Group";
    const groupKey = f.group_id || groupLabel;
    const cos = f.companies ?? [];
    const houseCos = cos.length || f.company_count || 0;
    if (houseCos < minHouseCos) continue;

    for (const c of cos) {
      const ticker = (c.ticker || "").trim().toUpperCase();
      if (!ticker) continue;
      const cur = byTicker.get(ticker) ?? {
        ticker,
        name: (c.name || ticker).trim() || ticker,
        cap_code: c.cap_code ?? null,
        market_cap_cr: c.market_cap_cr ?? null,
        groups: new Map<string, { label: string; cos: number }>(),
      };
      if (c.name && (!cur.name || cur.name === ticker)) cur.name = c.name.trim();
      if (c.cap_code && !cur.cap_code) cur.cap_code = c.cap_code;
      if (
        c.market_cap_cr != null &&
        Number.isFinite(c.market_cap_cr) &&
        (cur.market_cap_cr == null || c.market_cap_cr > cur.market_cap_cr)
      ) {
        cur.market_cap_cr = c.market_cap_cr;
      }
      const prev = cur.groups.get(groupKey);
      if (!prev || houseCos > prev.cos) {
        cur.groups.set(groupKey, { label: groupLabel, cos: houseCos });
      }
      byTicker.set(ticker, cur);
    }
  }

  return [...byTicker.values()]
    .map((r) => {
      const houses = [...r.groups.entries()]
        .map(([key, h]) => ({ key, label: h.label, cos: h.cos }))
        .sort((a, b) =>
          a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
        );
      return {
        ticker: r.ticker,
        name: r.name,
        cap_code: r.cap_code,
        market_cap_cr: r.market_cap_cr,
        group_count: houses.length,
        house_cos: houses.reduce((n, h) => Math.max(n, h.cos), 0),
        houses: houses.map((h) => ({ key: h.key, label: h.label })),
      };
    })
    .sort(
      (a, b) =>
        (b.market_cap_cr ?? -1) - (a.market_cap_cr ?? -1) ||
        b.house_cos - a.house_cos ||
        a.ticker.localeCompare(b.ticker),
    );
}

export function GroupRankTable({
  rows,
  loading,
  chartUrl,
  onTicker,
  onOpenGroup,
}: {
  rows: FamilyRow[];
  loading?: boolean;
  chartUrl?: (ticker: string) => string;
  onTicker?: (ticker: string) => void;
  onOpenGroup?: (key: string, name: string) => void;
}) {
  const [minHouseCos, setMinHouseCos] = useState(3);
  const [cap, setCap] = useState<CapBand | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const ranked = useMemo(
    () => buildGroupCompanies(rows, minHouseCos),
    [rows, minHouseCos],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ranked.filter((r) => {
      const band = capBand(r.cap_code, r.market_cap_cr);
      if (cap !== "all" && band !== cap) return false;
      if (!needle) return true;
      return (
        r.ticker.toLowerCase().startsWith(needle) ||
        r.name.toLowerCase().includes(needle) ||
        r.houses.some((h) => h.label.toLowerCase().includes(needle))
      );
    });
  }, [ranked, q, cap]);

  if (loading && !rows.length) {
    return <div className="table-meta">Loading group companies…</div>;
  }

  return (
    <div className="outside-commons">
      <div className="outside-commons-bar">
        <input
          className="fam-dash-search outside-commons-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ticker, company or group…"
          aria-label="Filter group companies"
        />
        <label className="outside-commons-min">
          Min cos
          <select
            value={minHouseCos}
            onChange={(e) => setMinHouseCos(Number(e.target.value) || 1)}
            aria-label="Minimum companies in house"
          >
            {[1, 2, 3, 5, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </label>
        <span className="outside-commons-count">
          {filtered.length}
          <span> stocks</span>
        </span>
      </div>

      <div className="outside-commons-caps" role="group" aria-label="Market cap">
        {CAP_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`result-tag ${f.cls}${cap === f.id ? " on" : ""}`}
            aria-pressed={cap === f.id}
            onClick={() => setCap(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!filtered.length ? (
        <p className="miq-empty-hint">
          No matches. Loosen min cos or market-cap filter.
        </p>
      ) : (
        <div className="table-wrap outside-commons-wrap">
          <table className="data-table outside-commons-table">
            <thead>
              <tr>
                <th className="num col-rank">#</th>
                <th className="col-name">Company</th>
                <th className="num col-groups">Cos</th>
                <th className="col-cap">Cap</th>
                <th className="num col-mcap_cr">MCap</th>
                <th className="col-houses">House</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const tv = chartUrl?.(r.ticker);
                const band = capBand(r.cap_code, r.market_cap_cr);
                const expanded = open === r.ticker;
                const shown = expanded ? r.houses : r.houses.slice(0, 3);
                return (
                  <tr key={r.ticker}>
                    <td className="num col-rank">{i + 1}</td>
                    <td className="col-name">
                      <div className="outside-commons-name">
                        {tv ? (
                          <a
                            className="outside-commons-title"
                            href={tv}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open ${r.ticker} on TradingView`}
                          >
                            {r.name}
                          </a>
                        ) : (
                          <button
                            type="button"
                            className="outside-commons-title"
                            onClick={() => onTicker?.(r.ticker)}
                          >
                            {r.name}
                          </button>
                        )}
                        <button
                          type="button"
                          className="outside-commons-ticker"
                          onClick={() => onTicker?.(r.ticker)}
                          title="Open stock network"
                        >
                          {r.ticker}
                        </button>
                      </div>
                    </td>
                    <td className="num col-groups">
                      <span className="outside-commons-badge">{r.house_cos}</span>
                    </td>
                    <td className="col-cap">
                      {band ? (
                        <span className={`result-tag tag-cap-${band}`}>
                          {capLabel(band)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num col-mcap_cr">{fmtCr(r.market_cap_cr)}</td>
                    <td className="col-houses">
                      <div className="outside-commons-houses">
                        {shown.map((h) => (
                          <button
                            key={`${r.ticker}-${h.key}`}
                            type="button"
                            className="outside-commons-house"
                            onClick={() => onOpenGroup?.(h.key, h.label)}
                            title="Open Business groups card"
                          >
                            {h.label}
                          </button>
                        ))}
                        {r.houses.length > 3 ? (
                          <button
                            type="button"
                            className="outside-commons-more"
                            onClick={() =>
                              setOpen(expanded ? null : r.ticker)
                            }
                          >
                            {expanded ? "Less" : `+${r.houses.length - 3}`}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

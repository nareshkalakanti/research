"use client";

import { Loading } from "@/components/Loading";
import { useMemo, useState } from "react";
import type { FamilyRow } from "@/components/FamilyMapCards";

export type OutsideMissingDinRow = {
  ticker: string;
  name: string;
  cap_code: string | null;
  market_cap_cr: number | null;
  directors: number;
  din_verified: number;
  missing: number;
  group_count: number;
  groups: string[];
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

/** Outside-board listings with incomplete DIN coverage (directors missing or unverified). */
export function buildOutsideMissingDin(rows: FamilyRow[]): OutsideMissingDinRow[] {
  const byTicker = new Map<
    string,
    {
      ticker: string;
      name: string;
      cap_code: string | null;
      market_cap_cr: number | null;
      directors: number;
      din_verified: number;
      groups: Set<string>;
    }
  >();

  for (const f of rows) {
    const groupLabel = (f.family_name || "").trim() || "Group";
    const inGroup = new Set(
      f.companies.map((c) => c.ticker.trim().toUpperCase()).filter(Boolean),
    );
    for (const o of f.outside ?? []) {
      const ticker = (o.ticker || "").trim().toUpperCase();
      if (!ticker || inGroup.has(ticker)) continue;
      const directors = o.directors ?? 0;
      const din_verified = o.din_verified ?? 0;
      if (directors > 0 && din_verified >= directors) continue;

      const cur = byTicker.get(ticker) ?? {
        ticker,
        name: (o.name || ticker).trim() || ticker,
        cap_code: o.cap_code ?? null,
        market_cap_cr: o.market_cap_cr ?? null,
        directors,
        din_verified,
        groups: new Set<string>(),
      };
      if (o.name && (!cur.name || cur.name === ticker)) cur.name = o.name.trim();
      if (o.cap_code && !cur.cap_code) cur.cap_code = o.cap_code;
      if (
        o.market_cap_cr != null &&
        Number.isFinite(o.market_cap_cr) &&
        (cur.market_cap_cr == null || o.market_cap_cr > cur.market_cap_cr)
      ) {
        cur.market_cap_cr = o.market_cap_cr;
      }
      // Prefer richer seat stats when multiple groups list the same outside board.
      if (directors > cur.directors) {
        cur.directors = directors;
        cur.din_verified = din_verified;
      } else if (directors === cur.directors && din_verified > cur.din_verified) {
        cur.din_verified = din_verified;
      }
      cur.groups.add(groupLabel);
      byTicker.set(ticker, cur);
    }
  }

  return [...byTicker.values()]
    .map((r) => ({
      ticker: r.ticker,
      name: r.name,
      cap_code: r.cap_code,
      market_cap_cr: r.market_cap_cr,
      directors: r.directors,
      din_verified: r.din_verified,
      missing: Math.max(0, r.directors - r.din_verified) || (r.directors === 0 ? 1 : 0),
      group_count: r.groups.size,
      groups: [...r.groups].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
    }))
    .sort(
      (a, b) =>
        b.missing - a.missing ||
        b.group_count - a.group_count ||
        (b.market_cap_cr ?? -1) - (a.market_cap_cr ?? -1) ||
        a.ticker.localeCompare(b.ticker),
    );
}

export function OutsideMissingDinTable({
  rows,
  loading,
  chartUrl,
  onTicker,
}: {
  rows: FamilyRow[];
  loading?: boolean;
  chartUrl?: (ticker: string) => string;
  onTicker?: (ticker: string) => void;
}) {
  const [cap, setCap] = useState<CapBand | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const ranked = useMemo(() => buildOutsideMissingDin(rows), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ranked.filter((r) => {
      const band = capBand(r.cap_code, r.market_cap_cr);
      if (cap !== "all" && band !== cap) return false;
      if (!needle) return true;
      return (
        r.ticker.toLowerCase().startsWith(needle) ||
        r.name.toLowerCase().includes(needle) ||
        r.groups.some((g) => g.toLowerCase().includes(needle))
      );
    });
  }, [ranked, q, cap]);

  if (loading && !rows.length) {
    return <Loading label="Loading outside Missing DIN" variant="block" />;
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
          aria-label="Filter outside Missing DIN"
        />
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
          No outside boards with Missing DIN. Loosen the market-cap filter or refresh after a scan.
        </p>
      ) : (
        <div className="table-wrap outside-commons-wrap">
          <table className="data-table outside-commons-table">
            <thead>
              <tr>
                <th className="num col-rank">#</th>
                <th className="col-name">Company</th>
                <th className="num col-din">DIN</th>
                <th className="num col-groups">Groups</th>
                <th className="col-cap">Cap</th>
                <th className="num col-mcap_cr">MCap</th>
                <th className="col-houses" title="Business groups where this ticker sits as an outside board (not its own house)">
                  As outside in
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const tv = chartUrl?.(r.ticker);
                const band = capBand(r.cap_code, r.market_cap_cr);
                const expanded = open === r.ticker;
                const shown = expanded ? r.groups : r.groups.slice(0, 3);
                const dinLabel =
                  r.directors === 0
                    ? "0 seats"
                    : `${r.din_verified}/${r.directors}`;
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
                    <td className="num col-din">
                      <span
                        className={`outside-commons-badge${
                          r.directors === 0 || r.din_verified < r.directors
                            ? " is-gap"
                            : ""
                        }`}
                        title={
                          r.directors === 0
                            ? "No board seats on record"
                            : `${r.missing} director(s) without DIN`
                        }
                      >
                        {dinLabel}
                      </span>
                    </td>
                    <td className="num col-groups">
                      <span className="outside-commons-badge">{r.group_count}</span>
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
                        {shown.map((g) => (
                          <span key={g} className="outside-commons-house">
                            {g}
                          </span>
                        ))}
                        {r.groups.length > 3 ? (
                          <button
                            type="button"
                            className="outside-commons-more"
                            onClick={() =>
                              setOpen(expanded ? null : r.ticker)
                            }
                          >
                            {expanded ? "Less" : `+${r.groups.length - 3}`}
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

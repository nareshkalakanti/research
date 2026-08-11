"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshButton } from "@/components/RefreshButton";
import {
  isDistressScanList,
  type DistressListId,
} from "@/lib/distress/types";

type DistressRow = {
  ticker: string;
  name: string | null;
  market: string;
  sector: string | null;
  web: string | null;
  sc: string;
  tv: string;
  has_hold: boolean;
  has_distress: boolean;
  distress_score: number;
  distress_flags: string[];
  flag_labels: string[];
  distress_reason: string;
  drawdown_pct: number | null;
  bounce_pct: number | null;
  eps_yoy: number | null;
  sales_yoy: number | null;
  pe: number | null;
  mcap_cr: number | null;
  price: number | null;
  returns_pct: number | null;
};

type ListMeta = {
  id: DistressListId;
  label: string;
  description: string;
  scan?: boolean;
};

type Gate = { id: string; title: string; detail: string };

type DistressResponse = {
  ok: boolean;
  error?: string;
  list?: DistressListId;
  lists?: ListMeta[];
  count?: number;
  hits?: number;
  universe_total?: number;
  cache_fresh?: number;
  remaining?: number;
  scanned?: number;
  minScore?: number;
  rows?: DistressRow[];
  discovery_gates?: Gate[];
};

const MAX_SIGNALS = 3;

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}%`;
}

function scoreClass(score: number): string {
  if (score >= 60) return "hot";
  if (score >= 40) return "warm";
  return "muted";
}

function pctTone(
  n: number | null | undefined,
  kind: "dd" | "bounce" | "sales" | "eps",
): string {
  if (n == null) return "";
  if (kind === "dd" && n <= -20) return "tone-neg";
  if (kind === "bounce" && n >= 15) return "tone-pos";
  if (kind === "sales" && n < -15) return "tone-neg";
  if (kind === "sales" && n >= 0) return "tone-pos";
  if (kind === "eps" && n < 0) return "tone-neg";
  return "";
}

function SignalTags({
  labels,
  flags,
  reason,
}: {
  labels: string[];
  flags: string[];
  reason: string;
}) {
  if (!labels.length) return <span className="distress-muted">—</span>;
  const visible = labels.slice(0, MAX_SIGNALS);
  const extra = labels.length - visible.length;
  return (
    <div className="distress-signals" title={reason}>
      {visible.map((label, i) => (
        <span
          key={`${flags[i] ?? i}-${label}`}
          className={`distress-signal ${flags[i] === "seed" ? "is-seed" : ""}`}
        >
          {label}
        </span>
      ))}
      {extra > 0 ? (
        <span className="distress-signal is-more" title={labels.join(" · ")}>
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

export function DistressPanel() {
  const [list, setList] = useState<DistressListId>("seeds");
  const [data, setData] = useState<DistressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanDetail, setScanDetail] = useState("");
  const [gatesOpen, setGatesOpen] = useState(false);

  const load = useCallback(
    async (opts?: { refresh?: boolean; scan?: boolean }) => {
      if (opts?.scan) setScanning(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams({ list });
        if (opts?.scan) {
          params.set("scan", "1");
          params.set("limit", "25");
        }
        const res = await fetch(`/api/distress?${params}`);
        setData((await res.json()) as DistressResponse);
      } finally {
        if (opts?.scan) setScanning(false);
        else setLoading(false);
      }
    },
    [list],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanDetail("Starting scan…");
    try {
      let remaining = 1;
      for (let round = 1; round <= 500 && remaining > 0; round += 1) {
        const params = new URLSearchParams({
          list,
          scan: "1",
          limit: "25",
        });
        const res = await fetch(`/api/distress?${params}`);
        const json = (await res.json()) as DistressResponse;
        if (!json.ok) break;
        setData(json);
        remaining = json.remaining ?? 0;
        const total = json.universe_total ?? 0;
        const fresh = json.cache_fresh ?? total - remaining;
        setScanDetail(
          `${fresh.toLocaleString()} / ${total.toLocaleString()} scored · ${(json.hits ?? 0).toLocaleString()} hits (≥${json.minScore ?? 40})`,
        );
        if ((json.scanned ?? 0) === 0 || remaining <= 0) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      setScanning(false);
    }
  }, [list]);

  const rows = data?.rows ?? [];
  const gates = data?.discovery_gates ?? [];
  const lists = data?.lists ?? [];
  const activeList = lists.find((l) => l.id === list);
  const scanList = isDistressScanList(list);

  return (
    <div className="panel distress-panel">
      <div className="scanner-hero">
        <div>
          <h2>Distress</h2>
          <p>
            Turnaround scores (0–100). Pick a list — use NSE or NSE SME and Scan
            to walk the market in batches.
          </p>
        </div>
        <div className="scanner-hero-right">
          <RefreshButton
            busy={loading || scanning}
            onRefresh={() =>
              scanList ? void runScan() : load({ refresh: true })
            }
          />
        </div>
      </div>

      <div className="distress-controls">
        <label className="field">
          <span>List</span>
          <select
            value={list}
            onChange={(e) => setList(e.target.value as DistressListId)}
          >
            {(lists.length
              ? lists
              : [{ id: "seeds", label: "Seed monitors (8)", description: "" }]
            ).map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
                {data?.universe_total && l.id === list
                  ? ` (${data.universe_total.toLocaleString()})`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        {scanList ? (
          <button
            type="button"
            className="breakout-scan"
            disabled={scanning || loading}
            onClick={() => void runScan()}
          >
            {scanning ? "Scanning…" : "Scan"}
          </button>
        ) : null}
      </div>

      {activeList?.description ? (
        <p className="hint distress-list-hint">{activeList.description}</p>
      ) : null}

      {(scanDetail || (scanList && data?.universe_total != null)) && (
        <div className="distress-status">
          {scanDetail ||
            `${(data?.cache_fresh ?? 0).toLocaleString()} / ${data!.universe_total!.toLocaleString()} scored · ${(data?.hits ?? rows.length).toLocaleString()} hits (≥${data?.minScore ?? 40})${
              (data?.remaining ?? 0) > 0
                ? ` · ${data!.remaining!.toLocaleString()} left`
                : ""
            }`}
        </div>
      )}

      {loading && !rows.length ? (
        <div className="loading">Loading…</div>
      ) : null}

      {rows.length ? (
        <div className="table-card">
          <div className="table-wrap">
            <table className="data-table distress-table">
              <colgroup>
                <col className="distress-col-company" />
                <col className="distress-col-score" />
                <col className="distress-col-metric" />
                <col className="distress-col-metric" />
                <col className="distress-col-metric" />
                <col className="distress-col-metric" />
                <col className="distress-col-metric" />
                <col className="distress-col-metric" />
                <col className="distress-col-signals" />
              </colgroup>
              <thead>
                <tr>
                  <th>Company</th>
                  <th className="num">Score</th>
                  <th className="num">Drawdown</th>
                  <th className="num">Bounce</th>
                  <th className="num">Sales</th>
                  <th className="num">EPS</th>
                  <th className="num">P/E</th>
                  <th className="num">Mcap</th>
                  <th>Signals</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ticker}>
                    <td className="distress-col-company">
                      <div className="distress-company">
                        <div className="distress-company-top">
                          <span className="distress-name" title={r.name ?? r.ticker}>
                            {r.name ?? r.ticker}
                          </span>
                          {(r.has_distress || r.has_hold) && (
                            <span className="distress-badges">
                              {r.has_distress ? (
                                <span className="result-tag tag-distress">
                                  DISTRESS
                                </span>
                              ) : null}
                              {r.has_hold ? (
                                <span className="result-tag tag-hold">HOLD</span>
                              ) : null}
                            </span>
                          )}
                        </div>
                        <div className="distress-company-sub">
                          <span className="distress-ticker">{r.ticker}</span>
                          {r.sector ? (
                            <span className="distress-sector">{r.sector}</span>
                          ) : null}
                        </div>
                        <div className="link-row link-row--compact distress-links">
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
                      </div>
                    </td>
                    <td className="num">
                      <span
                        className={`distress-score ${scoreClass(r.distress_score)}`}
                      >
                        {Math.round(r.distress_score)}
                      </span>
                    </td>
                    <td className={`num ${pctTone(r.drawdown_pct, "dd")}`}>
                      {fmtPct(r.drawdown_pct)}
                    </td>
                    <td className={`num ${pctTone(r.bounce_pct, "bounce")}`}>
                      {fmtPct(r.bounce_pct)}
                    </td>
                    <td className={`num ${pctTone(r.sales_yoy, "sales")}`}>
                      {fmtPct(r.sales_yoy)}
                    </td>
                    <td
                      className={`num ${pctTone(r.eps_yoy, "eps")}`}
                      title="Yahoo trailing EPS YoY"
                    >
                      {fmtPct(r.eps_yoy)}
                    </td>
                    <td className="num">{r.pe ?? "—"}</td>
                    <td className="num">{r.mcap_cr ?? "—"}</td>
                    <td>
                      <SignalTags
                        labels={r.flag_labels}
                        flags={r.distress_flags}
                        reason={r.distress_reason}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : !loading && !scanning ? (
        <p className="muted">
          {scanList
            ? "No hits yet — hit Scan to score this list (score ≥ 40)."
            : "No stocks in this list."}
        </p>
      ) : null}

      <div className="sm-turnaround-actions">
        <span className="hint">
          {loading || scanning
            ? "Loading…"
            : `${rows.length} shown · ${activeList?.label ?? list}`}
        </span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setGatesOpen((o) => !o)}
        >
          {gatesOpen ? "Hide" : "Show"} 7-gate discovery strategy
        </button>
      </div>

      {gatesOpen && gates.length ? (
        <ol className="sm-gates-list">
          {gates.map((g) => (
            <li key={g.id}>
              <strong>{g.title}</strong> — {g.detail}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Point = {
  month: string;
  volume_kcr: number;
  ma_kcr: number | null;
};

type ApiPayload = {
  ok: boolean;
  error?: string;
  built_at?: string;
  constituents?: number;
  latest?: { month: string; volume_kcr: number; ma_kcr: number | null };
  series?: Point[];
};

function fmtMonth(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

function fmtKcr(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(1);
}

type Props = { onRefreshReady?: (fn: () => void) => void };

export function Nifty500TurnoverChart({ onRefreshReady }: Props = {}) {
  const [data, setData] = useState<ApiPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/market/nifty500-turnover");
      const json = (await res.json()) as ApiPayload;
      setData(json);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onRefreshReady?.(() => void load());
  }, [load, onRefreshReady]);

  const chartRows = useMemo(() => {
    return (data?.series ?? []).map((p) => ({
      ...p,
      label: fmtMonth(p.month),
    }));
  }, [data?.series]);

  const latest = data?.latest;
  const yDomain = useMemo(() => {
    const vals = chartRows.flatMap((p) =>
      [p.volume_kcr, p.ma_kcr].filter((n): n is number => n != null),
    );
    if (!vals.length) return [0, 6];
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const pad = (max - min) * 0.08 || 0.5;
    return [Math.max(0, min - pad), max + pad];
  }, [chartRows]);

  if (loading) {
    return (
      <div className="nifty500-chart-card nifty500-chart-card--loading">
        Loading market turnover…
      </div>
    );
  }

  if (!data?.ok || !chartRows.length) {
    return (
      <div className="nifty500-chart-card nifty500-chart-card--empty">
        <strong>Nifty 500 monthly turnover</strong>
        <p>{data?.error || "No data yet."}</p>
        <code>npx tsx scripts/build-nifty500-turnover.ts</code>
      </div>
    );
  }

  return (
    <div className="nifty500-chart-card">
      <div className="nifty500-chart-head">
        <div>
          <h3 className="nifty500-chart-title">
            Total Monthly Trade in Nifty500 (thousand crores)
          </h3>
          <div className="nifty500-chart-legend">
            <span className="nifty500-legend-item nifty500-legend-vol">
              Monthly Traded Volume in K cr: {fmtKcr(latest?.volume_kcr)}
            </span>
            <span className="nifty500-legend-item nifty500-legend-ma">
              Moving Avg: {fmtKcr(latest?.ma_kcr)}
            </span>
          </div>
        </div>
        {data.constituents ? (
          <span className="nifty500-chart-meta">
            {data.constituents} names · built{" "}
            {data.built_at ? new Date(data.built_at).toLocaleDateString("en-IN") : "—"}
          </span>
        ) : null}
      </div>

      <div className="nifty500-chart-wrap">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart
            data={chartRows}
            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              stroke="#2a2a2a"
              vertical={false}
              strokeDasharray="3 3"
            />
            <XAxis
              dataKey="month"
              tickFormatter={fmtMonth}
              minTickGap={48}
              stroke="#6b7280"
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              axisLine={{ stroke: "#374151" }}
              tickLine={false}
            />
            <YAxis
              domain={yDomain}
              stroke="#6b7280"
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={42}
              tickFormatter={(v) => String(Number(v).toFixed(1))}
            />
            <Tooltip
              contentStyle={{
                background: "#111827",
                border: "1px solid #374151",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(m) => fmtMonth(String(m))}
              formatter={(value, name) => [
                `${fmtKcr(Number(value))} K cr`,
                name === "volume_kcr" ? "Monthly volume" : "Moving avg",
              ]}
            />
            <Line
              type="monotone"
              dataKey="volume_kcr"
              stroke="#22c55e"
              strokeWidth={1.6}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="ma_kcr"
              stroke="#ef4444"
              strokeWidth={1.8}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

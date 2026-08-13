"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMcap } from "@/lib/types";

type WatchEntry = {
  person_id: string;
  din: string | null;
  name: string;
  note?: string;
};

type SeatEvent = {
  id: number;
  ticker: string;
  company_name: string | null;
  person_id: string;
  director_name: string;
  din: string | null;
  event_type: "joined" | "resigned" | "role_changed";
  old_designation: string | null;
  new_designation: string | null;
  detected_at: string;
  watched: boolean;
  market_cap_cr: number | null;
  cap_code: string | null;
};

type ChangesResponse = {
  watch: WatchEntry[];
  summary: {
    joined: number;
    resigned: number;
    role_changed: number;
    watched: number;
  };
  events: SeatEvent[];
};

function eventLabel(e: SeatEvent): string {
  const co = e.company_name || e.ticker;
  if (e.event_type === "joined") {
    return `Joined ${co} · ${e.new_designation || "Director"}`;
  }
  if (e.event_type === "resigned") {
    return `Left ${co} · was ${e.old_designation || "Director"}`;
  }
  return `Role change at ${co} · ${e.old_designation || "?"} → ${e.new_designation || "?"}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Props = {
  refreshKey?: number;
  onDrillDirector?: (personId: string, name: string) => void;
  onDrillTicker?: (ticker: string) => void;
};

export function GovernanceChangesPanel({
  refreshKey = 0,
  onDrillDirector,
  onDrillTicker,
}: Props) {
  const [watchOnly, setWatchOnly] = useState(true);
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (watchOnly) params.set("watchOnly", "1");
      const res = await fetch(`/api/governance-changes?${params}`);
      if (!res.ok) return;
      setData((await res.json()) as ChangesResponse);
    } finally {
      setLoading(false);
    }
  }, [watchOnly]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const watch = data?.watch ?? [];
  const events = data?.events ?? [];

  return (
    <section className="gov-changes">
      <div className="gov-changes-head">
        <div>
          <h3 className="gov-changes-title">Recent board changes</h3>
          <p className="gov-changes-sub">
            Detected when NSE boards are refreshed (join / exit / role change).
          </p>
        </div>
        <label className="gov-changes-toggle">
          <input
            type="checkbox"
            checked={watchOnly}
            onChange={(e) => setWatchOnly(e.target.checked)}
          />
          Watchlist only
        </label>
      </div>

      {watch.length ? (
        <div className="gov-watch-row">
          <span className="gov-watch-label">Pinned</span>
          {watch.map((w) => (
            <button
              key={w.person_id}
              type="button"
              className="gov-watch-chip"
              title={w.note || w.name}
              onClick={() => onDrillDirector?.(w.person_id, w.name)}
            >
              {w.name.split(" ").slice(-1)[0] || w.name}
              {w.din ? <em>DIN {w.din}</em> : null}
            </button>
          ))}
        </div>
      ) : null}

      {loading && !data ? (
        <p className="gov-changes-empty">Loading changes…</p>
      ) : events.length === 0 ? (
        <p className="gov-changes-empty">
          No changes yet. Run <strong>Refresh page</strong> on Tata boards to
          detect movements after NSE updates.
        </p>
      ) : (
        <ul className="gov-changes-list">
          {events.map((e) => (
            <li
              key={e.id}
              className={`gov-change gov-change-${e.event_type}${e.watched ? " is-watched" : ""}`}
            >
              <div className="gov-change-main">
                <button
                  type="button"
                  className="gov-change-name"
                  onClick={() =>
                    onDrillDirector?.(e.person_id, e.director_name)
                  }
                >
                  {e.director_name}
                  {e.watched ? <span className="gov-badge watch">watch</span> : null}
                </button>
                <span className="gov-change-text">{eventLabel(e)}</span>
              </div>
              <div className="gov-change-meta">
                <button
                  type="button"
                  className="gov-ticker"
                  onClick={() => onDrillTicker?.(e.ticker)}
                >
                  {e.ticker}
                </button>
                {e.cap_code ? (
                  <span className={`result-tag tag-cap-${e.cap_code.toLowerCase()}`}>
                    {e.cap_code}
                  </span>
                ) : null}
                {e.market_cap_cr != null ? (
                  <span className="gov-change-mcap">{formatMcap(e.market_cap_cr)}</span>
                ) : null}
                <time dateTime={e.detected_at}>{formatWhen(e.detected_at)}</time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

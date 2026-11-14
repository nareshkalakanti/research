"use client";

import { useMemo, useState } from "react";
import type { FamilyRow } from "@/components/FamilyMapCards";
import { napkinUrl } from "@/lib/links";
import { loadSignalHits, type SignalHit } from "@/lib/signal-hits";

/**
 * One "Scan signals" for every business group on the Groups view — lists
 * only the groups that have hits, with each stock and its signal tags.
 */

const SIGNALS = [
  {
    key: "crossed_200dma",
    tag: "200 DMA ↑",
    title: "Daily close ≥1% above the 200 DMA after 5 closes below",
  },
  { key: "bb_w", tag: "BB W", title: "Bollinger weekly breakout" },
  { key: "tq_w", tag: "TQ W", title: "TQ : W52 weekly breakout" },
] as const;

const STORE_KEY = "group-strip-scan-v1";
type Saved = { at: string; hits: SignalHit[] };

function readSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Saved;
    return Array.isArray(j?.hits) ? j : null;
  } catch {
    return null;
  }
}

function writeSaved(s: Saved): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked — result still shows this session */
  }
}

function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const hasSignal = (h: SignalHit) => h.crossed_200dma || h.bb_w || h.tq_w;

export function GroupSignalStrip({
  rows,
  chartUrl,
  onPickGroup,
}: {
  rows: FamilyRow[];
  chartUrl?: (ticker: string) => string;
  /** Filter the cards below to this group. */
  onPickGroup?: (key: string) => void;
}) {
  const [saved, setSaved] = useState<Saved | null>(() =>
    typeof window === "undefined" ? null : readSaved(),
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{
      key: string;
      label: string;
      tickers: string[];
      /** Outside listings linked through this group's directors. */
      connected: string[];
    }> = [];
    const norm = (t: string) => t.trim().toUpperCase();
    for (const f of rows) {
      const key = f.group_id || f.family_name;
      if (seen.has(key)) continue;
      seen.add(key);
      const tickers = [...new Set(f.companies.map((c) => norm(c.ticker)))].filter(
        Boolean,
      );
      const own = new Set(tickers);
      const connected = [
        ...new Set((f.outside ?? []).map((c) => norm(c.ticker))),
      ].filter((t) => t && !own.has(t));
      if (tickers.length || connected.length) {
        out.push({ key, label: f.family_name, tickers, connected });
      }
    }
    return out;
  }, [rows]);

  const universe = useMemo(
    () => [...new Set(groups.flatMap((g) => [...g.tickers, ...g.connected]))],
    [groups],
  );

  const scan = async () => {
    if (!universe.length) return;
    setBusy(true);
    setError(null);
    setProgress([0, universe.length]);
    try {
      const map = await loadSignalHits(universe, {
        onProgress: (done, total) => setProgress([done, total]),
      });
      const next: Saved = {
        at: new Date().toISOString(),
        hits: [...map.values()].filter(hasSignal),
      };
      setSaved(next);
      writeSaved(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const { hitGroups, hitConnected } = useMemo(() => {
    if (!saved) return { hitGroups: [], hitConnected: [] };
    const byTicker = new Map(
      saved.hits.filter(hasSignal).map((h) => [h.ticker.toUpperCase(), h]),
    );
    const build = (pick: (g: (typeof groups)[number]) => string[]) =>
      groups
        .map((g) => ({
          key: g.key,
          label: g.label,
          hits: pick(g)
            .map((t) => byTicker.get(t))
            .filter((h): h is SignalHit => !!h),
        }))
        .filter((g) => g.hits.length)
        .sort(
          (a, b) =>
            b.hits.length - a.hits.length || a.label.localeCompare(b.label),
        );
    return {
      hitGroups: build((g) => g.tickers),
      hitConnected: build((g) => g.connected),
    };
  }, [saved, groups]);

  const stockCount = hitGroups.reduce((n, g) => n + g.hits.length, 0);
  const connectedCount = new Set(
    hitConnected.flatMap((g) => g.hits.map((h) => h.ticker)),
  ).size;

  const renderList = (
    list: Array<{ key: string; label: string; hits: SignalHit[] }>,
  ) => (
    <ul className="grp-strip-list">
      {list.map((g) => (
        <li key={g.key} className="grp-strip-row">
          <button
            type="button"
            className="grp-strip-group"
            title={`Show ${g.label} below`}
            onClick={() => onPickGroup?.(g.key)}
          >
            {g.label}
          </button>
          <span className="grp-strip-stocks">
            {g.hits.map((h) => (
              <span key={h.ticker} className="grp-strip-stock">
                <a
                  className="mono"
                  href={chartUrl ? chartUrl(h.ticker) : napkinUrl(h.ticker)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${h.ticker} — TradingView`}
                >
                  {h.ticker}
                </a>
                {SIGNALS.filter((sg) => h[sg.key]).map((sg) => (
                  <span
                    key={sg.key}
                    className={`gov-sig-tag sig-${sg.key}`}
                    title={sg.title}
                  >
                    {sg.key === "tq_w" && h.tq_score != null
                      ? `${sg.tag} ${Math.round(h.tq_score)}`
                      : sg.tag}
                  </span>
                ))}
                <a
                  className="np-chip"
                  href={napkinUrl(h.ticker)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${h.ticker} in Napkin`}
                >
                  NP
                </a>
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="grp-strip" aria-label="Group signals">
      <div className="grp-strip-head">
        <button
          type="button"
          className={`chip chip-scan tag-chip${busy ? " busy on" : ""}`}
          disabled={busy || !universe.length}
          onClick={() => void scan()}
          title="Check every group stock for 200 DMA ↑ (daily), BB W and TQ W"
        >
          {busy
            ? progress
              ? `Scanning ${progress[0]}/${progress[1]}…`
              : "Scanning…"
            : "Scan signals"}
        </button>
        <span className="grp-strip-meta">
          {saved
            ? `${stockCount} group stocks · ${connectedCount} connected companies with signals · scanned ${fmtAt(saved.at)}`
            : `${groups.length} groups · ${universe.length} stocks incl. connected boards — 200 DMA ↑ (daily), BB W, TQ W`}
        </span>
      </div>
      {error ? (
        <p className="grp-strip-empty" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <>
          <h3 className="grp-strip-sub">
            Group stocks <span>{stockCount}</span>
          </h3>
          {hitGroups.length ? (
            renderList(hitGroups)
          ) : (
            <p className="grp-strip-empty">No group stocks with signals.</p>
          )}
          <h3 className="grp-strip-sub">
            Connected companies <span>{connectedCount}</span>
            <em>outside boards linked by each group’s directors</em>
          </h3>
          {hitConnected.length ? (
            renderList(hitConnected)
          ) : (
            <p className="grp-strip-empty">No connected companies with signals.</p>
          )}
        </>
      ) : null}
    </section>
  );
}

"use client";

import { useCallback, useState } from "react";

type Props = {
  bb: boolean;
  tq: boolean;
  onBb: (on: boolean) => void;
  onTq: (on: boolean) => void;
  bbCount?: number;
  tqCount?: number;
  market: string;
  pageTickers?: string[];
  onDone?: () => void | Promise<void>;
};

type Progress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

async function scanOnce(body: Record<string, unknown>) {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("scan failed");
  return (await res.json()) as {
    tried: number;
    bbHits: number;
    tqHits: number;
    remaining: number;
    bbTickers?: string[];
    tqTickers?: string[];
    signals?: { bb: number; tq: number };
  };
}

function formatNewTickers(tickers: string[], limit = 8): string {
  if (!tickers.length) return "";
  const uniq = [...new Set(tickers)];
  const head = uniq.slice(0, limit).join(", ");
  return uniq.length > limit ? `${head}…` : head;
}

/** BB / TQ filter chips + local Yahoo weekly scan (writes data/signals.db). */
export function ScanFilters({
  bb,
  tq,
  onBb,
  onTq,
  bbCount,
  tqCount,
  market,
  pageTickers,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  const run = useCallback(
    async (mode: "page" | "all") => {
      setBusy(true);
      const pageMode = mode === "page";
      setProgress({
        pct: 8,
        label: pageMode ? "Scan page" : "Scan all",
        detail: "Weekly Yahoo · BB + TQ",
      });

      let remaining = pageMode
        ? Math.max(pageTickers?.length || 1, 1)
        : Math.max(200, 1);
      let gotBb = 0;
      let gotTq = 0;
      const newBb: string[] = [];
      const newTq: string[] = [];

      try {
        for (let round = 1; round <= (pageMode ? 1 : 80); round += 1) {
          const json = await scanOnce({
            kind: "both",
            market,
            tickers: pageMode ? pageTickers : undefined,
            limit: pageMode ? Math.min(pageTickers?.length || 40, 80) : 40,
            missingOnly: !pageMode,
          });
          gotBb += json.bbHits;
          gotTq += json.tqHits;
          if (json.bbTickers?.length) newBb.push(...json.bbTickers);
          if (json.tqTickers?.length) newTq.push(...json.tqTickers);
          // Surface new hits in the table as soon as they appear.
          if (json.bbHits > 0) onBb(true);
          if (json.tqHits > 0) onTq(true);
          remaining = json.remaining;
          const pct = pageMode
            ? 100
            : remaining <= 0
              ? 100
              : Math.min(96, 8 + round * 3);
          const names = [
            formatNewTickers(newBb) && `BB ${formatNewTickers(newBb)}`,
            formatNewTickers(newTq) && `TQ ${formatNewTickers(newTq)}`,
          ]
            .filter(Boolean)
            .join(" · ");
          setProgress({
            pct,
            label: pageMode ? "Page done" : `Batch ${round}`,
            detail: `+${gotBb} BB · +${gotTq} TQ${
              names ? ` · ${names}` : ""
            }${pageMode ? "" : ` · ${remaining.toLocaleString()} left`}`,
            done: pageMode || remaining <= 0,
          });
          await onDone?.();
          if (pageMode) break;
          if (json.tried === 0 || remaining <= 0) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        const names = [
          formatNewTickers(newBb) && `BB ${formatNewTickers(newBb)}`,
          formatNewTickers(newTq) && `TQ ${formatNewTickers(newTq)}`,
        ]
          .filter(Boolean)
          .join(" · ");
        setProgress({
          pct: 100,
          label: "Complete",
          detail: `+${gotBb} BB · +${gotTq} TQ${names ? ` · ${names}` : ""}`,
          done: true,
        });
      } catch {
        setProgress({
          pct: 100,
          label: "Failed",
          detail: "Scan request failed",
          error: true,
        });
      } finally {
        setBusy(false);
        await onDone?.();
      }
    },
    [market, pageTickers, onDone, onBb, onTq],
  );

  return (
    <div className="scan-block">
      <div className="chip-row">
        <span className="chip-label">Scan</span>
        <button
          type="button"
          className={`chip tag-chip tag-scan-bb ${bb ? "on" : ""}`}
          onClick={() => onBb(!bb)}
          title="Show BB NEW weekly breakouts"
        >
          BB
          {bbCount != null ? (
            <span className="chip-count">{bbCount.toLocaleString()}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={`chip tag-chip tag-scan-tq ${tq ? "on" : ""}`}
          onClick={() => onTq(!tq)}
          title="Show TQ weekly signals"
        >
          TQ
          {tqCount != null ? (
            <span className="chip-count">{tqCount.toLocaleString()}</span>
          ) : null}
        </button>
        <button
          type="button"
          className="btn-scan"
          disabled={busy || !pageTickers?.length}
          onClick={() => void run("page")}
        >
          Scan page
        </button>
        <button
          type="button"
          className="btn-scan-all"
          disabled={busy}
          onClick={() => void run("all")}
        >
          Scan all
        </button>
      </div>
      {busy || progress ? (
        <div
          className={`fill-progress scan-progress ${progress?.error ? "is-error" : ""} ${progress?.done ? "is-done" : ""}`}
          role="status"
        >
          <div className="fill-progress-meta">
            <span className="fill-progress-label">
              {progress?.label || "Working…"}
            </span>
            <span className="fill-progress-pct">{progress?.pct ?? 0}%</span>
          </div>
          <div className="fill-progress-track">
            <div
              className="fill-progress-bar"
              style={{ width: `${progress?.pct ?? 0}%` }}
            />
          </div>
          {progress?.detail ? (
            <p className="fill-progress-detail">{progress.detail}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

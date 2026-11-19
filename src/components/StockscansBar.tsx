"use client";

import { useCallback, useEffect, useState } from "react";
import type { NanoFillJob } from "@/lib/nanocap-champs";

type Master = {
  total: number;
  tracked: number;
  by_source: Record<string, number>;
  last_sync: { at: string; added: number; changed: number } | null;
  history: number;
};
type Status = { companies: number; mapped: number; pages: number; last: string | null; blocked_at: string | null };

/** Scanner: progress of the StockScans industry scrape, with start / stop. */
export function StockscansBar({ onDone }: { onDone: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [job, setJob] = useState<NanoFillJob | null>(null);
  const [master, setMaster] = useState<Master | null>(null);

  const load = useCallback(async () => {
    try {
      const json = (await (await fetch("/api/stockscans", { cache: "no-store" })).json()) as {
        status: Status;
        master?: Master;
        job: NanoFillJob | null;
      };
      setSt(json.status);
      setMaster(json.master ?? null);
      setJob(json.job);
      return json.job;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const running = !!(job?.running && job.kind === "stockscans");
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(async () => {
      const j = await load();
      if (!j?.running) onDone();
    }, 5000);
    return () => window.clearInterval(id);
  }, [running, load, onDone]);

  const post = async (body: object) => {
    const json = (await (
      await fetch("/api/stockscans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    ).json()) as { job: NanoFillJob | null };
    setJob(json.job);
  };

  if (!st) return null;
  return (
    <div className="sl-status ss-bar" role="status" aria-live="polite">
      <span>
        <strong>Stock master:</strong>{" "}
        {master
          ? `${master.total.toLocaleString("en-IN")} stocks · ${(master.by_source.stockscans ?? 0).toLocaleString("en-IN")} with StockScans industry`
          : `${st.mapped.toLocaleString("en-IN")} StockScans stocks`}
        <span className="sl-sub-inline">
          {master?.last_sync
            ? ` · synced ${new Date(master.last_sync.at).toLocaleString("en-IN")} (+${master.last_sync.added} new, ${master.last_sync.changed} changed)`
            : ""}
          {st.last ? ` · last scrape ${new Date(st.last).toLocaleString("en-IN")}` : " · not scraped yet"}
          {st.blocked_at && !running ? ` · StockScans refused at ${new Date(st.blocked_at).toLocaleString("en-IN")}` : ""}
        </span>
      </span>
      {running ? (
        <span className="sl-fill">
          <span className="ld-spin" aria-hidden /> Scraping page {job!.done.toLocaleString("en-IN")} of{" "}
          {(job!.total || 0).toLocaleString("en-IN")} · {job!.filled.toLocaleString("en-IN")} companies found
          <button type="button" className="btn-ghost" onClick={() => void post({ stop: true })}>
            Stop
          </button>
        </span>
      ) : (
        <span className="sl-fill">
          <button
            type="button"
            className="btn-ghost"
            disabled={!!job?.running}
            onClick={() => void post({})}
            title="Reads StockScans company pages one every 3–5 s; each page also gives ~6 peers"
          >
            {st.mapped ? "Update from StockScans" : "Scrape from StockScans"}
          </button>
        </span>
      )}
    </div>
  );
}

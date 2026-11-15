"use client";

import { useCallback, useEffect, useState } from "react";

type SyncResult = {
  ok: boolean;
  dry_run: boolean;
  skipped?: string;
  error?: string;
  official: { nse: number; nse_sme: number; bse_sme: number };
  added: { nse: string[]; nse_sme: string[]; bse_sme: string[] };
  retagged: Array<{ ticker: string; from: string; to: string }>;
  renamed: Array<{ from: string; to: string; moved_rows: number }>;
  delisted: string[];
  relisted: string[];
  collisions: string[];
  board_scan?: { tried: number; saved: number };
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : "never";
}

function List({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <p className="fill-progress-detail">
      <strong>
        {label} ({items.length}):
      </strong>{" "}
      {items.slice(0, 40).join(", ")}
      {items.length > 40 ? ` … +${items.length - 40} more` : ""}
    </p>
  );
}

/**
 * Data tab: sync the app universe with NSE / NSE SME / BSE SME official lists
 * (adds new listings, fixes board moves, maps renames, marks delisted).
 * Preview first, then Sync. See lib/listing-sync.ts.
 */
export function SyncListingsButton({ onDone }: { onDone?: () => void | Promise<void> }) {
  const [last, setLast] = useState<{ at: string | null; summary: string | null } | null>(null);
  const [busy, setBusy] = useState<"preview" | "sync" | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLast = useCallback(async () => {
    try {
      const j = (await (await fetch("/api/listing-sync", { cache: "no-store" })).json()) as {
        last?: { at: string | null; summary: string | null };
      };
      setLast(j.last ?? null);
    } catch {
      /* status is optional */
    }
  }, []);

  useEffect(() => {
    void loadLast();
  }, [loadLast]);

  const run = async (mode: "preview" | "sync") => {
    setBusy(mode);
    setError(null);
    setResult(null);
    try {
      const res =
        mode === "preview"
          ? await fetch("/api/listing-sync?dry=1", { cache: "no-store" })
          : await fetch("/api/listing-sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scanBoards: true }),
            });
      const json = (await res.json()) as SyncResult;
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      setResult(json);
      if (mode === "sync" && !json.skipped) {
        await loadLast();
        await onDone?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(null);
    }
  };

  const added = result
    ? result.added.nse.length + result.added.nse_sme.length + result.added.bse_sme.length
    : 0;
  const pending = result
    ? added + result.retagged.length + result.renamed.length + result.delisted.length + result.relisted.length
    : 0;

  return (
    <div className={`fill-panel ${busy ? "is-busy" : ""}`}>
      <div className="fill-actions">
        <button
          type="button"
          className="btn-fill"
          disabled={!!busy}
          onClick={() => void run("preview")}
          title="Compare with NSE / NSE SME / BSE SME official lists — no changes"
        >
          {busy === "preview" ? "Checking…" : "Check listings"}
        </button>
        <button
          type="button"
          className="btn-fill-all"
          disabled={!!busy}
          onClick={() => void run("sync")}
          title="Add new listings, fix board moves, map renames, mark delisted; then fetch boards for up to 40 NSE names"
        >
          {busy === "sync" ? "Syncing…" : "Sync listings"}
        </button>
        <span className="fill-progress-detail">
          Last sync: {fmtWhen(last?.at ?? null)}
          {last?.summary ? ` · ${last.summary}` : ""}
        </span>
      </div>

      {error ? (
        <div className="fill-progress is-error">
          <p className="fill-progress-detail">{error}</p>
        </div>
      ) : null}

      {result ? (
        <div className={`fill-progress ${result.skipped ? "is-error" : "is-done"}`}>
          <div className="fill-progress-meta">
            <span className="fill-progress-label">
              {result.skipped
                ? "Skipped"
                : pending === 0
                  ? "Up to date — matches NSE, NSE SME and BSE SME official lists"
                  : result.dry_run
                  ? `Preview — ${added} to add, ${result.retagged.length} board moves, ${result.renamed.length} renamed, ${result.delisted.length} delisted`
                  : `Synced — added ${added}, ${result.retagged.length} board moves, ${result.renamed.length} renamed, ${result.delisted.length} delisted`}
            </span>
          </div>
          {result.skipped ? (
            <p className="fill-progress-detail">{result.skipped}</p>
          ) : (
            <>
              <p className="fill-progress-detail">
                Official lists: NSE {result.official.nse.toLocaleString("en-IN")} · NSE SME{" "}
                {result.official.nse_sme} · BSE SME {result.official.bse_sme}
                {result.board_scan
                  ? ` · boards fetched for ${result.board_scan.saved} of ${result.board_scan.tried}`
                  : ""}
              </p>
              <List label="New NSE" items={result.added.nse} />
              <List label="New NSE SME" items={result.added.nse_sme} />
              <List label="New BSE SME" items={result.added.bse_sme} />
              <List
                label="Board moves"
                items={result.retagged.map((x) => `${x.ticker} ${x.from} → ${x.to}`)}
              />
              <List label="Renamed" items={result.renamed.map((x) => `${x.from} → ${x.to}`)} />
              <List label="Delisted (hidden from scans)" items={result.delisted} />
              <List label="Back on a list" items={result.relisted} />
              <List
                label="Same symbol on NSE and BSE SME (left as is)"
                items={result.collisions}
              />
              {result.dry_run && pending > 0 ? (
                <p className="fill-progress-detail">Click Sync listings to apply.</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

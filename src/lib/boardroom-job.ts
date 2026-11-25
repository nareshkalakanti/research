import { clampAnnouncedDays } from "./announced-lookback";
import {
  discoverBoardRoomAnnounced,
  listBoardRoomPendingHits,
  pushBoardRoomHistoryToGovernance,
  saveBoardRoomHits,
  scanBoardRoomAnnouncements,
  type BoardRoomHit,
} from "./boardroom-screen";

/**
 * Board-filing scan + push to Governance, run inside the app (the Governance
 * page button) instead of `npm run scan:boardroom-bg` / `push:boardroom-gov`.
 * Same steps as those scripts, but through the app's single governance.db
 * writer, so it is safe while the app runs. One job at a time; progress is
 * polled by the page.
 *
 *   1. discover  NSE board / director filings of the last N days → pending PDFs
 *   2. analyse   read each PDF (OCR when scanned), extract directors + DINs,
 *                push new seats to governance.db as it goes
 *   3. push      re-push saved history (catches older analysed filings)
 */

export type BoardroomJobPhase = "discover" | "analyse" | "push" | "done" | "stopped" | "error";

export type BoardroomJoin = { ticker: string; names: string; at: string };

export type BoardroomJob = {
  running: boolean;
  phase: BoardroomJobPhase;
  days: number;
  limit: number;
  /** Filings found by discover this run (new + already known). */
  found: number;
  /** PDFs queued for analysis this run (capped by limit). */
  total: number;
  done: number;
  ok: number;
  failed: number;
  with_din: number;
  current: string[];
  joins: BoardroomJoin[];
  pushed_rows: number;
  pushed_seats: number;
  note: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

const KEY = Symbol.for("research.boardroomJob");
type Holder = { [KEY]?: BoardroomJob & { stop?: boolean } };
const BATCH = 3;
const PAUSE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasDin = (d: { din?: string | null }) => (d.din || "").replace(/\D/g, "").length === 8;

export function boardroomJob(): BoardroomJob | null {
  const j = (globalThis as Holder)[KEY];
  if (!j) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { stop, ...pub } = j;
  return pub;
}

export function stopBoardroomJob(): boolean {
  const j = (globalThis as Holder)[KEY];
  if (!j?.running) return false;
  j.stop = true;
  j.note = "Stopping after the current batch…";
  return true;
}

export function startBoardroomJob(opts?: { days?: number; limit?: number; pendingOnly?: boolean }): BoardroomJob {
  const holder = globalThis as Holder;
  if (holder[KEY]?.running) return boardroomJob()!;
  const days = clampAnnouncedDays(opts?.days ?? 7);
  const limit = Math.min(400, Math.max(1, opts?.limit ?? 60));
  const job: BoardroomJob & { stop?: boolean } = {
    running: true,
    phase: opts?.pendingOnly ? "analyse" : "discover",
    days,
    limit,
    found: 0,
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    with_din: 0,
    current: [],
    joins: [],
    pushed_rows: 0,
    pushed_seats: 0,
    note: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  holder[KEY] = job;

  void (async () => {
    try {
      let sources: BoardRoomHit[] = [];
      if (!opts?.pendingOnly) {
        job.note = `Fetching NSE board filings from the last ${days} days…`;
        const found = await discoverBoardRoomAnnounced(days);
        saveBoardRoomHits(found.sources);
        sources = found.sources;
        job.found = found.sources.length;
        if (found.note) job.note = found.note;
      }
      // Today's finds plus anything still pending from earlier runs.
      const byUrl = new Map<string, BoardRoomHit>();
      for (const s of [...sources, ...listBoardRoomPendingHits()]) {
        const u = s.url?.trim();
        if (u) byUrl.set(u, s);
      }
      sources = [...byUrl.values()];
      job.total = Math.min(limit, sources.length);
      job.phase = "analyse";
      job.note = sources.length ? null : "No new board filings to read.";

      while (job.done < job.total && sources.length && !job.stop) {
        const n = Math.min(BATCH, job.total - job.done);
        job.current = sources.slice(0, n).map((s) => `${(s.ticker || "?").toUpperCase()} · ${(s.title || "").replace(/\s+/g, " ").slice(0, 70)}`);
        const res = await scanBoardRoomAnnouncements({ days, limit: n, pendingOnly: true, sources });
        const attempted = new Set(
          [...res.attempted_urls, ...res.results.map((r) => r.source_url?.trim() || "")].filter(Boolean),
        );
        sources = sources.filter((s) => !attempted.has(s.url?.trim() || ""));
        for (const r of res.results) {
          if (r.ok || r.id != null) job.ok++;
          else job.failed++;
          const dins = (r.extract?.dins || []).filter(hasDin);
          if (dins.length) {
            job.with_din++;
            const names = dins
              .slice(0, 4)
              .map((d) => d.name || d.din)
              .join(", ");
            const ticker = (r.extract?.ticker || "?").toUpperCase();
            // Same notice filed twice (e.g. NSE + amended copy): show it once.
            if (job.joins.some((j) => j.ticker === ticker && j.names === names)) continue;
            job.joins.unshift({
              ticker,
              names,
              at: new Date().toISOString(),
            });
            job.joins = job.joins.slice(0, 30);
          }
        }
        job.done += res.attempted;
        if (res.attempted === 0) break;
        await sleep(PAUSE_MS);
      }
      job.current = [];

      if (!job.stop) {
        job.phase = "push";
        job.note = "Adding directors from saved filings to Governance…";
        const push = pushBoardRoomHistoryToGovernance({ limit: 200 });
        job.pushed_rows = push.pushed_rows;
        job.pushed_seats = push.pushed_seats;
        job.note = null;
      }
      job.phase = job.stop ? "stopped" : "done";
      if (job.stop) job.note = "Stopped. Already-read filings are kept; run again to continue.";
    } catch (e) {
      job.phase = "error";
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      job.running = false;
      job.current = [];
      job.finished_at = new Date().toISOString();
    }
  })();
  return boardroomJob()!;
}

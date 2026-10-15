/**
 * Background BoardRoomIQ scan — separate Node process (not next dev).
 * Resumes automatically: skips URLs already screened in boardroomiq.db.
 *
 *   npm run scan:boardroom-bg -- --days 7 --limit 40
 *   npm run scan:boardroom-bg -- --pending-only --limit 40
 */
import fs from "fs";
import path from "path";
import { clampAnnouncedDays } from "../src/lib/announced-lookback";
import {
  discoverBoardRoomAnnounced,
  listBoardRoomPendingHits,
  saveBoardRoomHits,
  scanBoardRoomAnnouncements,
  type BoardRoomHit,
} from "../src/lib/boardroom-screen";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function dayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`Usage:
  npm run scan:boardroom-bg -- --days 7 --limit 40
  npm run scan:boardroom-bg -- --pending-only --limit 40

Re-run the same command after a crash — already-screened PDFs are skipped.`);
    return;
  }

  const days = clampAnnouncedDays(Number(argValue("--days") || "2") || 2);
  const limit = Math.min(800, Math.max(1, Number(argValue("--limit") || "40") || 40));
  const batch = Math.min(8, Math.max(1, Number(argValue("--batch") || "3") || 3));
  const pauseMs = Math.max(0, Number(argValue("--pause-ms") || "300") || 0);
  const pendingOnly =
    hasFlag("--pending-only") || hasFlag("--no-discover") || hasFlag("--resume");

  const logDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const jsonlPath = path.join(logDir, `boardroom-scan-${dayStamp()}.jsonl`);
  const append = (obj: Record<string, unknown>) => {
    fs.appendFileSync(jsonlPath, `${JSON.stringify(obj)}\n`, "utf8");
  };

  console.log(
    `boardroom-bg · days=${days} limit=${limit} batch=${batch} pauseMs=${pauseMs} pendingOnly=${pendingOnly}`,
  );
  console.log(`log → ${jsonlPath}`);

  let sources: BoardRoomHit[] = [];
  if (!pendingOnly) {
    console.log(`discover · fetching NSE board filings (last ${days}d)…`);
    const found = await discoverBoardRoomAnnounced(days);
    const saved = saveBoardRoomHits(found.sources);
    sources = found.sources;
    console.log(`discover · ${found.sources.length} hits · +${saved} new stubs`);
    if (found.note) console.log(`discover · ${found.note}`);
    append({
      at: new Date().toISOString(),
      event: "discover",
      days,
      count: found.sources.length,
      saved,
    });
  } else {
    console.log("discover · skipped (--pending-only)");
  }

  const pending = listBoardRoomPendingHits();
  const byUrl = new Map<string, BoardRoomHit>();
  for (const s of [...sources, ...pending]) {
    const u = s.url?.trim();
    if (u) byUrl.set(u, s);
  }
  sources = [...byUrl.values()];
  console.log(`queue · ${sources.length} pending PDFs (will analyse up to ${limit})`);
  for (const s of sources.slice(0, 8)) {
    const t = (s.ticker || "?").padEnd(12);
    const title = (s.title || "").replace(/\s+/g, " ").slice(0, 72);
    console.log(`  · ${t} ${title}${title.length >= 72 ? "…" : ""}`);
  }
  if (sources.length > 8) {
    console.log(`  · … +${sources.length - 8} more`);
  }
  append({
    at: new Date().toISOString(),
    event: "queue",
    count: sources.length,
  });

  if (!sources.length) {
    console.log("done · nothing pending");
    return;
  }

  let done = 0;
  let analysed = 0;
  let failed = 0;
  let withDin = 0;
  const t0 = Date.now();
  let round = 0;

  while (done < limit && sources.length) {
    round += 1;
    const thisBatch = Math.min(batch, limit - done);
    const next = sources.slice(0, thisBatch);
    console.log(
      `\n[${round}] batch of ${next.length} · remaining queue ${sources.length} · progress ${done}/${limit}`,
    );
    for (const s of next) {
      console.log(
        `  → ${(s.ticker || "?").padEnd(12)} ${(s.title || "").replace(/\s+/g, " ").slice(0, 60)}`,
      );
    }

    const result = await scanBoardRoomAnnouncements({
      days,
      limit: thisBatch,
      pendingOnly: true,
      sources,
    });

    const attempted = new Set(
      [
        ...result.attempted_urls,
        ...result.results.map((r) => r.source_url?.trim() || ""),
      ].filter(Boolean),
    );
    sources = sources.filter((s) => {
      const u = s.url?.trim();
      return !u || !attempted.has(u);
    });

    for (const r of result.results) {
      if (r.ok || r.id != null) analysed += 1;
      else failed += 1;
      const ticker = (r.extract?.ticker || "?").toUpperCase();
      const dins = r.extract?.dins || [];
      const dinN = dins.filter(
        (d) => (d.din || "").replace(/\D/g, "").length === 8,
      ).length;
      if (dinN > 0) withDin += 1;
      const cat = r.extract?.category || "—";
      const mark = r.ok || r.id != null ? "ok" : "FAIL";
      const err = r.error ? ` · ${r.error.slice(0, 80)}` : "";
      console.log(
        `  ${mark.padEnd(4)} ${ticker.padEnd(12)} status=${r.status || "?"} · DINs=${dinN} · ${cat}${err}`,
      );
      append({
        at: new Date().toISOString(),
        event: "result",
        round,
        ok: r.ok,
        status: r.status ?? null,
        ticker: r.extract?.ticker ?? null,
        dins: dinN,
        category: cat,
        url: r.source_url ?? null,
        engine: r.engine ?? null,
        error: r.error ?? null,
      });
    }

    done += result.attempted;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(
      `[${round}] attempted ${result.attempted} · ok ${result.analysed} fail ${result.failed} · queue ${sources.length} · total ${done}/${limit} · ${elapsed}s`,
    );
    if (result.attempted === 0) break;
    if (pauseMs > 0) await sleep(pauseMs);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  append({
    at: new Date().toISOString(),
    event: "summary",
    attempted: done,
    analysed,
    failed,
    with_din: withDin,
    elapsed_s: elapsed,
  });
  console.log("");
  console.log(
    `done · attempted ${done} · ok ${analysed} · fail ${failed} · with DIN ${withDin} · ${elapsed}s`,
  );
  console.log(`log  · ${jsonlPath}`);
  console.log(
    "next · npm run push:boardroom-gov  (re-push history) · Dashboard → Board changes",
  );
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

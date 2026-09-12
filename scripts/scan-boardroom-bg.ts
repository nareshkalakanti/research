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
    `boardroom-bg · days=${days} limit=${limit} batch=${batch} pendingOnly=${pendingOnly}`,
  );
  console.log(`log → ${jsonlPath}`);

  let sources: BoardRoomHit[] = [];
  if (!pendingOnly) {
    const found = await discoverBoardRoomAnnounced(days);
    const saved = saveBoardRoomHits(found.sources);
    sources = found.sources;
    console.log(`discover · ${found.sources.length} hits · +${saved} stubs`);
    append({
      at: new Date().toISOString(),
      event: "discover",
      days,
      count: found.sources.length,
      saved,
    });
  }

  const pending = listBoardRoomPendingHits();
  const byUrl = new Map<string, BoardRoomHit>();
  for (const s of [...sources, ...pending]) {
    const u = s.url?.trim();
    if (u) byUrl.set(u, s);
  }
  sources = [...byUrl.values()];
  console.log(`queue · ${sources.length} pending PDFs`);
  append({
    at: new Date().toISOString(),
    event: "queue",
    count: sources.length,
  });

  let done = 0;
  let analysed = 0;
  let failed = 0;
  const t0 = Date.now();
  let round = 0;

  while (done < limit && sources.length) {
    round += 1;
    const thisBatch = Math.min(batch, limit - done);
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
      append({
        at: new Date().toISOString(),
        event: "result",
        round,
        ok: r.ok,
        status: r.status ?? null,
        ticker: r.extract?.ticker ?? null,
        url: r.source_url ?? null,
        engine: r.engine ?? null,
        error: r.error ?? null,
      });
    }

    done += result.attempted;
    console.log(
      `[${round}] attempted ${result.attempted} · ok ${result.analysed} fail ${result.failed} · queue ${sources.length} · total ${done}/${limit}`,
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
    elapsed_s: elapsed,
  });
  console.log(
    `done · attempted ${done} · ok ${analysed} · fail ${failed} · ${elapsed}s · ${jsonlPath}`,
  );
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

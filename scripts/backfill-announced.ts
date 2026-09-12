/**
 * Chunked announced stub backfill (metadata only — no PDF download / OCR / LLM).
 * Resumes from checkpoint by default if interrupted.
 *
 *   npm run backfill:announced -- --days 180
 *   npm run backfill:announced -- --days 90 --lane marketiq
 *   npm run backfill:announced -- --days 180 --fresh   # ignore checkpoint
 */
import fs from "fs";
import path from "path";
import {
  ANNOUNCED_MAX_DAYS,
  clampAnnouncedDays,
} from "../src/lib/announced-lookback";
import {
  discoverMarketIqAnnounced,
  saveMarketIqHits,
} from "../src/lib/marketiq-screen";
import {
  discoverBoardRoomAnnounced,
  saveBoardRoomHits,
} from "../src/lib/boardroom-screen";
import {
  discoverOrderbookAnnounced,
  saveOrderbookHits,
} from "../src/lib/orderbook-screen";

type Lane = "marketiq" | "orderbook" | "boardroom";

type Checkpoint = {
  days: number;
  chunk: number;
  lanes: Partial<Record<Lane, number>>; // next fromOffset per lane
};

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

function parseLanes(): Lane[] {
  const raw = (argValue("--lane") || "all").toLowerCase();
  if (raw === "all") return ["marketiq", "orderbook", "boardroom"];
  if (raw === "marketiq" || raw === "orderbook" || raw === "boardroom") {
    return [raw];
  }
  throw new Error(`Unknown --lane ${raw} (use marketiq|orderbook|boardroom|all)`);
}

function ckptPath(): string {
  return path.join(process.cwd(), "logs", "announced-backfill.ckpt.json");
}

function loadCheckpoint(
  days: number,
  chunk: number,
  fresh: boolean,
): Checkpoint {
  if (fresh) {
    return { days, chunk, lanes: {} };
  }
  try {
    const raw = fs.readFileSync(ckptPath(), "utf8");
    const j = JSON.parse(raw) as Checkpoint;
    if (j && j.days === days) return { days, chunk, lanes: j.lanes || {} };
  } catch {
    /* no ckpt */
  }
  return { days, chunk, lanes: {} };
}

function saveCheckpoint(ckpt: Checkpoint): void {
  fs.mkdirSync(path.dirname(ckptPath()), { recursive: true });
  fs.writeFileSync(ckptPath(), `${JSON.stringify(ckpt, null, 2)}\n`, "utf8");
}

async function backfillLane(
  lane: Lane,
  days: number,
  chunk: number,
  pauseMs: number,
  startOffset: number,
  ckpt: Checkpoint,
  log: (line: string) => void,
): Promise<{ found: number; saved: number; errors: number }> {
  let found = 0;
  let saved = 0;
  let errors = 0;

  if (startOffset > 0) {
    log(`[${lane}] resume from offset ${startOffset}`);
  }

  for (let fromOffset = startOffset; fromOffset < days; fromOffset += chunk) {
    const span = Math.min(chunk, days - fromOffset);
    const t0 = Date.now();
    try {
      if (lane === "marketiq") {
        const r = await discoverMarketIqAnnounced(span, { fromOffset });
        found += r.sources.length;
        const n = saveMarketIqHits(r.sources);
        saved += n;
        log(
          `[${lane}] offset ${fromOffset}..${fromOffset + span - 1} · ${r.sources.length} hits · +${n} saved · ${Date.now() - t0}ms`,
        );
      } else if (lane === "boardroom") {
        const r = await discoverBoardRoomAnnounced(span, { fromOffset });
        found += r.sources.length;
        const n = saveBoardRoomHits(r.sources);
        saved += n;
        log(
          `[${lane}] offset ${fromOffset}..${fromOffset + span - 1} · ${r.sources.length} hits · +${n} saved · ${Date.now() - t0}ms`,
        );
      } else {
        const r = await discoverOrderbookAnnounced(span, { fromOffset });
        found += r.sources.length;
        const n = saveOrderbookHits(r.sources);
        saved += n;
        log(
          `[${lane}] offset ${fromOffset}..${fromOffset + span - 1} · ${r.sources.length} hits · +${n} saved · ${Date.now() - t0}ms${r.note ? ` · ${r.note}` : ""}`,
        );
      }
      ckpt.lanes[lane] = fromOffset + span;
      saveCheckpoint(ckpt);
    } catch (e) {
      errors += 1;
      const msg = e instanceof Error ? e.message : String(e);
      log(
        `[${lane}] ERROR offset ${fromOffset}..${fromOffset + span - 1} · ${msg}`,
      );
      // keep last good offset so --resume continues here
      break;
    }
    if (fromOffset + chunk < days && pauseMs > 0) await sleep(pauseMs);
  }

  return { found, saved, errors };
}

async function main() {
  const days = clampAnnouncedDays(
    Number(argValue("--days") || "90") || 90,
  );
  const chunk = Math.min(
    14,
    Math.max(1, Number(argValue("--chunk") || "5") || 5),
  );
  const pauseMs = Math.max(0, Number(argValue("--pause-ms") || "400") || 0);
  const lanes = parseLanes();
  const fresh = hasFlag("--fresh") || hasFlag("--no-resume");

  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`Usage:
  npm run backfill:announced -- --days 90
  npm run backfill:announced -- --days 180
  npm run backfill:announced -- --days 180 --lane marketiq
  npm run backfill:announced -- --days 180 --lane boardroom
  npm run backfill:announced -- --days 180 --lane orderbook
  npm run backfill:announced -- --days 180 --fresh

Stub-only: ticker/title/url/date into IQ DBs (pending). No PDF download.
Interrupted runs resume from logs/announced-backfill.ckpt.json (use --fresh to restart).

Max days: ${ANNOUNCED_MAX_DAYS}`);
    return;
  }

  const logDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `announced-backfill-${stamp}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const log = (line: string) => {
    const row = `${new Date().toISOString()} ${line}`;
    console.log(row);
    logStream.write(`${row}\n`);
  };

  const ckpt = loadCheckpoint(days, chunk, fresh);
  log(
    `start days=${days} chunk=${chunk} pauseMs=${pauseMs} lanes=${lanes.join(",")} resume=${!fresh} ckpt=${JSON.stringify(ckpt.lanes)}`,
  );
  const t0 = Date.now();
  const summary: Record<string, { found: number; saved: number; errors: number }> =
    {};

  for (const lane of lanes) {
    const startOffset = Math.max(0, Number(ckpt.lanes[lane] || 0) || 0);
    if (startOffset >= days) {
      log(`[${lane}] already complete (offset ${startOffset} >= ${days})`);
      summary[lane] = { found: 0, saved: 0, errors: 0 };
      continue;
    }
    summary[lane] = await backfillLane(
      lane,
      days,
      chunk,
      pauseMs,
      startOffset,
      ckpt,
      log,
    );
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  log(`done in ${elapsed}s · ${JSON.stringify(summary)}`);
  log(`log file: ${logPath}`);
  log(`checkpoint: ${ckptPath()}`);
  logStream.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

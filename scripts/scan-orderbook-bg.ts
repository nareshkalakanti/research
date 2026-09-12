/**
 * Background OrderBook scan — separate Node process (not next dev).
 * Resumes automatically: skips URLs already PASS/FAIL in orderbookiq.db.
 *
 *   npm run scan:orderbook-bg -- --days 2 --limit 30 --mode lexical
 *   npm run scan:orderbook-bg -- --pending-only --limit 30
 *   npm run scan:orderbook-bg -- --days 7 --limit 50 --ocr
 */
import fs from "fs";
import path from "path";
import { clampAnnouncedDays } from "../src/lib/announced-lookback";
import {
  discoverOrderbookAnnounced,
  listOrderbookPendingHits,
  saveOrderbookHits,
  scanOrderbookAnnouncements,
  type OrderbookAnnouncedHit,
} from "../src/lib/orderbook-screen";

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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`Usage:
  npm run scan:orderbook-bg -- --days 2 --limit 30 --mode lexical
  npm run scan:orderbook-bg -- --days 7 --limit 50 --ocr
  npm run scan:orderbook-bg -- --pending-only --limit 30

Flags:
  --days N          discover lookback (default 2; max 180)
  --limit N         max PDFs to analyse this run (default 30)
  --batch N         parallel batch size per round (default 3)
  --mode lexical|llm  extract mode (default lexical)
  --ocr             force OCR-friendly path (sets ORDERBOOK_OCR=1)
  --pending-only    skip discover; scan stubs already in DB
  --resume          alias of --pending-only
  --pause-ms N      pause between batches (default 300)

Re-run after a crash — already PASS/FAIL PDFs are skipped.`);
    return;
  }

  const days = clampAnnouncedDays(Number(argValue("--days") || "2") || 2);
  const limit = Math.min(500, Math.max(1, Number(argValue("--limit") || "30") || 30));
  const batch = Math.min(8, Math.max(1, Number(argValue("--batch") || "3") || 3));
  const pauseMs = Math.max(0, Number(argValue("--pause-ms") || "300") || 0);
  const modeRaw = (argValue("--mode") || "lexical").toLowerCase();
  const mode = modeRaw === "llm" ? "llm" : "lexical";
  const pendingOnly =
    hasFlag("--pending-only") ||
    hasFlag("--no-discover") ||
    hasFlag("--resume");
  const wantOcr = hasFlag("--ocr");

  if (wantOcr) {
    process.env.ORDERBOOK_OCR = "1";
  } else if (!process.env.ORDERBOOK_OCR) {
    process.env.ORDERBOOK_OCR = "0";
  }

  const logDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const jsonlPath = path.join(logDir, `orderbook-scan-${dayStamp()}.jsonl`);
  const append = (obj: Record<string, unknown>) => {
    fs.appendFileSync(jsonlPath, `${JSON.stringify(obj)}\n`, "utf8");
  };

  console.log(
    `orderbook-bg · days=${days} limit=${limit} batch=${batch} mode=${mode} ocr=${process.env.ORDERBOOK_OCR} pendingOnly=${pendingOnly}`,
  );
  console.log(`log → ${jsonlPath}`);

  let sources: OrderbookAnnouncedHit[] = [];
  if (!pendingOnly) {
    const found = await discoverOrderbookAnnounced(days);
    const saved = saveOrderbookHits(found.sources);
    sources = found.sources;
    console.log(
      `discover · ${found.sources.length} hits · +${saved} stubs saved${found.note ? ` · ${found.note}` : ""}`,
    );
    append({
      at: new Date().toISOString(),
      event: "discover",
      days,
      count: found.sources.length,
      saved,
      note: found.note ?? null,
    });
  }

  const pending = listOrderbookPendingHits();
  const byUrl = new Map<string, OrderbookAnnouncedHit>();
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

  const skipUrls: string[] = [];
  let done = 0;
  let passed = 0;
  let failed = 0;
  let errors = 0;
  const t0 = Date.now();
  let round = 0;

  while (done < limit && sources.length) {
    round += 1;
    const room = limit - done;
    const thisBatch = Math.min(batch, room);
    const result = await scanOrderbookAnnouncements({
      days,
      limit: thisBatch,
      pendingOnly: true,
      sources,
      mode,
      skipUrls,
    });

    for (const u of result.attempted_urls) {
      if (u && !skipUrls.includes(u)) skipUrls.push(u);
    }
    sources = sources.filter((s) => {
      const u = s.url?.trim();
      return !u || !skipUrls.includes(u);
    });

    for (const r of result.results) {
      if (r.decision === "pass") passed += 1;
      else failed += 1;
      if (!r.ok) errors += 1;

      append({
        at: new Date().toISOString(),
        event: "result",
        round,
        ok: r.ok,
        decision: r.decision,
        ticker: r.extract?.ticker ?? null,
        url: r.source_url ?? null,
        engine: r.engine ?? null,
        why: r.why ?? null,
        error: r.error ?? null,
        pending_fields: r.pending_fields,
      });
    }

    done += result.attempted;
    console.log(
      `[${round}] attempted ${result.attempted} · pass ${result.passed} fail ${result.failed} · queue ${sources.length} · total ${done}/${limit}`,
    );

    if (result.attempted === 0 || result.remaining <= 0) break;
    if (pauseMs > 0) await sleep(pauseMs);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const summary = {
    at: new Date().toISOString(),
    event: "summary",
    days,
    mode,
    ocr: process.env.ORDERBOOK_OCR,
    attempted: done,
    passed,
    failed,
    errors,
    elapsed_s: elapsed,
    log: jsonlPath,
  };
  append(summary);
  console.log(
    `done · attempted ${done} · pass ${passed} · fail ${failed} · ${elapsed}s · ${jsonlPath}`,
  );
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

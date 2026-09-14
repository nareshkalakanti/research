/**
 * Background MarketIQ + Concall pipeline for watchlist tickers.
 * Queued (serial) so adds don't stampede the LLM / exchange APIs.
 */

export type WatchAnalyzeStatus = {
  ticker: string;
  phase: "queued" | "running" | "done" | "error";
  pct: number;
  label: string;
  detail: string | null;
  error: string | null;
  updated_at: string;
};

type ProgressFn = (p: {
  pct: number;
  label: string;
  detail?: string | null;
}) => void;

type RunOpts = {
  /** Skip MarketIQ analyse when DB already has a card and queue is empty noise. */
  hasMarketIq?: boolean;
  market?: string | null;
  price?: number | null;
};

const EVENT = "research:watchlist-analyze";
const statuses = new Map<string, WatchAnalyzeStatus>();
const queue: string[] = [];
const running = new Set<string>();
const optsByTicker = new Map<string, RunOpts>();
let pumping = false;

function normalize(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/[^A-Z0-9.&-]/g, "");
}

function emit() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT));
}

function setStatus(partial: Omit<WatchAnalyzeStatus, "updated_at">) {
  const next: WatchAnalyzeStatus = {
    ...partial,
    updated_at: new Date().toISOString(),
  };
  statuses.set(partial.ticker, next);
  emit();
}

export function getWatchAnalyzeStatus(
  ticker: string,
): WatchAnalyzeStatus | null {
  const t = normalize(ticker);
  if (!t) return null;
  return statuses.get(t) ?? null;
}

export function listWatchAnalyzeStatuses(): WatchAnalyzeStatus[] {
  return [...statuses.values()];
}

export function subscribeWatchAnalyze(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const on = () => listener();
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}

function junkScore(title: string): number {
  if (/trading window|certificate under|depositor|spurt in volume/i.test(title))
    return 3;
  if (/general updates|resignation|credit rating/i.test(title)) return 2;
  if (/shareholders meeting|appointment/i.test(title)) return 1;
  if (
    /board meeting|issue of securities|outcome|preferential|fund.?raise/i.test(
      title,
    )
  ) {
    return 0;
  }
  return 1;
}

async function runPipeline(ticker: string, opts: RunOpts, onProgress: ProgressFn) {
  type WorkItem = {
    ticker: string;
    company: string | null;
    title: string;
    url: string;
    announced_at: string | null;
    historyId?: number;
  };

  let ok = 0;
  let fail = 0;
  let lastErr: string | null = null;
  let concallNote: string | null = null;
  let concallOk = false;

  onProgress({ pct: 8, label: "1/5 Load pending", detail: `DB stubs for ${ticker}` });
  const pendingRes = await fetch(
    `/api/marketiq?pending=1&ticker=${encodeURIComponent(ticker)}&limit=12`,
  );
  const pendingJson = (await pendingRes.json()) as {
    ok?: boolean;
    pending?: Array<{
      ticker: string;
      company: string | null;
      title: string;
      url: string | null;
      announced_at: string | null;
      historyId: number;
    }>;
    error?: string;
  };
  if (!pendingRes.ok || pendingJson.ok === false) {
    throw new Error(pendingJson.error || "Pending lookup failed");
  }

  const byUrl = new Map<string, WorkItem>();
  for (const p of pendingJson.pending || []) {
    const u = p.url?.trim();
    if (!u) continue;
    byUrl.set(u, {
      ticker: p.ticker,
      company: p.company,
      title: p.title,
      url: u,
      announced_at: p.announced_at,
      historyId: p.historyId,
    });
  }

  if (byUrl.size === 0) {
    onProgress({
      pct: 14,
      label: "1/5 Fetch NSE",
      detail: "No pending stubs — checking NSE (14d)",
    });
    try {
      const announcedRes = await fetch(
        `/api/marketiq?announced=1&days=14&q=${encodeURIComponent(ticker)}&fresh=1`,
        { signal: AbortSignal.timeout(90_000) },
      );
      const announced = (await announcedRes.json()) as {
        ok?: boolean;
        sources?: Array<{
          ticker: string;
          company: string | null;
          title: string;
          url: string | null;
          announced_at: string | null;
        }>;
      };
      if (announcedRes.ok && announced.ok !== false) {
        const nseSources = (announced.sources || []).filter(
          (s) =>
            (s.ticker || "").toUpperCase() === ticker && !!s.url?.trim(),
        );
        if (nseSources.length) {
          await fetch("/api/marketiq", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "save", sources: nseSources }),
          });
          for (const s of nseSources) {
            const u = s.url!.trim();
            if (!byUrl.has(u)) {
              byUrl.set(u, {
                ticker: s.ticker,
                company: s.company,
                title: s.title,
                url: u,
                announced_at: s.announced_at,
              });
            }
          }
        }
      }
    } catch (e) {
      lastErr =
        e instanceof Error ? e.message : "NSE fetch failed (continuing)";
    }
  }

  onProgress({
    pct: 20,
    label: "2/5 Queue",
    detail: `${byUrl.size} candidate filing(s)`,
  });

  const useful = [...byUrl.values()]
    .sort((a, b) => junkScore(a.title) - junkScore(b.title))
    .filter((s) => junkScore(s.title) < 3)
    .slice(0, 2);
  const work =
    useful.length > 0
      ? useful
      : opts.hasMarketIq
        ? []
        : [...byUrl.values()]
            .sort((a, b) => junkScore(a.title) - junkScore(b.title))
            .slice(0, 1);

  if (work.length === 0) {
    onProgress({
      pct: 48,
      label: "3/5 MarketIQ",
      detail: "Nothing pending to analyse",
    });
  } else {
    for (let i = 0; i < work.length; i++) {
      const s = work[i]!;
      const base = 22;
      const span = 30;
      onProgress({
        pct: base + ((i + 0.2) / work.length) * span,
        label: `3/5 MarketIQ ${i + 1}/${work.length}`,
        detail: (s.title || "Filing").slice(0, 52),
      });
      try {
        const one = await fetch("/api/marketiq", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "analyse",
            url: s.url,
            ticker: s.ticker,
            company: s.company,
            title: s.title,
            announced_at: s.announced_at,
            historyId: s.historyId ?? null,
            skipOcr: true,
          }),
          signal: AbortSignal.timeout(180_000),
        });
        const json = (await one.json()) as { ok?: boolean; error?: string };
        if (one.ok && json.ok !== false) ok += 1;
        else {
          fail += 1;
          lastErr = json.error || `HTTP ${one.status}`;
        }
      } catch (e) {
        fail += 1;
        lastErr = e instanceof Error ? e.message : "Analyse failed";
      }
      onProgress({
        pct: base + ((i + 1) / work.length) * span,
        label: `3/5 MarketIQ ${i + 1}/${work.length}`,
        detail: `${ok} ok · ${fail} fail`,
      });
    }
  }

  onProgress({
    pct: 56,
    label: "4/5 Concall",
    detail: "Find / Analyze highlights…",
  });
  try {
    const ccRes = await fetch("/api/concall-screen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "auto", ticker }),
      signal: AbortSignal.timeout(420_000),
    });
    const ccJson = (await ccRes.json()) as {
      ok?: boolean;
      skipped?: boolean;
      decision?: string;
      why?: string;
      error?: string;
    };
    if (ccJson.skipped) {
      concallOk = true;
      concallNote = "Concall PASS ready";
    } else if (ccJson.decision === "pass" || ccJson.ok) {
      concallOk = ccJson.decision === "pass";
      concallNote =
        ccJson.decision === "pass"
          ? "Concall Analyze PASS"
          : `Concall ${ccJson.decision || "done"}`;
    } else {
      concallNote = ccJson.error || ccJson.why || "No concall materials";
    }
    onProgress({
      pct: 84,
      label: "4/5 Concall",
      detail: (concallNote || "done").slice(0, 64),
    });
  } catch (e) {
    concallNote = e instanceof Error ? e.message : "Concall auto failed";
    onProgress({
      pct: 84,
      label: "4/5 Concall",
      detail: concallNote.slice(0, 64),
    });
  }

  onProgress({ pct: 90, label: "5/5 Refresh", detail: "Quarters + watchlist" });
  const qParams = new URLSearchParams({ ticker });
  if (opts.market) qParams.set("market", opts.market);
  if (opts.price != null && Number.isFinite(opts.price) && opts.price > 0) {
    qParams.set("price", String(opts.price));
  }
  await fetch(`/api/quarters?${qParams}`, {
    signal: AbortSignal.timeout(90_000),
  }).catch(() => null);

  const miqDetail =
    ok > 0
      ? `${ok} MarketIQ${fail ? ` · ${fail} failed` : ""}`
      : fail > 0
        ? `MarketIQ ${fail} failed${lastErr ? ` · ${lastErr}` : ""}`
        : opts.hasMarketIq
          ? "MarketIQ ok"
          : "No MarketIQ pending";
  const detail = [miqDetail, concallNote].filter(Boolean).join(" · ");
  const hardFail = ok === 0 && fail > 0 && !opts.hasMarketIq && !concallOk;
  return {
    detail,
    error: hardFail ? lastErr || "Analyse failed" : null,
  };
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const ticker = queue.shift()!;
      if (running.has(ticker)) continue;
      running.add(ticker);
      const opts = optsByTicker.get(ticker) || {};
      setStatus({
        ticker,
        phase: "running",
        pct: 4,
        label: "Starting…",
        detail: `Preparing ${ticker}`,
        error: null,
      });
      try {
        const result = await runPipeline(ticker, opts, ({ pct, label, detail }) => {
          setStatus({
            ticker,
            phase: "running",
            pct: Math.max(0, Math.min(100, Math.round(pct))),
            label,
            detail: detail ?? null,
            error: null,
          });
        });
        setStatus({
          ticker,
          phase: result.error ? "error" : "done",
          pct: 100,
          label: result.error ? "Failed" : "Done",
          detail: result.detail,
          error: result.error,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Analyse failed";
        setStatus({
          ticker,
          phase: "error",
          pct: 100,
          label: "Failed",
          detail: msg,
          error: msg,
        });
      } finally {
        running.delete(ticker);
        optsByTicker.delete(ticker);
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * Queue MarketIQ + Concall analyze for a watchlist ticker.
 * Safe to call from addWatch / Get data / panel backfill.
 */
export function enqueueWatchlistAnalyze(
  tickerRaw: string,
  opts?: RunOpts,
): void {
  if (typeof window === "undefined") return;
  const ticker = normalize(tickerRaw);
  if (!ticker) return;
  if (running.has(ticker) || queue.includes(ticker)) {
    if (opts) {
      optsByTicker.set(ticker, { ...optsByTicker.get(ticker), ...opts });
    }
    return;
  }
  if (opts) optsByTicker.set(ticker, opts);
  else if (!optsByTicker.has(ticker)) optsByTicker.set(ticker, {});

  setStatus({
    ticker,
    phase: "queued",
    pct: 0,
    label: "Queued",
    detail: "Waiting to analyze…",
    error: null,
  });
  queue.push(ticker);
  void pump();
}

/** Force re-run (Get data button). */
export function enqueueWatchlistAnalyzeForce(
  tickerRaw: string,
  opts?: RunOpts,
): void {
  if (typeof window === "undefined") return;
  const ticker = normalize(tickerRaw);
  if (!ticker) return;
  if (running.has(ticker) || queue.includes(ticker)) {
    if (opts) optsByTicker.set(ticker, { ...optsByTicker.get(ticker), ...opts });
    return;
  }
  optsByTicker.set(ticker, opts || {});
  setStatus({
    ticker,
    phase: "queued",
    pct: 0,
    label: "Queued",
    detail: "Waiting to analyze…",
    error: null,
  });
  queue.push(ticker);
  void pump();
}

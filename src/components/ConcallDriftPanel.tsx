"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StrategyConcallDriftRow,
  type StrategyConcallDriftRowData,
} from "@/components/StrategyConcallDriftRow";
import {
  MarketCapRangeBar,
  MCAP_RANGE_STEPS,
  mcapBoundsNarrowed,
  mcapCrToIndex,
  resolveMcapBounds,
  type McapExactBounds,
} from "@/components/MarketCapRangeBar";
import { parseFetchJson } from "@/lib/fetch-json";
import { loadTrackPins, saveTrackPins } from "@/lib/concall-track";
import { driftPctDisplayReady } from "@/lib/strategy/concall-drift-math";

function isStaleDriftRow(r: StrategyConcallDriftRowData): boolean {
  if (!r.has_baseline || r.drift_pct != null) return false;
  if (r.drift_block === "stale") return true;
  if (r.drift_block === "pending") return false;
  // Older payloads without drift_block — fall back to session gate.
  const at = r.concall_at || r.earn_at;
  return Boolean(at) && driftPctDisplayReady(at);
}

function isPendingDriftRow(r: StrategyConcallDriftRowData): boolean {
  if (!r.has_baseline || r.drift_pct != null) return false;
  if (r.drift_block === "pending") return true;
  if (r.drift_block === "stale") return false;
  const at = r.concall_at || r.earn_at;
  return Boolean(at) && !driftPctDisplayReady(at);
}

const KIND = "concall_drift" as const;
const MCAP_DEFAULT_MAX = MCAP_RANGE_STEPS.length - 1;
/** Tickers per refresh request — keeps each call short so the bar can advance. */
const PRICE_CHUNK = 25;
/** Announced lookback for Scan Latest (IST days). */
const SCAN_ANNOUNCED_DAYS = 5;
const SCAN_BATCH = 32;
const SCAN_MAX_ROUNDS = 40;

type ScanApiResponse = {
  ok?: boolean;
  tried?: number;
  saved?: number;
  failed?: number;
  remaining?: number;
  remaining_tickers?: string[];
  announced?: number;
  message?: string;
  error?: string;
};

type DriftView = "latest" | "gainers" | "losers" | "track";

type ApiResponse = {
  kind: typeof KIND;
  rows: StrategyConcallDriftRowData[];
  total_events?: number;
  with_baseline?: number;
  error?: string;
};

function eventTs(r: StrategyConcallDriftRowData): number {
  return Date.parse(r.concall_at || r.earn_at) || 0;
}

/** Split pasted / typed tickers: spaces, commas, semicolons, newlines. */
function parseTrackTickers(raw: string): string[] {
  return [
    ...new Set(
      raw
        .toUpperCase()
        .split(/[\s,;|]+/)
        .map((s) => s.trim())
        .filter((s) => /^[A-Z][A-Z0-9.&-]{0,24}$/.test(s)),
    ),
  ].slice(0, 50);
}

export function ConcallDriftPanel() {
  const [view, setView] = useState<DriftView>("latest");
  const [pins, setPins] = useState<string[]>(() => loadTrackPins());
  const [addTicker, setAddTicker] = useState("");
  const [rows, setRows] = useState<StrategyConcallDriftRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [priceProgress, setPriceProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [scanProgress, setScanProgress] = useState<{
    label: string;
    pct: number;
  } | null>(null);
  const [bgUpdating, setBgUpdating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const scanCancel = useRef<{ cancelled: boolean } | null>(null);
  const [meta, setMeta] = useState<{ total?: number; baseline?: number }>({});
  const [mcapMinIndex, setMcapMinIndex] = useState(0);
  const [mcapMaxIndex, setMcapMaxIndex] = useState(MCAP_DEFAULT_MAX);
  const [mcapExact, setMcapExact] = useState<McapExactBounds | null>(null);
  const [search, setSearch] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const loadGen = useRef(0);
  const skipPinsReload = useRef(false);
  /** Shared Latest/Gainers/Losers board — reused when hopping tabs (no re-fetch). */
  const universeCache = useRef<{
    key: string;
    rows: StrategyConcallDriftRowData[];
    meta: { total?: number; baseline?: number };
  } | null>(null);

  const isTrack = view === "track";
  const mcapBounds = resolveMcapBounds(mcapMinIndex, mcapMaxIndex, mcapExact);
  const mcapMinCr = mcapBounds.minCr;
  const mcapMaxCr = mcapBounds.maxCr;
  const mcapNarrowed = mcapBoundsNarrowed(mcapMinCr, mcapMaxCr);
  const universeKey = useMemo(
    () => `${searchQ}|${mcapMinCr ?? ""}|${mcapMaxCr ?? ""}`,
    [searchQ, mcapMinCr, mcapMaxCr],
  );

  useEffect(() => {
    const t = window.setTimeout(() => setSearchQ(search.trim()), 280);
    return () => window.clearTimeout(t);
  }, [search]);

  const applyMcapParams = useCallback(
    (params: URLSearchParams) => {
      if ((mcapMinCr ?? 0) > 0) params.set("mcapMin", String(mcapMinCr));
      if (mcapMaxCr != null) params.set("mcapMax", String(mcapMaxCr));
    },
    [mcapMinCr, mcapMaxCr],
  );

  const loadUniverse = useCallback(async (opts?: {
    refreshPrices?: boolean;
    silent?: boolean;
    cacheKey?: string;
  }): Promise<StrategyConcallDriftRowData[]> => {
    const cacheKey = opts?.cacheKey ?? universeKey;
    const gen = ++loadGen.current;
    const silent = opts?.silent === true;
    const refreshPrices = opts?.refreshPrices === true;
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    } else if (refreshPrices) {
      setRefreshingPrices(true);
    }

    try {
      const params = new URLSearchParams({
        kind: KIND,
        market: "All",
        cap: "All",
        // One board for Latest / Gainers / Losers — client sorts/filters.
        sort: "all",
        window: "last30",
        limit: searchQ ? "80" : "400",
        lite: "1",
      });
      if (searchQ) params.set("q", searchQ);
      // Keep day mix for Latest; Gainers/Losers still see movers from this set.
      if (!searchQ) params.set("diversifyPerDay", "18");
      applyMcapParams(params);
      if (refreshPrices) params.set("refresh", "1");
      // No AbortSignal.timeout — stale gens are ignored; avoids unhandled TimeoutError.
      const res = await fetch(`/api/strategy?${params}`);
      if (gen !== loadGen.current) {
        return universeCache.current?.rows ?? [];
      }
      const json = await parseFetchJson<ApiResponse>(res);
      if (!res.ok || json.error) {
        throw new Error(json.error || `Load failed (${res.status})`);
      }
      const nextRows = json.rows || [];
      const nextMeta = {
        total: json.total_events,
        baseline: json.with_baseline,
      };
      if (gen === loadGen.current) {
        setRows(nextRows);
        setMeta(nextMeta);
        universeCache.current = {
          key: cacheKey,
          rows: nextRows,
          meta: nextMeta,
        };
      }
      return nextRows;
    } catch (err) {
      if (gen !== loadGen.current) {
        return universeCache.current?.rows ?? [];
      }
      if (!silent) {
        const raw = err instanceof Error ? err.message : "Failed to load";
        const msg = /failed to fetch|networkerror|load failed/i.test(raw)
          ? "Network dropped — try Refresh"
          : /abort|timeout/i.test(raw)
            ? "Request timed out — try again"
            : raw;
        if (!universeCache.current?.rows.length) setLoadError(msg);
        else setAddMsg(msg);
      }
      return universeCache.current?.key === cacheKey
        ? universeCache.current.rows
        : [];
    } finally {
      if (!silent && gen === loadGen.current) setLoading(false);
      if (silent && refreshPrices && gen === loadGen.current) {
        setRefreshingPrices(false);
      }
    }
  }, [applyMcapParams, searchQ, universeKey]);

  const loadUniverseRef = useRef(loadUniverse);
  loadUniverseRef.current = loadUniverse;

  const loadTrack = useCallback(
    async (
      pinList: string[],
      opts?: { soft?: boolean; refreshPrices?: boolean },
    ) => {
      const gen = ++loadGen.current;
      const soft = opts?.soft === true;
      const refreshPrices = opts?.refreshPrices === true;
      if (!soft) {
        setLoading(true);
        setLoadError(null);
      } else if (refreshPrices) {
        setRefreshingPrices(true);
      }
      if (!pinList.length) {
        setRows([]);
        setLoading(false);
        setRefreshingPrices(false);
        return;
      }
      try {
        const params = new URLSearchParams({
          kind: KIND,
          market: "All",
          cap: "All",
          sort: "all",
          lite: "1",
          limit: String(Math.min(80, pinList.length)),
          tickers: pinList.slice(0, 80).join(","),
        });
        if (refreshPrices) params.set("refresh", "1");
        const res = await fetch(`/api/strategy?${params}`);
        if (gen !== loadGen.current) return;
        const json = await parseFetchJson<ApiResponse>(res);
        if (!res.ok || json.error) {
          throw new Error(json.error || `Load failed (${res.status})`);
        }
        if (gen !== loadGen.current) return;
        const pinSet = new Set(pinList);
        const byTicker = new Map<string, StrategyConcallDriftRowData>();
        for (const r of json.rows || []) {
          const t = r.ticker.toUpperCase();
          if (!pinSet.has(t)) continue;
          const prev = byTicker.get(t);
          if (!prev || eventTs(r) > eventTs(prev)) byTicker.set(t, r);
        }
        const next = [...byTicker.values()].sort(
          (a, b) => eventTs(b) - eventTs(a),
        );
        setRows(next);
      } catch (err) {
        if (gen !== loadGen.current) return;
        if (!soft) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load",
          );
        }
      } finally {
        if (gen !== loadGen.current) return;
        setLoading(false);
        if (refreshPrices) setRefreshingPrices(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (view === "track") return;
    const cached = universeCache.current;
    // Hop Latest ↔ Gainers ↔ Losers with the same mcap/search: reuse board + prices.
    if (cached && cached.key === universeKey) {
      setRows(cached.rows);
      setMeta(cached.meta);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoadError(null);
    // Debounce filter changes so Min/Max typing doesn't stack fetches.
    // Do not abort on cleanup — that caused unhandled AbortError spam.
    const key = universeKey;
    const silent = Boolean(cached?.rows.length);
    const t = window.setTimeout(() => {
      void loadUniverseRef.current({ silent, cacheKey: key });
    }, 280);
    return () => {
      window.clearTimeout(t);
    };
  }, [view, universeKey]);

  useEffect(() => {
    if (view !== "track") return;
    if (skipPinsReload.current) {
      skipPinsReload.current = false;
      return;
    }
    void loadTrack(pins);
  }, [view, pins, loadTrack]);

  const addStocks = useCallback(
    (raw: string) => {
      const tickers = parseTrackTickers(raw);
      if (!tickers.length) {
        setAddMsg("Enter tickers separated by space or comma");
        return;
      }
      setView("track");
      setAddMsg(null);

      const nextPins = [
        ...tickers,
        ...pins.filter((t) => !tickers.includes(t)),
      ].slice(0, 200);
      skipPinsReload.current = true;
      setPins(nextPins);
      saveTrackPins(nextPins);
      setAddTicker("");
      setAddMsg(
        tickers.length === 1
          ? `Tracking ${tickers[0]} — updating…`
          : `Tracking ${tickers.length} stocks — updating in background…`,
      );
      setLoading(false);

      // Show whatever we already have for these pins, then refresh in background.
      void loadTrack(nextPins, { soft: true });

      setBgUpdating(true);
      void (async () => {
        try {
          await fetch("/api/strategy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: KIND,
              tickers,
              limit: tickers.length,
              missingOnly: false,
              refreshRecent: true,
            }),
          });
        } catch {
          /* still try to load cached rows */
        }
        await loadTrack(nextPins, { soft: true });
        setBgUpdating(false);
        setAddMsg(
          tickers.length === 1
            ? `Tracking ${tickers[0]}`
            : `Tracking ${tickers.length} stocks`,
        );
      })();
    },
    [loadTrack, pins],
  );

  const removeStock = useCallback(
    (ticker: string) => {
      const t = ticker.toUpperCase();
      const nextPins = pins.filter((x) => x !== t);
      setPins(nextPins);
      saveTrackPins(nextPins);
      setRows((cur) => cur.filter((r) => r.ticker.toUpperCase() !== t));
      setAddMsg(`Removed ${t}`);
    },
    [pins],
  );

  const shown = useMemo(() => {
    let list = [...rows];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const blob =
          `${r.ticker} ${r.name || ""} ${r.sector || ""}`.toLowerCase();
        return blob.includes(q);
      });
    }
    if (view === "track") {
      const pinSet = new Set(pins);
      const byTicker = new Map<string, StrategyConcallDriftRowData>();
      for (const r of list) {
        const t = r.ticker.toUpperCase();
        if (!pinSet.has(t)) continue;
        const prev = byTicker.get(t);
        if (!prev || eventTs(r) > eventTs(prev)) byTicker.set(t, r);
      }
      return [...byTicker.values()].sort((a, b) => eventTs(b) - eventTs(a));
    }
    if (view === "latest") {
      list.sort((a, b) => eventTs(b) - eventTs(a));
    } else if (view === "gainers") {
      list = list.filter(
        (r) => r.drift_pct != null && Number.isFinite(r.drift_pct) && r.drift_pct > 0,
      );
      list.sort(
        (a, b) =>
          (b.drift_pct ?? -Infinity) - (a.drift_pct ?? -Infinity) ||
          eventTs(b) - eventTs(a),
      );
    } else if (view === "losers") {
      list = list.filter(
        (r) => r.drift_pct != null && Number.isFinite(r.drift_pct) && r.drift_pct < 0,
      );
      list.sort(
        (a, b) =>
          (a.drift_pct ?? Infinity) - (b.drift_pct ?? Infinity) ||
          eventTs(b) - eventTs(a),
      );
    }
    return list;
  }, [rows, view, pins, search]);

  const missingPins = useMemo(() => {
    if (!isTrack) return [];
    const have = new Set(rows.map((r) => r.ticker.toUpperCase()));
    return pins.filter((t) => !have.has(t));
  }, [isTrack, pins, rows]);

  /** Blank % because LTP is older than the call — Update prices. */
  const stalePriceTickers = useMemo(() => {
    return [
      ...new Set(
        shown.filter(isStaleDriftRow).map((r) => r.ticker.toUpperCase()),
      ),
    ];
  }, [shown]);

  /** Blank % waiting on the next NSE session (flat vs call-day close). */
  const pendingSessionCount = useMemo(() => {
    return shown.filter(isPendingDriftRow).length;
  }, [shown]);

  const needsPriceFix = stalePriceTickers.length;

  const updatePrices = useCallback(
    async (opts?: { tickers?: string[]; forceAllShown?: boolean }) => {
      setAddMsg(null);
      const stale = opts?.tickers?.length
        ? [...new Set(opts.tickers.map((t) => t.toUpperCase()))]
        : stalePriceTickers;
      const allShown = [
        ...new Set(shown.map((r) => r.ticker.toUpperCase())),
      ];
      const targets = stale.length
        ? stale
        : opts?.forceAllShown
          ? isTrack
            ? pins.slice(0, 80)
            : allShown
          : isTrack
            ? pins.slice(0, 80)
            : allShown;
      if (!targets.length) {
        setAddMsg(
          pendingSessionCount
            ? `% since unlocks after the next trading session (${pendingSessionCount} waiting)`
            : "Nothing to update",
        );
        return;
      }

      const gen = ++loadGen.current;
      setRefreshingPrices(true);
      setPriceProgress({ done: 0, total: targets.length });

      try {
        for (let i = 0; i < targets.length; i += PRICE_CHUNK) {
          if (gen !== loadGen.current) return;
          const chunk = targets.slice(i, i + PRICE_CHUNK);
          const chunkSet = new Set(chunk);
          const params = new URLSearchParams({
            kind: KIND,
            market: "All",
            cap: "All",
            sort: "all",
            lite: "1",
            refresh: "1",
            limit: String(Math.min(80, chunk.length)),
            tickers: chunk.join(","),
          });
          if (!isTrack) params.set("window", "last30");
          applyMcapParams(params);
          const res = await fetch(`/api/strategy?${params}`);
          if (gen !== loadGen.current) return;
          const json = await parseFetchJson<ApiResponse>(res);
          if (!res.ok || json.error) {
            throw new Error(json.error || `Price update failed (${res.status})`);
          }
          if (gen !== loadGen.current) return;
          // Patch in place — never drop a name if this chunk response is sparse.
          const byTicker = new Map<string, StrategyConcallDriftRowData>();
          for (const r of json.rows || []) {
            const t = r.ticker.toUpperCase();
            if (!chunkSet.has(t)) continue;
            const prev = byTicker.get(t);
            if (!prev || eventTs(r) > eventTs(prev)) byTicker.set(t, r);
          }
          if (byTicker.size) {
            setRows((cur) => {
              const patched = cur.map((r) => {
                const next = byTicker.get(r.ticker.toUpperCase());
                return next ?? r;
              });
              const cache = universeCache.current;
              if (cache && cache.key === universeKey) {
                universeCache.current = {
                  ...cache,
                  rows: cache.rows.map((r) => {
                    const next = byTicker.get(r.ticker.toUpperCase());
                    return next ?? r;
                  }),
                };
              }
              return patched;
            });
          }
          setPriceProgress({
            done: Math.min(targets.length, i + chunk.length),
            total: targets.length,
          });
        }
        if (gen === loadGen.current) {
          setAddMsg(
            stale.length
              ? `Updated ${targets.length} live price${targets.length === 1 ? "" : "s"} — % since recalculated`
              : "Live prices updated — % since recalculated",
          );
        }
      } catch (err) {
        if (gen === loadGen.current) {
          setAddMsg(
            err instanceof Error &&
              /abort|timeout/i.test(`${err.name} ${err.message}`)
              ? "Price update timed out — try again"
              : "Price update failed — try again",
          );
        }
      } finally {
        // Always clear — a view switch bumps loadGen and would otherwise leave
        // the bar stuck on "Updating…".
        setRefreshingPrices(false);
        setPriceProgress(null);
      }
    },
    [
      applyMcapParams,
      isTrack,
      pendingSessionCount,
      pins,
      shown,
      stalePriceTickers,
      universeKey,
    ],
  );

  const scanLatest = useCallback(async () => {
    if (scanning || refreshingPrices) return;
    setAddMsg(null);
    setLoadError(null);
    const cancel = { cancelled: false };
    scanCancel.current = cancel;
    setScanning(true);
    setScanProgress({ label: "Scanning latest filings…", pct: 4 });

    let leftover: string[] | undefined;
    let round = 0;
    let savedTotal = 0;
    let failTotal = 0;
    let universe = 0;

    try {
      for (;;) {
        if (cancel.cancelled) break;
        round += 1;
        const res = await fetch("/api/strategy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: KIND,
            market: "All",
            limit: SCAN_BATCH,
            concurrency: 6,
            missingOnly: false,
            announced: leftover == null,
            announcedDays: SCAN_ANNOUNCED_DAYS,
            tickers: leftover,
          }),
        });
        const json = await parseFetchJson<ScanApiResponse>(res);
        if (!res.ok || json.error) {
          throw new Error(json.error || `Scan failed (${res.status})`);
        }
        if (cancel.cancelled) break;

        savedTotal += json.saved ?? 0;
        failTotal += json.failed ?? 0;
        if (leftover == null && json.announced != null) {
          universe = json.announced;
        }
        leftover = json.remaining_tickers?.length
          ? json.remaining_tickers
          : undefined;
        const remaining = json.remaining ?? leftover?.length ?? 0;
        const scanned = universe
          ? Math.max(0, universe - remaining)
          : round * SCAN_BATCH;
        const pct = universe
          ? Math.min(96, Math.round((100 * scanned) / universe))
          : Math.min(90, round * 4);
        setScanProgress({
          label: `Scan latest · +${savedTotal} ok${failTotal ? ` · ${failTotal} err` : ""} · ${remaining.toLocaleString()} left`,
          pct,
        });

        if ((json.tried ?? 0) === 0 || remaining <= 0 || round >= SCAN_MAX_ROUNDS) {
          break;
        }
      }

      if (cancel.cancelled) {
        setAddMsg("Scan stopped");
        return;
      }

      setScanProgress({ label: "Reloading board…", pct: 97 });
      // Invalidate cache so Scan forces a fresh board (still no price refresh unless stale).
      universeCache.current = null;
      const nextRows = await loadUniverse({ silent: true });
      const staleAfter = [
        ...new Set(
          nextRows.filter(isStaleDriftRow).map((r) => r.ticker.toUpperCase()),
        ),
      ];
      if (staleAfter.length) {
        setScanProgress({
          label: `Refreshing ${staleAfter.length} live prices…`,
          pct: 99,
        });
        await updatePrices({ tickers: staleAfter });
      }
      setAddMsg(
        savedTotal
          ? `Scan done · ${savedTotal} filings${failTotal ? ` · ${failTotal} failed` : ""}${staleAfter.length ? ` · ${staleAfter.length} prices` : ""}`
          : "Scan done · no new filings in lookback",
      );
    } catch (err) {
      const msg =
        err instanceof Error &&
        /abort|timeout/i.test(`${err.name} ${err.message}`)
          ? "Scan timed out — try again"
          : err instanceof Error
            ? err.message
            : "Scan failed";
      setAddMsg(msg);
    } finally {
      setScanning(false);
      setScanProgress(null);
      scanCancel.current = null;
    }
  }, [loadUniverse, refreshingPrices, scanning, updatePrices]);

  return (
    <div className="pcd panel strategy-panel concall-drift-lite">
      <header className="pcd-hero">
        <div className="pcd-hero-copy">
          <h1 className="pcd-title">
            Concall <em>Drift</em>
          </h1>
          <p className="pcd-sub">
            Last ~1 month of filings · % since call = LTP / call-day close − 1 ·
            Track to follow names
          </p>
        </div>
        <div className="pcd-hero-actions">
          <button
            type="button"
            className={`pcd-ghost-btn${scanning ? " on" : ""}`}
            disabled={loading || refreshingPrices || bgUpdating}
            title={
              scanning
                ? "Stop scan"
                : `Pull NSE earn/concall filings from the last ${SCAN_ANNOUNCED_DAYS} days, then refresh stale prices`
            }
            onClick={() => {
              if (scanning) {
                if (scanCancel.current) scanCancel.current.cancelled = true;
                return;
              }
              void scanLatest();
            }}
          >
            {scanning ? "Stop Scan" : "Scan Latest"}
          </button>
          <button
            type="button"
            className="pcd-ghost-btn concall-drift-fix-prices"
            disabled={
              loading ||
              refreshingPrices ||
              scanning ||
              bgUpdating ||
              (!shown.length && !needsPriceFix)
            }
            title={
              needsPriceFix
                ? `Refresh ${needsPriceFix} live LTPs (quote older than call) and recalculate % since`
                : "Pull live LTPs and recalculate % since"
            }
            onClick={() =>
              void updatePrices(
                needsPriceFix ? { tickers: stalePriceTickers } : { forceAllShown: true },
              )
            }
          >
            {refreshingPrices && priceProgress
              ? `Updating… ${priceProgress.done}/${priceProgress.total}`
              : refreshingPrices
                ? "Updating prices…"
                : needsPriceFix
                  ? `Update prices (${needsPriceFix})`
                  : "Update prices"}
          </button>
        </div>
      </header>

      <div className="pcd-chrome">
        <div className="pcd-toolbar concall-drift-lite-toolbar">
          <div className="pcd-sort" role="group" aria-label="Drift filter">
            <button
              type="button"
              className={view === "latest" ? "on" : ""}
              onClick={() => setView("latest")}
            >
              Latest
            </button>
            <button
              type="button"
              className={view === "gainers" ? "on" : ""}
              onClick={() => setView("gainers")}
            >
              ▲ Gainers
            </button>
            <button
              type="button"
              className={view === "losers" ? "on" : ""}
              onClick={() => setView("losers")}
            >
              ▼ Losers
            </button>
            <button
              type="button"
              className={view === "track" ? "on" : ""}
              onClick={() => setView("track")}
            >
              Track{pins.length ? ` (${pins.length})` : ""}
            </button>
          </div>

          <label className="pcd-search concall-drift-lite-search">
            <span className="pcd-sr">Search</span>
            <input
              type="search"
              value={search}
              placeholder="Search ticker or company…"
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          {!isTrack ? (
            <div className="pcd-mcap concall-drift-lite-mcap">
              <MarketCapRangeBar
                compact
                minIndex={mcapMinIndex}
                maxIndex={mcapMaxIndex}
                minCr={mcapBounds.minCr}
                maxCr={mcapBounds.maxCr}
                onChange={(lo, hi) => {
                  setMcapMinIndex(lo);
                  setMcapMaxIndex(hi);
                  setMcapExact(null);
                }}
                onCrChange={(minCr, maxCr) => {
                  setMcapExact({ minCr: minCr ?? 0, maxCr });
                  setMcapMinIndex(mcapCrToIndex(minCr ?? 0));
                  setMcapMaxIndex(mcapCrToIndex(maxCr));
                }}
                onClear={
                  mcapNarrowed
                    ? () => {
                        setMcapMinIndex(0);
                        setMcapMaxIndex(MCAP_DEFAULT_MAX);
                        setMcapExact(null);
                      }
                    : undefined
                }
              />
            </div>
          ) : (
            <form
              className="concall-drift-add"
              onSubmit={(e) => {
                e.preventDefault();
                addStocks(addTicker);
              }}
            >
              <input
                type="text"
                value={addTicker}
                onChange={(e) => setAddTicker(e.target.value)}
                placeholder="Tickers: AZAD SIGMAADV …"
                className="concall-drift-add-input"
                aria-label="Add tickers"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="submit"
                className="pcd-ghost-btn concall-drift-add-btn"
                disabled={!addTicker.trim()}
              >
                Add
              </button>
            </form>
          )}
        </div>

        <div className="pcd-meta-strip">
          {isTrack ? (
            <span>
              {pins.length
                ? `${pins.length} tracked`
                : "No stocks yet — paste one or many tickers"}
            </span>
          ) : (
            <span>
              {meta.total != null
                ? `${meta.total.toLocaleString()} shown`
                : "Events"}
              {meta.baseline != null
                ? ` · ${meta.baseline.toLocaleString()} with baseline`
                : ""}
            </span>
          )}
          {addMsg ? <span className="concall-drift-add-msg">{addMsg}</span> : null}
          {bgUpdating ? <span className="pcd-muted">Background update…</span> : null}
        </div>

        {scanning && scanProgress ? (
          <div
            className="concall-drift-price-banner is-progress"
            role="status"
            aria-live="polite"
          >
            <div className="concall-drift-price-progress fill-progress">
              <div className="fill-progress-meta">
                <span className="fill-progress-label">{scanProgress.label}</span>
                <span className="fill-progress-pct">
                  {Math.round(scanProgress.pct)}%
                </span>
              </div>
              <div className="fill-progress-track">
                <div
                  className="fill-progress-bar"
                  style={{
                    width: `${Math.min(100, Math.round(scanProgress.pct))}%`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : refreshingPrices && priceProgress ? (
          <div
            className="concall-drift-price-banner is-progress"
            role="status"
            aria-live="polite"
          >
            <div className="concall-drift-price-progress fill-progress">
              <div className="fill-progress-meta">
                <span className="fill-progress-label">
                  Updating prices… {priceProgress.done.toLocaleString()} /{" "}
                  {priceProgress.total.toLocaleString()}
                </span>
                <span className="fill-progress-pct">
                  {priceProgress.total
                    ? Math.round(
                        (100 * priceProgress.done) / priceProgress.total,
                      )
                    : 0}
                  %
                </span>
              </div>
              <div className="fill-progress-track">
                <div
                  className="fill-progress-bar"
                  style={{
                    width: `${
                      priceProgress.total
                        ? Math.min(
                            100,
                            Math.round(
                              (100 * priceProgress.done) / priceProgress.total,
                            ),
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : needsPriceFix > 0 ? (
          <div className="concall-drift-price-banner" role="status">
            <span>
              {needsPriceFix.toLocaleString()} name
              {needsPriceFix === 1 ? "" : "s"} need a live price for % since
              (quote older than the call).
            </span>
            <button
              type="button"
              className="pcd-ghost-btn"
              disabled={refreshingPrices || scanning || loading}
              onClick={() => void updatePrices({ tickers: stalePriceTickers })}
            >
              Update {needsPriceFix}
            </button>
          </div>
        ) : pendingSessionCount > 0 ? (
          <div className="concall-drift-price-banner" role="status">
            <span>
              {pendingSessionCount.toLocaleString()} name
              {pendingSessionCount === 1 ? "" : "s"} waiting on the next trading
              session for % since (call-day close locked in).
            </span>
          </div>
        ) : null}
      </div>

      {loading && !rows.length ? (
        <div className="pcd-loading" aria-live="polite">
          Loading…
        </div>
      ) : null}

      {loadError ? <div className="pcd-empty is-error">{loadError}</div> : null}

      {isTrack && missingPins.length ? (
        <div className="pcd-meta-strip">
          <span className="pcd-muted">
            Waiting on filings: {missingPins.join(", ")}
          </span>
          {missingPins.map((t) => (
            <button
              key={t}
              type="button"
              className="pcd-ghost-btn"
              onClick={() => removeStock(t)}
            >
              Remove {t}
            </button>
          ))}
        </div>
      ) : null}

      {!loading && !loadError && shown.length === 0 ? (
        <div className="pcd-empty">
          {view === "track"
            ? pins.length
              ? bgUpdating
                ? "Fetching tracked filings…"
                : "Tracked names have no concall event yet."
              : "Paste tickers above (space or comma separated)."
            : search.trim()
              ? "No matching stock in the last ~1 month."
              : view === "gainers"
                ? "No gainers in this mcap range yet."
                : view === "losers"
                  ? "No losers in this mcap range yet."
                  : "No filings yet — wait for result announcements."}
        </div>
      ) : null}

      {shown.length > 0 ? (
        <div className="pcd-table-wrap">
          <table className="pcd-table">
            <colgroup>
              <col className="pcd-col-ticker" />
              <col className="pcd-col-co" />
              <col className="pcd-col-sec" />
              <col className="pcd-col-mcap" />
              <col className="pcd-col-ltp" />
              <col className="pcd-col-earn" />
              <col className="pcd-col-drift" />
              {isTrack ? <col className="pcd-col-track-rm" /> : null}
            </colgroup>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Company</th>
                <th>Sec</th>
                <th className="num">MCap</th>
                <th className="num">LTP</th>
                <th title="Conference call / earn event time">Concall</th>
                <th
                  className="pcd-th-drift num"
                  title="% up/down since that date — LTP vs close on the call / filing day"
                >
                  % since
                </th>
                {isTrack ? <th className="num" /> : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const key = `${r.market}:${r.ticker}:${r.earn_at}`;
                return (
                  <StrategyConcallDriftRow
                    key={key}
                    row={r}
                    open={false}
                    panel="about"
                    dateField="concall"
                    compactMeta
                    showSinceHint
                    onToggle={() => {}}
                    onPanel={() => {}}
                    onRemove={
                      isTrack ? () => removeStock(r.ticker) : undefined
                    }
                  />
                );
              })}
            </tbody>
          </table>
          <footer className="pcd-foot">
            <span>
              {isTrack
                ? `${shown.length.toLocaleString()} tracked with events`
                : `${shown.length.toLocaleString()} stocks shown`}
            </span>
            <span>Tap a ticker → TradingView</span>
          </footer>
        </div>
      ) : null}
    </div>
  );
}

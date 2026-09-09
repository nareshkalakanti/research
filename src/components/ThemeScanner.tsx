"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CapFilter,
} from "@/components/CapMarketFilters";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import { RefreshButton } from "@/components/RefreshButton";
import { WatchlistFilterBar, FundsFilterBar } from "@/components/WatchlistFilterBar";
import { SavedSearchesBar } from "@/components/SavedSearchesBar";
import { ThemeTokenBar } from "@/components/ThemeTokenBar";
import type { Company } from "@/lib/types";
import type { SavedSearchRow } from "@/lib/saved-searches";
import {
  appendFundParams,
  FUND_WATCHLIST_KEYS,
  type FundCountState,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";

const EMPTY_FUNDS = Object.fromEntries(
  FUND_WATCHLIST_KEYS.map((k) => [k, false]),
) as FundFilterState;

type ScanProgress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

type ScanApi = {
  rows: Company[];
  total: number;
  page: number;
  pages: number;
  scanPattern: string | null;
  markets: Record<string, number>;
  sectors?: string[];
  sub_sectors?: string[];
  gaps?: {
    missingPrice?: number;
    missingMcap?: number;
    any?: number;
    metrics?: number;
  };
  signals?: Record<string, number>;
  llm?: {
    intent: string;
    include?: string[];
    engine: "llm" | "corpus";
    detail: string;
    judged: number;
    retrieved: number;
  };
};

export function ThemeScanner() {
  const [markets, setMarkets] = useState<Record<string, number>>({});
  const [custom, setCustom] = useState("");
  const [debouncedCustom, setDebouncedCustom] = useState("");
  const [draft, setDraft] = useState("");
  const [ask, setAsk] = useState("");
  const [tokens, setTokens] = useState<string[]>([]);
  const [llmTokens, setLlmTokens] = useState<string[]>([]);
  const [tokenOverride, setTokenOverride] = useState<string[] | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [activeSavedId, setActiveSavedId] = useState<number | null>(null);
  const [market, setMarket] = useState("All");
  const [cap, setCap] = useState<CapFilter>("All");
  const [filterHold, setFilterHold] = useState(false);
  const [filterEdge, setFilterEdge] = useState(false);
  const [fundFilters, setFundFilters] = useState<FundFilterState>(EMPTY_FUNDS);
  const setFund = useCallback((key: FundWatchlistKey, on: boolean) => {
    setFundFilters((prev) => ({ ...prev, [key]: on }));
  }, []);
  const [filterSme, setFilterSme] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [sector, setSector] = useState("All");
  const [subSector, setSubSector] = useState("All");
  const [mode, setMode] = useState<"AND" | "OR">("OR");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("sector");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<ScanApi | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const hasDataRef = useRef(false);
  const loadSeqRef = useRef(0);
  const llmKeyRef = useRef("");
  const hydrateKeyRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const progressTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  hasDataRef.current = !!data;

  const clearProgressTimers = useCallback(() => {
    if (progressTickRef.current) {
      clearInterval(progressTickRef.current);
      progressTickRef.current = null;
    }
    if (progressHideRef.current) {
      clearTimeout(progressHideRef.current);
      progressHideRef.current = null;
    }
  }, []);

  const startLlmProgress = useCallback(() => {
    clearProgressTimers();
    const t0 = Date.now();
    setProgress({
      pct: 6,
      label: "Expanding search",
      detail: "Reading your query…",
    });
    progressTickRef.current = setInterval(() => {
      const ms = Date.now() - t0;
      if (ms < 4500) {
        setProgress({
          pct: Math.round(6 + (ms / 4500) * 24),
          label: "Expanding search",
          detail: "Product terms and listed names…",
        });
        return;
      }
      if (ms < 16000) {
        setProgress({
          pct: Math.round(30 + ((ms - 4500) / 11500) * 34),
          label: "Scanning corpus",
          detail: "Stocks database and website scrapes…",
        });
        return;
      }
      const tail = 1 - Math.exp(-(ms - 16000) / 20000);
      setProgress({
        pct: Math.min(92, Math.round(64 + tail * 26)),
        label: ms > 50000 ? "Still ranking" : "Ranking matches",
        detail:
          ms > 50000
            ? "Taking longer than usual — cancel and pick a theme instead"
            : "Keeping companies that actually match…",
      });
      if (ms > 140000) {
        abortRef.current?.abort();
      }
    }, 180);
  }, [clearProgressTimers]);

  const finishLlmProgress = useCallback(
    (opts: { error?: string; total?: number }) => {
      clearProgressTimers();
      if (opts.error) {
        setProgress({
          pct: 100,
          label: "Search failed",
          detail: opts.error.slice(0, 90),
          error: true,
          done: true,
        });
        progressHideRef.current = setTimeout(() => setProgress(null), 1800);
        return;
      }
      setProgress({
        pct: 100,
        label: "Done",
        detail:
          opts.total != null
            ? `${opts.total.toLocaleString()} companies`
            : "",
        done: true,
      });
      progressHideRef.current = setTimeout(() => setProgress(null), 450);
    },
    [clearProgressTimers],
  );

  useEffect(() => () => clearProgressTimers(), [clearProgressTimers]);

  const [signalCounts, setSignalCounts] = useState<Record<string, number>>({
    hold: 0,
    distress: 0,
    edge: 0,
    sme: 0,
    note: 0,
    NC: 0,
    TI: 0,
    MIC: 0,
    SC: 0,
    MC: 0,
    LC: 0,
    ...Object.fromEntries(FUND_WATCHLIST_KEYS.map((k) => [k, 0])),
  });

  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/companies?market=${encodeURIComponent(market)}&pageSize=1`,
    )
      .then(async (r) => {
        const raw = await r.text();
        if (cancelled || !raw.trim() || !r.ok) return null;
        try {
          return JSON.parse(raw) as {
            markets: Record<string, number>;
            signals?: {
              hold?: number;
              distress?: number;
              edge?: number;
              sme?: number;
              note?: number;
            } & Record<string, number>;
          };
        } catch {
          return null;
        }
      })
      .then((j) => {
        if (cancelled || !j) return;
        setMarkets(j.markets ?? {});
        if (j.signals) {
          setSignalCounts({
            hold: j.signals.hold ?? 0,
            distress: j.signals.distress ?? 0,
            edge: j.signals.edge ?? 0,
            sme: j.signals.sme ?? 0,
            note: j.signals.note ?? 0,
            NC: j.signals.NC ?? 0,
            TI: j.signals.TI ?? 0,
            MIC: j.signals.MIC ?? 0,
            SC: j.signals.SC ?? 0,
            MC: j.signals.MC ?? 0,
            LC: j.signals.LC ?? 0,
            ...Object.fromEntries(
              FUND_WATCHLIST_KEYS.map((k) => [k, j.signals?.[k] ?? 0]),
            ),
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[ThemeScanner] market counts load failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [market]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(draft), 250);
    return () => clearTimeout(t);
  }, [draft]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedCustom(custom), 300);
    return () => clearTimeout(t);
  }, [custom]);

  useEffect(() => {
    setPage(1);
  }, [ask, debouncedCustom, market, cap, sector, subSector, mode, debouncedQ, filterHold, filterEdge, fundFilters, filterSme, filterNote]);

  const themeActive = debouncedCustom.trim().length > 0 && !ask.trim();
  const askActive = ask.trim().length > 0;
  const listMarket = market;
  const keywordQ = !askActive && !themeActive ? debouncedQ.trim() : "";

  useEffect(() => {
    if (!askActive) return;
    const sameAsLlm =
      tokens.length === llmTokens.length &&
      tokens.every(
        (t, i) => t.toLowerCase() === (llmTokens[i] ?? "").toLowerCase(),
      );
    if (sameAsLlm && !tokenOverride?.length) return;
    const applied = tokenOverride ?? [];
    const sameAsApplied =
      applied.length === tokens.length &&
      applied.every(
        (t, i) => t.toLowerCase() === (tokens[i] ?? "").toLowerCase(),
      );
    if (sameAsApplied) return;
    const timer = setTimeout(() => {
      setTokenOverride(tokens.length ? tokens : null);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [askActive, tokens, llmTokens, tokenOverride]);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const seq = ++loadSeqRef.current;
      const llmKey = askActive
        ? `${ask.trim().toLowerCase()}|${listMarket}|${cap}|${searchNonce}|${(tokenOverride ?? []).join("|")}`
        : "";
      const tuneOnly = Boolean(tokenOverride?.length);
      const runBar =
        askActive &&
        !tuneOnly &&
        (Boolean(opts?.refresh) || llmKey !== llmKeyRef.current);
      if (runBar) {
        llmKeyRef.current = llmKey;
        setLoading(true);
        startLlmProgress();
      } else {
        if (progressTickRef.current) {
          clearProgressTimers();
          setProgress(null);
        }
        setLoading(true);
      }
      const params = new URLSearchParams({
        market: listMarket,
        cap,
        page: String(page),
        pageSize: "100",
        sort,
        dir,
        mode,
        sector,
        sub_sector: subSector,
      });
      if (themeActive) {
        params.set("scan", "1");
        if (debouncedCustom.trim()) params.set("custom", debouncedCustom.trim());
      } else if (askActive) {
        params.set("scan", "1");
        params.set("ask", ask.trim());
        if (tokenOverride?.length) {
          params.set("tokens", tokenOverride.join("|"));
        }
      } else if (keywordQ) {
        params.set("q", keywordQ);
      }
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      appendFundParams(params, fundFilters);
      if (filterSme) params.set("sme", "1");
      if (filterNote) params.set("note", "1");
      if (opts?.refresh) params.set("refresh", "1");
      setLoadError(null);
      const timeout = setTimeout(() => ac.abort(), askActive ? 140_000 : 45_000);
      try {
        let res: Response;
        try {
          res = await fetch(`/api/companies?${params}`, { signal: ac.signal });
        } catch (err) {
          if (ac.signal.aborted && seq !== loadSeqRef.current) return;
          if (ac.signal.aborted) {
            throw new Error(
              askActive
                ? "Search timed out — pick a theme from the dropdown instead"
                : "Request timed out",
            );
          }
          throw err instanceof Error
            ? err
            : new Error("Network error — is the dev server running?");
        }
        const raw = await res.text();
        if (!raw.trim()) {
          throw new Error(`Empty response (${res.status})`);
        }
        let json: ScanApi;
        try {
          json = JSON.parse(raw) as ScanApi;
        } catch {
          throw new Error(
            res.status >= 500
              ? `Server error (${res.status}) — retry; a fetch may still be running`
              : `Invalid JSON (${res.status})`,
          );
        }
        if (!res.ok) {
          const msg =
            typeof (json as { error?: unknown }).error === "string"
              ? (json as { error: string }).error
              : `Request failed (${res.status})`;
          throw new Error(msg);
        }
        if (seq !== loadSeqRef.current) return;
        setData(json);
        if (runBar || progressTickRef.current) {
          finishLlmProgress({ total: json.total });
        }
        if (json.llm?.include && !tokenOverride?.length) {
          const hydrateKey = `${ask.trim().toLowerCase()}|${searchNonce}`;
          if (hydrateKeyRef.current !== hydrateKey) {
            hydrateKeyRef.current = hydrateKey;
            const next = uniqueTokenList(json.llm.include).slice(0, 18);
            setLlmTokens(next);
            setTokens((cur) =>
              uniqueTokenList(cur.length ? [...cur, ...next] : next).slice(0, 24),
            );
          }
        }
        if (json.markets) setMarkets(json.markets);
        if (json.signals) {
          setSignalCounts({
            hold: json.signals.hold ?? 0,
            distress: json.signals.distress ?? 0,
            edge: json.signals.edge ?? 0,
            sme: json.signals.sme ?? 0,
            note: json.signals.note ?? 0,
            NC: json.signals.NC ?? 0,
            TI: json.signals.TI ?? 0,
            MIC: json.signals.MIC ?? 0,
            SC: json.signals.SC ?? 0,
            MC: json.signals.MC ?? 0,
            LC: json.signals.LC ?? 0,
            ...Object.fromEntries(
              FUND_WATCHLIST_KEYS.map((k) => [k, json.signals?.[k] ?? 0]),
            ),
          });
        }
      } catch (e) {
        if (seq !== loadSeqRef.current) return;
        const msg = e instanceof Error ? e.message : "Load failed";
        setLoadError(msg);
        if (runBar || progressTickRef.current) finishLlmProgress({ error: msg });
      } finally {
        clearTimeout(timeout);
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [
      askActive,
      themeActive,
      ask,
      debouncedCustom,
      keywordQ,
      listMarket,
      cap,
      sector,
      subSector,
      mode,
      filterHold,
      filterEdge,
      fundFilters,
      filterSme,
            filterNote,
      page,
      sort,
      dir,
      searchNonce,
      tokenOverride,
      startLlmProgress,
      finishLlmProgress,
      clearProgressTimers,
    ],
  );

  const loadRef = useRef(load);
  loadRef.current = load;
  const softReload = useCallback(() => {
    void loadRef.current();
  }, []);
  const hardReload = useCallback(() => {
    void loadRef.current({ refresh: true });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function submitAsk(next?: string) {
    const q = (next ?? (custom || draft)).trim();
    if (!q) return;
    setActiveSavedId(null);
    setAsk(q);
    setTokenOverride(null);
    setSearchNonce((n) => n + 1);
    setPage(1);
  }

  function onSort(key: SortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(
        key === "price" || key === "mcap_cr" || key === "momentum_pct"
          ? "desc"
          : "asc",
      );
    }
  }

  const start = data ? (data.page - 1) * 100 + 1 : 0;
  const end = data ? Math.min(data.page * 100, data.total) : 0;
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);

  return (
    <div className="panel">
      <div className="scanner-hero">
        <div>
          <h2>Theme</h2>
          <p>
            Type keywords to filter the list, or Ask model to search About,
            scrapes, and the stock database.
          </p>
        </div>
        <div className="scanner-hero-right scanner-hero-actions">
          <RefreshButton
            busy={loading}
            onRefresh={async () => {
              await fetch("/api/companies?market=All&pageSize=10&refresh=1")
                .then((r) => r.json())
                .then((j: { markets?: Record<string, number> }) => {
                  if (j.markets) setMarkets(j.markets);
                });
              await hardReload();
            }}
          />
        </div>
      </div>

      <div className="scanner-controls scanner-controls--compact scanner-controls--ask">
        <div className="scanner-col">
          <label className="field-label" htmlFor="custom-kw">
            Keywords
          </label>
          <form
            className="search-bar search-bar--ask"
            onSubmit={(e) => {
              e.preventDefault();
              submitAsk(custom || draft);
            }}
          >
            <span className="search-icon" aria-hidden>
              ⌕
            </span>
            <input
              id="custom-kw"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                setDraft(e.target.value);
                setActiveSavedId(null);
              }}
              placeholder="acsr | copper | transformer oil"
              autoComplete="off"
            />
            {custom ? (
              <button
                type="button"
                className="theme-search-clear"
                onClick={() => {
                  setCustom("");
                  setDraft("");
                  setAsk("");
                  setTokens([]);
                  setLlmTokens([]);
                  setTokenOverride(null);
                  setActiveSavedId(null);
                  llmKeyRef.current = "";
                  setProgress(null);
                  clearProgressTimers();
                }}
                aria-label="Clear keywords"
              >
                ×
              </button>
            ) : null}
            <button
              type="submit"
              className="btn-scan-theme"
              disabled={loading && askActive}
              title="Ask the model to find matching listed companies"
            >
              {loading && askActive ? "Searching…" : "Ask model"}
            </button>
          </form>
          <p className="hint tight">
            Pipe = OR · + = AND inside a clause. Ask model searches the stock
            database and can time out.
          </p>
          <div className="search-meta">
            <div className="mode-toggle">
              <button
                type="button"
                className={mode === "AND" ? "on" : undefined}
                onClick={() => setMode("AND")}
              >
                AND
              </button>
              <span>|</span>
              <button
                type="button"
                className={mode === "OR" ? "on" : undefined}
                onClick={() => setMode("OR")}
              >
                OR
              </button>
            </div>
          </div>
          <SavedSearchesBar
            scope="theme"
            pattern={custom || ask || draft}
            activeId={activeSavedId}
            onApply={(s: SavedSearchRow) => {
              setActiveSavedId(s.id);
              setCustom(s.pattern);
              setDraft(s.pattern);
              setAsk("");
              abortRef.current?.abort();
              clearProgressTimers();
              setProgress(null);
            }}
          />
        </div>
        <label className="field">
          <span>List</span>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value)}
          >
            <option value="All">All ({allCount.toLocaleString() || "…"})</option>
            <option value="NSE">NSE ({nseCount.toLocaleString() || "…"})</option>
            <option value="NSE SME">
              NSE SME ({smeCount.toLocaleString() || "…"})
            </option>
            <option value="BSE SME">
              BSE SME ({bseSmeCount.toLocaleString() || "…"})
            </option>
          </select>
        </label>
      </div>

      {progress ? (
        <div
          className={`theme-ask-progress ${progress.error ? "is-error" : ""} ${progress.done ? "is-done" : ""}`}
        >
          <div
            className={`filter-progress ${progress.error ? "is-error" : ""} ${progress.done ? "is-done" : ""}`}
          >
            <div className="filter-progress-track">
              <div
                className="filter-progress-fill"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
            <span className="filter-progress-text">
              <strong>{progress.label}</strong>
              {progress.detail ? ` · ${progress.detail}` : null}
            </span>
            <span className="theme-ask-progress-pct">{progress.pct}%</span>
            {!progress.done ? (
              <button
                type="button"
                className="theme-ask-cancel"
                onClick={() => {
                  abortRef.current?.abort();
                  clearProgressTimers();
                  setAsk("");
                  setLoading(false);
                  setProgress({
                    pct: 100,
                    label: "Cancelled",
                    detail: "Try keywords, or Ask model again",
                    error: true,
                    done: true,
                  });
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {askActive ? (
        <ThemeTokenBar
          intent={data?.llm?.intent}
          tokens={tokens}
          original={llmTokens}
          engine={tokenOverride?.length ? "corpus" : data?.llm?.engine}
          detail={data?.llm?.detail}
          busy={loading}
          onChange={setTokens}
          onApply={() => {
            setTokenOverride(tokens.length ? tokens : null);
            setPage(1);
          }}
          onReset={() => {
            setTokens(llmTokens);
            setTokenOverride(null);
            setSearchNonce((n) => n + 1);
            setPage(1);
          }}
        />
      ) : data?.scanPattern ? (
        <div className="pattern-preview">
          <span>Scanning</span>
          <code>{data.scanPattern}</code>
        </div>
      ) : null}

      <div className="scan-filter-stack theme-filter-stack">
        <div className="scan-filter-row">
          <span className="scan-filter-label">Lists</span>
          <WatchlistFilterBar
            cap={cap}
            onCap={setCap}
            sme={filterSme}
            note={filterNote}
            onSme={setFilterSme}
            onNote={setFilterNote}
            smeCount={data?.signals?.sme ?? signalCounts.sme}
            noteCount={data?.signals?.note ?? signalCounts.note}
            allCount={
              data?.total ??
              Object.values(markets).reduce((a, b) => a + b, 0)
            }
            capCounts={{
              NC: data?.signals?.NC ?? signalCounts.NC,
              TI: data?.signals?.TI ?? signalCounts.TI,
              MIC: data?.signals?.MIC ?? signalCounts.MIC,
              SC: data?.signals?.SC ?? signalCounts.SC,
              MC: data?.signals?.MC ?? signalCounts.MC,
              LC: data?.signals?.LC ?? signalCounts.LC,
            }}
          />
        </div>
        <div className="scan-filter-row">
          <span className="scan-filter-label">Funds</span>
          <FundsFilterBar
            hold={filterHold}
            edge={filterEdge}
            onHold={setFilterHold}
            onEdge={setFilterEdge}
            holdCount={data?.signals?.hold ?? signalCounts.hold}
            distressCount={data?.signals?.distress ?? signalCounts.distress}
            edgeCount={data?.signals?.edge ?? signalCounts.edge}
            funds={fundFilters}
            onFund={setFund}
            fundCounts={
              Object.fromEntries(
                FUND_WATCHLIST_KEYS.map((k) => [
                  k,
                  data?.signals?.[k] ?? signalCounts[k] ?? 0,
                ]),
              ) as FundCountState
            }
          />
        </div>
      </div>

      {loadError && !progress ? (
        <div className="empty-state theme-load-error">{loadError}</div>
      ) : null}
      {loading && !data && !progress ? <div className="loading">Loading…</div> : null}
      <CompanyTable
        rows={data?.rows ?? []}
        sort={sort}
        dir={dir}
        onSort={onSort}
        showMatched={askActive || themeActive || Boolean(keywordQ)}
        capFilter={cap}
        onNoteChange={softReload}
        onScrapeDone={softReload}
        toolbar={
          <>
            <label className="field sector-field sector-field--table">
              <span>Sector</span>
              <select value={sector} onChange={(e) => setSector(e.target.value)}>
                <option value="All">All sectors</option>
                {(data?.sectors ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="field sector-field sector-field--table">
              <span>Sub-sector</span>
              <select value={subSector} onChange={(e) => setSubSector(e.target.value)}>
                <option value="All">All sub-sectors</option>
                {(data?.sub_sectors ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <div className="pager">
              <span>
                {data
                  ? `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} · ${market}`
                  : loading
                    ? "…"
                    : "—"}
              </span>
              {data ? (
                <div className="pager-btns">
                  <button
                    type="button"
                    disabled={data.page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    ‹
                  </button>
                  <span>
                    {data.page}/{data.pages}
                  </span>
                  <button
                    type="button"
                    disabled={data.page >= data.pages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    ›
                  </button>
                </div>
              ) : null}
            </div>
          </>
        }
      />
    </div>
  );
}

function uniqueTokenList(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const s = raw.trim().replace(/\s+/g, " ");
    if (s.length < 2) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CompanyTable, type SortKey } from "@/components/CompanyTable";
import {
  MarketCapRangeBar,
  MCAP_RANGE_STEPS,
  mcapIndicesToBounds,
} from "@/components/MarketCapRangeBar";
import {
  TickerSuggest,
  type TickerSuggestHit,
} from "@/components/TickerSuggest";
import { isFundChangeVisible } from "@/lib/fund-watchlist-meta";
import type { Company } from "@/lib/types";

type FundList = {
  key: string;
  label: string;
  count: number;
  builtin: boolean;
};

type Holding = {
  ticker: string;
  name: string;
  market: string;
  change_type: string | null;
  change_qtr: number | null;
};

type CrossView = "all" | "hold" | "unique" | "overlap" | "sme";

type View =
  | { kind: "fund"; key: string }
  | { kind: CrossView };

export function FundPanel() {
  const [lists, setLists] = useState<FundList[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [rows, setRows] = useState<Company[]>([]);
  const [holdingsMeta, setHoldingsMeta] = useState<Holding[]>([]);
  const [total, setTotal] = useState(0);
  const [crossCounts, setCrossCounts] = useState({
    all: 0,
    hold: 0,
    unique: 0,
    overlap: 0,
    sme: 0,
  });
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scanningSuperstar, setScanningSuperstar] = useState(false);
  const [scanProgress, setScanProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [mcapMinIndex, setMcapMinIndex] = useState(0);
  const [mcapMaxIndex, setMcapMaxIndex] = useState(
    MCAP_RANGE_STEPS.length - 1,
  );

  const activeList = useMemo(() => {
    if (!view || view.kind !== "fund") return null;
    return lists.find((l) => l.key === view.key) ?? null;
  }, [lists, view]);

  const viewTitle = useMemo(() => {
    if (!view) return "Funds";
    if (view.kind === "fund") return activeList?.label || "Funds";
    if (view.kind === "all") return "All funds";
    if (view.kind === "hold") return "Holdings";
    if (view.kind === "unique") return "Unique";
    if (view.kind === "overlap") return "Overlap";
    return "SME";
  }, [view, activeList]);

  const mcapDefaultMax = MCAP_RANGE_STEPS.length - 1;
  const mcapNarrowed =
    mcapMinIndex > 0 || mcapMaxIndex < mcapDefaultMax;
  const filtersActive =
    (view != null && view.kind !== "all") || mcapNarrowed;

  const newCount = useMemo(
    () =>
      holdingsMeta.filter((h) => isFundChangeVisible(h.change_type)).length,
    [holdingsMeta],
  );

  const loadLists = useCallback(async () => {
    const res = await fetch("/api/fund-watchlists");
    const json = (await res.json()) as {
      ok?: boolean;
      lists?: FundList[];
      all?: number;
      hold?: number;
      unique?: number;
      overlap?: number;
      sme?: number;
    };
    if (!res.ok || json.ok === false) throw new Error("Failed to load funds");
    const next = json.lists ?? [];
    setLists(next);
    setCrossCounts({
      all: json.all ?? 0,
      hold: json.hold ?? 0,
      unique: json.unique ?? 0,
      overlap: json.overlap ?? 0,
      sme: json.sme ?? 0,
    });
    return next;
  }, []);

  const loadTable = useCallback(
    async (current: View, opts?: { refresh?: boolean }) => {
      const { minCr, maxCr } = mcapIndicesToBounds(
        mcapMinIndex,
        mcapMaxIndex,
      );
      const params = new URLSearchParams({
        market: "All",
        page: String(page),
        pageSize: "100",
        sort,
        dir,
      });
      if (opts?.refresh) params.set("refresh", "1");
      if (minCr != null && minCr > 0) params.set("mcapMin", String(minCr));
      if (maxCr != null) params.set("mcapMax", String(maxCr));

      if (current.kind === "fund") {
        const metaRes = await fetch(
          `/api/fund-watchlists?list=${encodeURIComponent(current.key)}`,
        );
        const metaJson = (await metaRes.json()) as {
          ok?: boolean;
          holdings?: Holding[];
          error?: string;
        };
        if (!metaRes.ok || metaJson.ok === false) {
          throw new Error(metaJson.error || "Failed to load holdings");
        }
        setHoldingsMeta(metaJson.holdings ?? []);
        params.set("fundList", current.key);
      } else if (current.kind === "hold") {
        setHoldingsMeta([]);
        params.set("hold", "1");
      } else {
        setHoldingsMeta([]);
        params.set("fundMode", current.kind);
      }

      const res = await fetch(`/api/companies?${params}`);
      if (!res.ok) throw new Error("Failed to load companies");
      const json = (await res.json()) as {
        rows?: Company[];
        total?: number;
        pages?: number;
      };
      setRows(json.rows ?? []);
      setTotal(json.total ?? 0);
      setPages(json.pages ?? 1);
    },
    [page, sort, dir, mcapMinIndex, mcapMaxIndex],
  );

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void loadLists()
      .then(() => {
        if (cancelled) return;
        setView((cur) => cur ?? { kind: "all" });
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadLists]);

  useEffect(() => {
    if (!view) {
      setRows([]);
      setHoldingsMeta([]);
      setTotal(0);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    void loadTable(view)
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, loadTable]);

  function selectFund(key: string) {
    setView({ kind: "fund", key });
    setSort("name");
    setDir("asc");
    setPage(1);
  }

  function selectCross(kind: CrossView) {
    setView({ kind });
    if (kind === "overlap") {
      setSort("fund_count");
      setDir("desc");
    } else {
      setSort("name");
      setDir("asc");
    }
    setPage(1);
  }

  function clearFilters() {
    setView({ kind: "all" });
    setMcapMinIndex(0);
    setMcapMaxIndex(mcapDefaultMax);
    setSort("name");
    setDir("asc");
    setPage(1);
  }

  function onSort(key: SortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(
        key === "price" || key === "mcap_cr" || key === "fund_count"
          ? "desc"
          : "asc",
      );
    }
    setPage(1);
  }

  async function addHit(hit: TickerSuggestHit) {
    if (!view || view.kind !== "fund") return;
    const listKey = view.key;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/fund-watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          list: listKey,
          ticker: hit.ticker,
          name: hit.name,
          market: hit.market,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        lists?: FundList[];
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || "Add failed");
      }
      if (json.lists) setLists(json.lists);
      else await loadLists();
      setQ("");
      setStatus(`Added ${hit.ticker}`);
      await loadTable({ kind: "fund", key: listKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeTicker(ticker: string) {
    if (!view || view.kind !== "fund") return;
    const listKey = view.key;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/fund-watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "remove",
          list: listKey,
          ticker,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        lists?: FundList[];
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || "Remove failed");
      }
      if (json.lists) setLists(json.lists);
      else await loadLists();
      setStatus(`Removed ${ticker}`);
      await loadTable({ kind: "fund", key: listKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  async function createFund() {
    const label = createName.trim();
    if (label.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/fund-watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", label }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        list?: FundList;
      };
      if (!res.ok || json.ok === false || !json.list) {
        throw new Error(json.error || "Create failed");
      }
      await loadLists();
      setView({ kind: "fund", key: json.list.key });
      setPage(1);
      setCreateOpen(false);
      setCreateName("");
      setStatus(`Created ${json.list.label}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteFund() {
    if (!activeList || activeList.builtin) return;
    const label = activeList.label;
    const key = activeList.key;
    const ok = window.confirm(
      `Delete fund “${label}”? This removes the list and all ${activeList.count} holdings.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/fund-watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-list", list: key }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        lists?: FundList[];
        all?: number;
        hold?: number;
        unique?: number;
        overlap?: number;
        sme?: number;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || "Delete failed");
      }
      if (json.lists) setLists(json.lists);
      else await loadLists();
      setCrossCounts({
        all: json.all ?? 0,
        hold: json.hold ?? crossCounts.hold,
        unique: json.unique ?? 0,
        overlap: json.overlap ?? 0,
        sme: json.sme ?? 0,
      });
      setView({ kind: "all" });
      setPage(1);
      setRows([]);
      setHoldingsMeta([]);
      setStatus(`Deleted ${label}`);
      await loadTable({ kind: "all" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!view) return;
    setRefreshing(true);
    setError(null);
    try {
      await loadLists();
      await loadTable(view, { refresh: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function runSuperstarScan() {
    setScanningSuperstar(true);
    setError(null);
    setStatus(null);
    setScanProgress("Trendlyne holdings · starting…");
    let offset = 0;
    let total = 0;
    let saved = 0;
    try {
      for (let round = 1; round <= 80; round += 1) {
        const res = await fetch("/api/superstars", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset,
            limit: 4,
            includeFunds: true,
          }),
          signal: AbortSignal.timeout(240_000),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          offset?: number;
          total?: number;
          done?: number;
          remaining?: number;
          holdings_saved?: number;
          batch?: Array<{ short?: string; name: string }>;
          error?: string;
        };
        if (!res.ok || json.ok === false) {
          throw new Error(json.error || "Superstar scan failed");
        }
        total = json.total ?? total;
        offset = json.done ?? offset + 4;
        saved += json.holdings_saved ?? 0;
        const remaining = json.remaining ?? Math.max(0, total - offset);
        const names = (json.batch ?? [])
          .map((b) => b.short || b.name)
          .slice(0, 3)
          .join(", ");
        setScanProgress(
          `+${saved} holdings · ${offset}/${total}${names ? ` · ${names}` : ""}`,
        );
        if (round === 1 || round % 2 === 0 || remaining <= 0) {
          await loadLists();
          if (view) await loadTable(view);
        }
        if (remaining <= 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      setStatus(`Superstar scan done · +${saved} holdings`);
      setScanProgress(null);
      await loadLists();
      if (view) await loadTable(view);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Superstar scan failed";
      setError(
        /failed to fetch|networkerror|load failed/i.test(msg)
          ? "Server disconnected — try Scan Superstar again"
          : /aborted|timeout|timed out/i.test(msg)
            ? "Timed out — click Scan Superstar again to continue"
            : msg,
      );
      setScanProgress(null);
    } finally {
      setScanningSuperstar(false);
    }
  }

  const canEditFund = view?.kind === "fund";
  const start = total ? (page - 1) * 100 + 1 : 0;
  const end = Math.min(page * 100, total);

  return (
    <div className="panel scan-panel fund-panel">
      <div className="toolbar">
        <div className="fund-toolbar-title">
          <span className="fund-panel-title">{viewTitle}</span>
          {canEditFund && newCount > 0 ? (
            <span className="fund-new-pill">{newCount} new</span>
          ) : null}
        </div>
        <div className="fund-panel-actions">
          <button
            type="button"
            className={`chip chip-scan tag-chip ${scanningSuperstar ? "busy on" : ""}`}
            disabled={busy || scanningSuperstar || refreshing}
            onClick={() => void runSuperstarScan()}
            title="Pull latest Trendlyne superstar holdings into fund watchlists"
          >
            {scanningSuperstar ? "…" : "Scan Superstar"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setCreateOpen((v) => !v)}
          >
            {createOpen ? "Cancel" : "+ Create fund"}
          </button>
          {activeList && !activeList.builtin ? (
            <button
              type="button"
              className="btn-ghost fund-delete-btn"
              disabled={busy || scanningSuperstar}
              onClick={() => void deleteFund()}
              title={`Delete custom fund “${activeList.label}”`}
            >
              Delete fund
            </button>
          ) : null}
        </div>
      </div>

      {createOpen ? (
        <form
          className="fund-create-row"
          onSubmit={(e) => {
            e.preventDefault();
            void createFund();
          }}
        >
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="Fund name"
            aria-label="New fund name"
            maxLength={80}
            disabled={busy}
          />
          <button
            type="submit"
            className="token-studio-apply"
            disabled={busy || createName.trim().length < 2}
          >
            Save
          </button>
        </form>
      ) : null}

      <div className="scan-filter-stack">
        <div className="scan-filter-row">
          <span className="scan-filter-label">Funds</span>
          <div className="filter-bar">
            <div className="filter-bar-main fund-chip-row">
              <button
                type="button"
                className={`chip tag-chip tag-fund-all ${
                  view?.kind === "all" ? "on" : ""
                }`}
                onClick={() => selectCross("all")}
                title="All distinct stocks across every fund"
              >
                All
                <span className="chip-count">{crossCounts.all}</span>
              </button>
              <button
                type="button"
                className={`chip tag-chip tag-hold ${
                  view?.kind === "hold" ? "on" : ""
                }`}
                onClick={() => selectCross("hold")}
                title="Your holdings"
              >
                Holdings
                <span className="chip-count">{crossCounts.hold}</span>
              </button>
              {lists.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  className={`chip tag-chip tag-${l.key} ${
                    view?.kind === "fund" && view.key === l.key ? "on" : ""
                  }`}
                  onClick={() => selectFund(l.key)}
                  title={l.label}
                >
                  {l.label}
                  <span className="chip-count">{l.count}</span>
                </button>
              ))}
              {filtersActive ? (
                <button
                  type="button"
                  className="clear-filter"
                  onClick={clearFilters}
                  title="Reset to All funds and clear market-cap filter"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="scan-filter-row">
          <span className="scan-filter-label">Across</span>
          <div className="filter-bar">
            <div className="filter-bar-main fund-chip-row">
              <button
                type="button"
                className={`chip tag-chip tag-fund-unique ${
                  view?.kind === "unique" ? "on" : ""
                }`}
                onClick={() => selectCross("unique")}
                title="Stocks in exactly one fund"
              >
                Unique
                <span className="chip-count">{crossCounts.unique}</span>
              </button>
              <button
                type="button"
                className={`chip tag-chip tag-fund-overlap ${
                  view?.kind === "overlap" ? "on" : ""
                }`}
                onClick={() => selectCross("overlap")}
                title="Stocks in multiple funds, highest overlap first"
              >
                Overlap
                <span className="chip-count">{crossCounts.overlap}</span>
              </button>
              <button
                type="button"
                className={`chip tag-chip tag-fund-sme ${
                  view?.kind === "sme" ? "on" : ""
                }`}
                onClick={() => selectCross("sme")}
                title="SME listings across all funds"
              >
                SME
                <span className="chip-count">{crossCounts.sme}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="scan-filter-row fund-mcap-row">
          <span className="scan-filter-label">Mcap</span>
          <MarketCapRangeBar
            minIndex={mcapMinIndex}
            maxIndex={mcapMaxIndex}
            onChange={(lo, hi) => {
              setMcapMinIndex(lo);
              setMcapMaxIndex(hi);
              setPage(1);
            }}
            onClear={
              mcapNarrowed
                ? () => {
                    setMcapMinIndex(0);
                    setMcapMaxIndex(mcapDefaultMax);
                    setPage(1);
                  }
                : undefined
            }
            onRefresh={() => void refresh()}
            refreshing={refreshing || busy || scanningSuperstar}
          />
        </div>

        {scanProgress ? (
          <p className="fund-status fund-scan-progress">{scanProgress}</p>
        ) : null}

        {canEditFund ? (
          <div className="scan-filter-row">
            <span className="scan-filter-label">Add</span>
            <div className="fund-add-row">
              <TickerSuggest
                value={q}
                onChange={setQ}
                onSelect={(hit) => void addHit(hit)}
                onSubmit={(ticker) =>
                  void addHit({ ticker, name: ticker, market: "NSE" })
                }
                disabled={busy || !canEditFund}
                placeholder="Search ticker or company…"
                className="fund-add-input"
              />
              <button
                type="button"
                className="token-studio-apply"
                disabled={busy || !canEditFund || !q.trim()}
                onClick={() => {
                  const t = q.trim().toUpperCase();
                  if (t) void addHit({ ticker: t, name: t, market: "NSE" });
                }}
              >
                + Add
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {error ? <p className="fund-error">{error}</p> : null}
      {status ? <p className="fund-status">{status}</p> : null}
      {busy && !rows.length ? <div className="loading">Loading…</div> : null}

      <CompanyTable
        rows={rows}
        sort={sort}
        dir={dir}
        onSort={onSort}
        signalMode={view?.kind === "overlap" ? "overlap" : null}
        allowDelete={canEditFund}
        onDeleteStock={
          canEditFund ? (ticker) => removeTicker(ticker) : undefined
        }
        deleteLabel="Remove"
        deleteTitle="Remove from this fund"
        deleteConfirm={(ticker) => `Remove ${ticker} from this fund?`}
        toolbar={
          <div className="pager">
            <span>
              {total
                ? `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}${
                    viewTitle ? ` · ${viewTitle}` : ""
                  }`
                : view
                  ? view.kind === "fund"
                    ? "No stocks yet — search and add above"
                    : "No matching stocks"
                  : "Select or create a fund"}
            </span>
            <div className="pager-btns">
              <button
                type="button"
                disabled={page <= 1 || busy}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹
              </button>
              <span>
                {pages ? `${Math.min(page, pages)}/${pages}` : "…"}
              </span>
              <button
                type="button"
                disabled={page >= pages || busy}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              >
                ›
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}

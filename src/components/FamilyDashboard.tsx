"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FamilyMapCards, type FamilyRow, FamilyAddProgress, type FamilyAddWork } from "@/components/FamilyMapCards";
import { FamilyDashSearch, type DashSuggestHit } from "@/components/FamilyDashSearch";
import {
  PeopleBoardCards,
  type PersonBoardRow,
} from "@/components/PeopleBoardCards";
import { CompanyNetworkTable } from "@/components/CompanyNetworkTable";
import { StockNetworkSearch } from "@/components/StockNetworkSearch";
import { OutsideCommonsTable } from "@/components/OutsideCommonsTable";
import { OutsideMissingDinTable } from "@/components/OutsideMissingDinTable";
import { ConnectedStocksTable } from "@/components/ConnectedStocksTable";
import { GroupRankTable } from "@/components/GroupRankTable";
import {
  TickerSuggest,
  type TickerSuggestHit,
} from "@/components/TickerSuggest";
import { useOptionalAppTab } from "@/lib/app-tab";
import {
  tradingviewUrl,
  governancePersonUrl,
  governanceCompanyUrl,
} from "@/lib/links";
import { GOV_MAP_CHANGED, notifyGovMapChanged } from "@/lib/gov-map-sync";

type DashView =
  | "groups"
  | "group-rank"
  | "holdings"
  | "people"
  | "stock"
  | "connected"
  | "network"
  | "outside"
  | "outside-din";

function stubCompany(
  ticker: string,
  name?: string | null,
  market?: string | null,
  mcap?: number | null,
): FamilyRow["companies"][number] {
  const t = ticker.trim().toUpperCase();
  return {
    ticker: t,
    name: (name || t).trim() || t,
    market: (market || "NSE").trim() || "NSE",
    cap_code: null,
    market_cap_cr: mcap ?? null,
    is_sme: Boolean(
      (market || "").toUpperCase().includes("SME") ||
        (market || "").toUpperCase().includes("EMERGE"),
    ),
    directors: 0,
    din_verified: 0,
  };
}

export function FamilyDashboard() {
  const tabState = useOptionalAppTab();
  const [rows, setRows] = useState<FamilyRow[]>([]);
  const [holdings, setHoldings] = useState<FamilyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [dashHits, setDashHits] = useState<DashSuggestHit[]>([]);
  const [dashHitLoading, setDashHitLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTickers, setNewTickers] = useState<Array<{ ticker: string; name: string }>>([]);
  const [newQ, setNewQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [addWork, setAddWork] = useState<FamilyAddWork | null>(null);
  const [dashView, setDashView] = useState<DashView>("groups");
  const [groupFilter, setGroupFilter] = useState("");
  const [holdingFilter, setHoldingFilter] = useState("");
  const [onlyMissingDin, setOnlyMissingDin] = useState(false);
  const [onlyUnconnected, setOnlyUnconnected] = useState(false);

  // Drop removed views (e.g. former "small") left in Fast Refresh state.
  useEffect(() => {
    const ok: DashView[] = [
      "groups",
      "group-rank",
      "holdings",
      "people",
      "stock",
      "connected",
      "network",
      "outside",
      "outside-din",
    ];
    if (!ok.includes(dashView)) setDashView("groups");
  }, [dashView]);
  const [stockFocus, setStockFocus] = useState<string | null>(null);
  const [people, setPeople] = useState<PersonBoardRow[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [refreshingBox, setRefreshingBox] = useState<string | null>(null);
  const [networkRefreshKey, setNetworkRefreshKey] = useState(0);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [holdPattern, setHoldPattern] = useState<{
    tickers: string[];
    lines: string[];
  } | null>(null);
  const hasGroups = useRef(false);
  const hasHoldings = useRef(false);
  /**
   * After DIN/group writes: mark stale so the next relevant view reloads.
   * Start false — cold load uses cache miss, not refresh=1 (closes the DB reader).
   */
  const groupsStale = useRef(false);
  const peopleStale = useRef(false);
  const holdingsStale = useRef(false);
  const networkStale = useRef(false);
  const loadGen = useRef(0);
  const mapChangeTimer = useRef<number | null>(null);

  const load = useCallback(
    async (opts?: { refresh?: boolean; soft?: boolean }) => {
      const hard = opts?.refresh === true;
      const soft = opts?.soft === true;
      const gen = ++loadGen.current;
      if (!hasGroups.current) setLoading(true);
      if (hard && !soft) setRefreshingBox((cur) => cur || "*");
      if (!soft) setError(null);
      try {
        const params = new URLSearchParams({
          view: "family",
          page: "1",
          pageSize: "5000",
        });
        // Writers already call invalidateGovernanceMapCache — avoid refresh=1
        // (closes the gov reader) racing a rebuild after delete/remove.
        if (hard && !soft) params.set("refresh", "1");
        const url = `/api/governance-map?${params}`;
        let res = await fetch(url, { cache: "no-store" });
        if (res.status === 503) {
          await new Promise((r) => setTimeout(r, 500));
          res = await fetch(url, { cache: "no-store" });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { rows?: FamilyRow[] };
        if (gen !== loadGen.current) return;
        const next = json.rows ?? [];
        hasGroups.current = next.length > 0;
        groupsStale.current = false;
        setRows(next);
      } catch (e) {
        if (gen !== loadGen.current) return;
        // Soft reconcile after delete: keep optimistic rows if rebuild is slow.
        if (soft && hasGroups.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === loadGen.current) {
          setLoading(false);
          setRefreshingBox(null);
        }
      }
    },
    [],
  );


  const loadHoldingMaps = useCallback(async (opts?: { refresh?: boolean }) => {
    const hard = opts?.refresh === true;
    if (!hasHoldings.current) setHoldingsLoading(true);
    if (hard) setRefreshingBox((cur) => cur || "*");
    setError(null);
    try {
      const params = new URLSearchParams({
        view: "holdings",
        page: "1",
        pageSize: "5000",
      });
      if (hard) params.set("refresh", "1");
      const res = await fetch(`/api/governance-map?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: FamilyRow[] };
      const next = json.rows ?? [];
      hasHoldings.current = next.length > 0;
      setHoldings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHoldingsLoading(false);
      setRefreshingBox(null);
    }
  }, []);

  const loadPeople = useCallback(async (opts?: { refresh?: boolean; q?: string }) => {
    setPeopleLoading(true);
    if (opts?.refresh) setRefreshingBox((cur) => cur || "*");
    setError(null);
    try {
      const collected: PersonBoardRow[] = [];
      const needle = (opts?.q || "").trim();
      const searching = needle.length >= 2;
      let page = 1;
      let pages = 1;
      const maxPages = searching ? 3 : 1;
      while (page <= pages && page <= maxPages) {
        const params = new URLSearchParams({
          view: "director",
          sort: searching ? "name" : "boards",
          minBoards: searching ? "1" : "2",
          page: String(page),
          pageSize: searching ? "40" : "40",
        });
        if (searching) {
          params.set("q", needle);
          params.set("hideCollision", "0");
        }
        if (opts?.refresh) params.set("refresh", "1");
        const res = await fetch(`/api/governance-map?${params}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          rows?: PersonBoardRow[];
          pages?: number;
        };
        collected.push(...(json.rows ?? []));
        pages = Math.max(1, json.pages ?? 1);
        page += 1;
      }
      const seen = new Set<string>();
      setPeople(
        collected.filter((r) => {
          if (seen.has(r.person_id)) return false;
          seen.add(r.person_id);
          return true;
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPeopleLoading(false);
      setRefreshingBox(null);
    }
  }, []);

  // One family-map fetch for Groups / Outside / Outside DIN / Group — no double mount.
  useEffect(() => {
    if (tabState?.tab && tabState.tab !== "dashboard") return;
    if (
      dashView !== "groups" &&
      dashView !== "outside" &&
      dashView !== "outside-din" &&
      dashView !== "group-rank"
    ) {
      return;
    }
    if (!groupsStale.current && hasGroups.current) return;
    // Hard refresh only when updating already-loaded stale data (writers invalidate).
    const hard = groupsStale.current && hasGroups.current;
    void load({ refresh: hard });
  }, [tabState?.tab, dashView, load]);

  useEffect(() => {
    const onChange = () => {
      groupsStale.current = true;
      peopleStale.current = true;
      holdingsStale.current = true;
      networkStale.current = true;
      if (mapChangeTimer.current != null) {
        window.clearTimeout(mapChangeTimer.current);
      }
      // Debounce: delete/remove already patched rows; wait for server invalidate.
      mapChangeTimer.current = window.setTimeout(() => {
        mapChangeTimer.current = null;
        // Soft fetch: cache already cleared by writer; avoid refresh=1 race.
        void load({ soft: true });
        if (dashView === "people") {
          peopleStale.current = false;
          const needle = q.trim();
          void loadPeople({
            q: needle.length >= 2 ? needle : undefined,
          });
        } else if (dashView === "holdings") {
          holdingsStale.current = false;
          void loadHoldingMaps();
        } else if (dashView === "network") {
          networkStale.current = false;
          setNetworkRefreshKey((k) => k + 1);
        }
      }, 350);
    };
    window.addEventListener(GOV_MAP_CHANGED, onChange);
    return () => {
      window.removeEventListener(GOV_MAP_CHANGED, onChange);
      if (mapChangeTimer.current != null) {
        window.clearTimeout(mapChangeTimer.current);
        mapChangeTimer.current = null;
      }
    };
  }, [dashView, q, load, loadPeople, loadHoldingMaps]);

  const addInFlight = Boolean(addWork && !addWork.done && !addWork.error);

  useEffect(() => {
    if (!addInFlight) return;
    const t = window.setInterval(() => {
      setAddWork((p) => {
        if (!p || p.done || p.error) return p;
        return { ...p, pct: Math.min(p.pct + 4, 86) };
      });
    }, 450);
    return () => window.clearInterval(t);
  }, [addInFlight]);

  useEffect(() => {
    if (!addWork?.done && !addWork?.error) return;
    const t = window.setTimeout(() => setAddWork(null), addWork.error ? 3200 : 1400);
    return () => window.clearTimeout(t);
  }, [addWork?.done, addWork?.error]);

  useEffect(() => {
    if (dashView !== "people") return;
    const needle = q.trim();
    const hard = peopleStale.current;
    if (needle.length < 2) {
      peopleStale.current = false;
      void loadPeople(hard ? { refresh: true } : undefined);
      return;
    }
    const t = window.setTimeout(() => {
      peopleStale.current = false;
      void loadPeople(hard ? { refresh: true, q: needle } : { q: needle });
    }, 220);
    return () => window.clearTimeout(t);
  }, [dashView, q, loadPeople]);

  useEffect(() => {
    if (dashView !== "holdings") return;
    if (hasHoldings.current && !holdingsStale.current) return;
    const hard = holdingsStale.current && hasHoldings.current;
    holdingsStale.current = false;
    void loadHoldingMaps(hard ? { refresh: true } : undefined);
  }, [dashView, loadHoldingMaps]);

  useEffect(() => {
    if (dashView !== "network") return;
    if (!networkStale.current) return;
    networkStale.current = false;
    setNetworkRefreshKey((k) => k + 1);
  }, [dashView]);

  useEffect(() => {
    void fetch("/api/holdings-pattern", { cache: "no-store" })
      .then((res) => res.json())
      .then((json: { tickers?: string[]; lines?: string[] }) => {
        setHoldPattern({
          tickers: (json.tickers ?? []).map((t) => t.toUpperCase()),
          lines: json.lines ?? [],
        });
      })
      .catch(() => {
        /* pattern is optional */
      });
  }, []);

  const marketByTicker = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of rows) for (const c of f.companies) map.set(c.ticker, c.market);
    for (const f of holdings) for (const c of f.companies) map.set(c.ticker, c.market);
    for (const p of people) for (const c of p.companies) map.set(c.ticker, c.market);
    return map;
  }, [rows, holdings, people]);

  const groupOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; label: string; n: number }> = [];
    for (const f of rows) {
      const key = f.group_id || f.family_name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: f.family_name, n: f.company_count });
    }
    out.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    return out;
  }, [rows]);


  const groupHasMissingDin = (f: FamilyRow) => {
    for (const c of f.companies) {
      const directors = c.directors ?? 0;
      const verified = c.din_verified ?? 0;
      if (directors === 0 || verified < directors) return true;
    }
    for (const p of f.people ?? []) {
      if (!p.din || !/^\d{8}$/.test(p.din.trim())) return true;
    }
    return false;
  };

  const groupHasUnconnected = (f: FamilyRow) => {
    const linked = new Set<string>();
    for (const p of f.people ?? []) {
      for (const t of [...p.tickers, ...(p.span_tickers ?? [])]) {
        const u = t.trim().toUpperCase();
        if (u) linked.add(u);
      }
    }
    return f.companies.some((c) => !linked.has(c.ticker.toUpperCase()));
  };

  const filtered = useMemo(() => {
    const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
    return rows.filter((f) => {
      if (groupFilter && (f.group_id || f.family_name) !== groupFilter) {
        return false;
      }
      if (onlyMissingDin && !groupHasMissingDin(f)) return false;
      if (onlyUnconnected && !groupHasUnconnected(f)) return false;
      if (!needle) return true;
      const tickerHit = (t: string) => {
        const sym = t.toLowerCase();
        return sym === needle || sym.startsWith(needle) || sym.includes(needle);
      };
      return (
        f.family_name.toLowerCase().includes(needle) ||
        f.companies.some(
          (c) => tickerHit(c.ticker) || c.name.toLowerCase().includes(needle),
        ) ||
        (f.people ?? []).some((p) => p.name.toLowerCase().includes(needle)) ||
        (f.outside ?? []).some(
          (o) => tickerHit(o.ticker) || o.name.toLowerCase().includes(needle),
        )
      );
    });
  }, [rows, q, groupFilter, onlyMissingDin, onlyUnconnected]);

  // Stale groupFilter (HMR / deleted group) → empty list while dropdown still says All.
  useEffect(() => {
    if (!groupFilter || !rows.length) return;
    const hit = rows.some(
      (f) => (f.group_id || f.family_name) === groupFilter,
    );
    if (!hit) setGroupFilter("");
  }, [rows, groupFilter]);

  const recentJoinCount = (f: FamilyRow) =>
    (f.people ?? []).filter((p) => p.recent_join).length;

  /** Largest houses first (Tata, Jindal, …); recent joins only break ties. */
  const withSizeFirst = (list: FamilyRow[]) =>
    [...list].sort((a, b) => {
      if (b.company_count !== a.company_count) {
        return b.company_count - a.company_count;
      }
      const bn = recentJoinCount(b);
      const an = recentJoinCount(a);
      if (bn !== an) return bn - an;
      return a.family_name.localeCompare(b.family_name, undefined, {
        sensitivity: "base",
      });
    });

  const filteredWithPattern = useMemo(() => {
    const set = new Set(holdPattern?.tickers ?? []);
    const text = (holdPattern?.lines ?? []).filter(Boolean).join(" · ");
    const mapped =
      !set.size || !text
        ? filtered
        : filtered.map((f) => {
            const n = f.companies.filter((c) =>
              set.has(c.ticker.toUpperCase()),
            ).length;
            const share = n / Math.max(1, f.company_count);
            if (n < 3 || share < 0.4) return f;
            return { ...f, pattern: text };
          });
    return withSizeFirst(mapped);
  }, [filtered, holdPattern]);




  const holdingOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; label: string; n: number }> = [];
    for (const f of holdings) {
      const key = f.group_id || f.family_name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        label: f.companies[0]?.ticker || f.family_name,
        n: f.outside?.length ?? 0,
      });
    }
    out.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    return out;
  }, [holdings]);

  const filteredHoldings = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = holdings.filter((f) => {
      if (holdingFilter && (f.group_id || f.family_name) !== holdingFilter) {
        return false;
      }
      if (!needle) return true;
      return (
        f.family_name.toLowerCase().includes(needle) ||
        f.companies.some(
          (c) =>
            c.ticker.toLowerCase().startsWith(needle) ||
            c.name.toLowerCase().includes(needle),
        ) ||
        (f.people ?? []).some((p) => p.name.toLowerCase().includes(needle)) ||
        (f.outside ?? []).some(
          (o) =>
            o.ticker.toLowerCase().startsWith(needle) ||
            o.name.toLowerCase().includes(needle),
        )
      );
    });
    return withSizeFirst(list);
  }, [holdings, q, holdingFilter]);

  const filteredPeople = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/[.,]+/g, " ").replace(/\s+/g, " ").trim();
    const dinQ = needle.replace(/\D/g, "");
    const list = !needle
      ? people
      : people.filter((p) => {
          const name = p.name
            .toLowerCase()
            .replace(/[.,]+/g, " ")
            .replace(/\s+/g, " ");
          return (
            name.includes(needle) ||
            (dinQ && (p.din || "").includes(dinQ)) ||
            p.companies.some(
              (c) =>
                c.ticker.toLowerCase().startsWith(needle) ||
                c.name.toLowerCase().includes(needle),
            )
          );
        });
    return [...list].sort((a, b) => {
      if (Boolean(b.recent_join) !== Boolean(a.recent_join)) {
        return a.recent_join ? -1 : 1;
      }
      return (b.board_count || 0) - (a.board_count || 0);
    });
  }, [people, q]);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 1) {
      setDashHits([]);
      setDashHitLoading(false);
      return;
    }
    const low = needle.toLowerCase();
    const local: DashSuggestHit[] = [];
    const seenG = new Set<string>();
    for (const f of rows) {
      const key = f.group_id || f.family_name;
      if (seenG.has(key)) continue;
      if (
        f.family_name.toLowerCase().includes(low) ||
        f.companies.some(
          (c) =>
            c.ticker.toLowerCase() === low ||
            c.ticker.toLowerCase().startsWith(low) ||
            c.ticker.toLowerCase().includes(low) ||
            c.name.toLowerCase().includes(low),
        ) ||
        (f.outside ?? []).some(
          (o) =>
            o.ticker.toLowerCase().includes(low) ||
            o.name.toLowerCase().includes(low),
        )
      ) {
        seenG.add(key);
        local.push({
          kind: "group",
          key,
          label: f.family_name,
          detail: `${f.company_count} companies`,
        });
      }
    }
    const seenP = new Set<string>();
    const personPool: Array<{ person_id: string; name: string; din: string | null }> = [
      ...people.map((p) => ({
        person_id: p.person_id,
        name: p.name,
        din: p.din ?? null,
      })),
      ...rows.flatMap((f) =>
        (f.people ?? []).map((p) => ({
          person_id: p.person_id,
          name: p.name,
          din: p.din,
        })),
      ),
    ];
    for (const p of personPool) {
      if (seenP.has(p.person_id)) continue;
      if (
        p.name.toLowerCase().replace(/[.,]+/g, " ").includes(low.replace(/[.,]+/g, " ").trim()) ||
        (p.din || "").includes(needle.replace(/\D/g, "") || needle)
      ) {
        seenP.add(p.person_id);
        local.push({
          kind: "person",
          person_id: p.person_id,
          label: p.name,
          detail: p.din ? `DIN ${p.din}` : "Director",
        });
      }
    }
    let cancelled = false;
    setDashHitLoading(true);
    const t = window.setTimeout(() => {
      void Promise.all([
        fetch(`/api/tickers?q=${encodeURIComponent(needle)}&limit=8`, {
          cache: "no-store",
        }).then(async (res) => {
          const json = (await res.json()) as {
            hits?: Array<{ ticker: string; name: string; market?: string }>;
          };
          return json.hits ?? [];
        }),
        fetch(
          `/api/governance-map?view=director&q=${encodeURIComponent(needle)}&minBoards=1&hideCollision=0&pageSize=8`,
          { cache: "no-store" },
        ).then(async (res) => {
          const json = (await res.json()) as {
            rows?: Array<{
              person_id: string;
              name: string;
              din: string | null;
              board_count?: number;
            }>;
          };
          return json.rows ?? [];
        }),
      ])
        .then(([tickerHits, directorHits]) => {
          if (cancelled) return;
          const tickers: DashSuggestHit[] = [];
          const haveT = new Set<string>();
          for (const h of tickerHits) {
            const ticker = (h.ticker || "").toUpperCase();
            if (!ticker || haveT.has(ticker)) continue;
            haveT.add(ticker);
            tickers.push({
              kind: "ticker",
              ticker,
              label: ticker,
              detail: h.name || ticker,
            });
          }
          const persons: DashSuggestHit[] = [];
          for (const r of directorHits) {
            if (!r.person_id || seenP.has(r.person_id)) continue;
            seenP.add(r.person_id);
            persons.push({
              kind: "person",
              person_id: r.person_id,
              label: r.name,
              detail: r.din
                ? `DIN ${r.din}${r.board_count ? ` · ${r.board_count} boards` : ""}`
                : "Director",
            });
          }
          setDashHits(
            [...local.slice(0, 6), ...persons.slice(0, 6), ...tickers].slice(0, 14),
          );
        })
        .catch(() => {
          if (!cancelled) setDashHits(local.slice(0, 14));
        })
        .finally(() => {
          if (!cancelled) setDashHitLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, rows.length, people.length]);

  const onDashPick = useCallback((hit: DashSuggestHit) => {
    const scrollKey = (key: string) => {
      window.setTimeout(() => {
        document
          .querySelector(`[data-fam-key="${CSS.escape(key)}"]`)
          ?.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 50);
    };
    if (hit.kind === "group") {
      setDashView("groups");
      setGroupFilter(hit.key);
      setQ("");
      scrollKey(hit.key);
      return;
    }
    if (hit.kind === "person") {
      setDashView("people");
      setQ(hit.label);
      return;
    }
    const ticker = hit.ticker.toUpperCase();
    if (dashView === "groups") {
      const group = rows.find((f) =>
        f.companies.some((c) => c.ticker.toUpperCase() === ticker),
      );
      if (group) {
        const key = group.group_id || group.family_name;
        setGroupFilter(key);
        setQ("");
        scrollKey(key);
        return;
      }
      setQ(ticker);
      return;
    }
    if (dashView === "holdings") {
      const hold = holdings.find((f) =>
        f.companies.some((c) => c.ticker.toUpperCase() === ticker),
      );
      if (hold) {
        setHoldingFilter(hold.group_id || hold.family_name);
        setQ("");
        return;
      }
      setQ(ticker);
      return;
    }
    setDashView("stock");
    setStockFocus(ticker);
    setQ("");
  }, [dashView, rows, holdings]);

  const addCreateTicker = (
    hit: TickerSuggestHit | { ticker: string; name: string },
  ) => {
    const t = hit.ticker.trim().toUpperCase();
    if (!t) return;
    setNewTickers((rows) =>
      rows.some((x) => x.ticker.toUpperCase() === t)
        ? rows
        : [...rows, { ticker: t, name: hit.name || t }],
    );
    setNewQ("");
  };

  const ensureUserGroup = useCallback(async (g: FamilyRow) => {
    if (g.group_id?.startsWith("user-")) return g.group_id;
    const res = await fetch("/api/family-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        create: true,
        label: g.family_name,
        tickers: g.companies.map((c) => c.ticker),
      }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      group_id?: string;
      error?: string;
    };
    if (!res.ok || !json.group_id) {
      throw new Error(json.error || `Save group failed (${res.status})`);
    }
    return json.group_id;
  }, []);

  const createGroup = async () => {
    const label = newName.replace(/\s+/g, " ").trim();
    if (label.length < 2 || creating) return;
    setCreating(true);
    setAddWork({
      pct: 12,
      label: "Saving group",
      detail: `${label}${newTickers.length ? ` · ${newTickers.length} companies` : ""}`,
    });
    try {
      const res = await fetch("/api/family-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          create: true,
          label,
          tickers: newTickers.map((t) => t.ticker),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { group_id?: string };
      const gid = json.group_id;
      if (gid) {
        setRows((prev) => [
          {
            family_name: label,
            company_count: newTickers.length,
            group_id: gid,
            companies: newTickers.map((t) => stubCompany(t.ticker, t.name)),
            people: [],
            outside: [],
          },
          ...prev.filter((g) => g.group_id !== gid),
        ]);
        hasGroups.current = true;
      }
      setAdding(false);
      setNewName("");
      setNewTickers([]);
      setNewQ("");
      setQ(label);
      setAddWork({
        pct: 100,
        label: "Done",
        detail: label,
        done: true,
      });
      notifyGovMapChanged();
      if (newTickers.length >= 2 && gid) {
        setGroupFilter(gid);
        setDashView("groups");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setAddWork({
        pct: 100,
        label: "Failed",
        detail: msg,
        error: true,
      });
    } finally {
      setCreating(false);
    }
  };

  const openPerson = (personId: string, _name: string) => {
    window.open(governancePersonUrl(personId), "_blank", "noopener,noreferrer");
  };

  const openCompany = (ticker: string) => {
    window.open(governanceCompanyUrl(ticker), "_blank", "noopener,noreferrer");
  };

  return (
    <section className="fam-dash">
      <div className="fam-dash-head">
        <div>
          <div className="fam-dash-tabs" role="tablist" aria-label="Dashboard">
            <button
              type="button"
              role="tab"
              className={dashView === "groups" ? "tab on" : "tab"}
              aria-selected={dashView === "groups"}
              onClick={() => setDashView("groups")}
            >
              Business groups
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "holdings" ? "tab on" : "tab"}
              aria-selected={dashView === "holdings"}
              onClick={() => setDashView("holdings")}
            >
              Holdings
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "people" ? "tab on" : "tab"}
              aria-selected={dashView === "people"}
              onClick={() => setDashView("people")}
            >
              People & boards
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "connected" ? "tab on" : "tab"}
              aria-selected={dashView === "connected"}
              onClick={() => setDashView("connected")}
            >
              Connected
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "stock" ? "tab on" : "tab"}
              aria-selected={dashView === "stock"}
              onClick={() => setDashView("stock")}
            >
              Board map
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "network" ? "tab on" : "tab"}
              aria-selected={dashView === "network"}
              onClick={() => setDashView("network")}
            >
              Network
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "outside" ? "tab on" : "tab"}
              aria-selected={dashView === "outside"}
              onClick={() => setDashView("outside")}
            >
              Outside
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "outside-din" ? "tab on" : "tab"}
              aria-selected={dashView === "outside-din"}
              onClick={() => setDashView("outside-din")}
            >
              Outside DIN
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "group-rank" ? "tab on" : "tab"}
              aria-selected={dashView === "group-rank"}
              onClick={() => setDashView("group-rank")}
            >
              Group
            </button>
          </div>
          <p className="fam-dash-sub">
            {dashView === "groups"
              ? "Largest groups first. Teal nodes mark recent board joins. Click a ticker for related boards; Outside filters to external seats."
              : dashView === "group-rank"
                ? "Group companies only (member listings). Same layout as Outside, with market-cap chips. Default house size Cos 3+."
              : dashView === "holdings"
                ? "Each card is a stock in your holdings. The graph is that listing plus directors and other listed boards they sit on."
              : dashView === "people"
                ? "Recent joins sort first (new badge / teal node). Name opens Governance; ticker shows that stock’s related boards."
                : dashView === "connected"
                  ? "Stocks ranked by shared-director links to other listed boards. Click a ticker → hub graph + dashed connected boards + bottom chips."
                : dashView === "network"
                  ? "Cap Gap and Holdings: board-linked market-cap gap columns. Counts are facts, not scores."
                  : dashView === "outside"
                    ? "Commons: tickers as Outside boards on other houses. “As outside in” = those houses (not own group). Click a ticker → Board map (graph + bottom chips)."
                    : dashView === "outside-din"
                      ? "Outside boards still missing DIN coverage (0 seats or verified < directors). Click a ticker → Board map."
                  : "Board map: search a stock → hub + connected boards (dashed = outside this listing). Bottom chips jump ticker-to-ticker. Not the house Outside filter."}
          </p>
        </div>
        <div className="fam-dash-actions">
          {dashView !== "stock" &&
          dashView !== "connected" &&
          dashView !== "network" &&
          dashView !== "outside" &&
          dashView !== "outside-din" &&
          dashView !== "group-rank" ? (
            <>
          {dashView === "groups" ? (
            <>
            <label className="fam-dash-group-filter">
              <select
                className="fam-dash-search fam-dash-group-select"
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                aria-label="Filter by business group"
              >
                <option value="">All groups ({groupOptions.length})</option>
                {groupOptions.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label} ({g.n})
                  </option>
                ))}
              </select>
            </label>
            <label className="fam-dash-check">
              <input
                type="checkbox"
                checked={onlyMissingDin}
                onChange={(e) => setOnlyMissingDin(e.target.checked)}
              />
              Missing DIN
            </label>
            <label className="fam-dash-check">
              <input
                type="checkbox"
                checked={onlyUnconnected}
                onChange={(e) => setOnlyUnconnected(e.target.checked)}
              />
              Unconnected
            </label>
            </>
          ) : null}
          {dashView === "holdings" ? (
            <label className="fam-dash-group-filter">
              <select
                className="fam-dash-search fam-dash-group-select"
                value={holdingFilter}
                onChange={(e) => setHoldingFilter(e.target.value)}
                aria-label="Filter by holding"
              >
                <option value="">All holdings ({holdingOptions.length})</option>
                {holdingOptions.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label} ({g.n})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <FamilyDashSearch
            value={q}
            onChange={setQ}
            placeholder={
              dashView === "people"
                ? "Person, DIN, ticker or company…"
                : dashView === "holdings"
                  ? "Ticker, company, director or outside board…"
                  : "Group, ticker, company or director…"
            }
            hits={dashHits}
            loading={dashHitLoading}
            onPick={onDashPick}
          />
          {dashView === "groups" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "Cancel" : "Add group"}
          </button>
          ) : null}
            </>
          ) : null}
          {dashView !== "stock" && dashView !== "connected" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              void (dashView === "network"
                ? setNetworkRefreshKey((k) => k + 1)
                : dashView === "people"
                  ? loadPeople({
                      refresh: true,
                      q: q.trim().length >= 2 ? q.trim() : undefined,
                    })
                  : dashView === "holdings"
                    ? loadHoldingMaps({ refresh: true })
                    : load({ refresh: true }))
            }
            disabled={
              dashView === "network"
                ? networkLoading
                : dashView === "people"
                  ? peopleLoading
                  : dashView === "holdings"
                    ? holdingsLoading
                    : loading
            }
          >
            {(dashView === "network"
              ? networkLoading
              : dashView === "people"
                ? peopleLoading
                : dashView === "holdings"
                  ? holdingsLoading
                  : loading)
              ? "Loading…"
              : "Refresh"}
          </button>
          ) : null}
        </div>
      </div>
      {dashView === "groups" ? (
        addWork ? (
          <FamilyAddProgress work={addWork} />
        ) : null
      ) : null}
      {dashView === "groups" && adding ? (
        <form
          className="fam-dash-create"
          onSubmit={(e) => {
            e.preventDefault();
            void createGroup();
          }}
        >
          <input
            className="fam-dash-search"
            placeholder="Group name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New group name"
          />
          <div className="fam-dash-create-cos">
            {newTickers.map((t) => (
              <span key={t.ticker} className="fam-dash-create-chip">
                <span className="mono">{t.ticker}</span>
                <button
                  type="button"
                  title={`Remove ${t.ticker}`}
                  onClick={() =>
                    setNewTickers((rows) => rows.filter((x) => x.ticker !== t.ticker))
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <div className="gov-family-add fam-dash-create-add">
              <TickerSuggest
                value={newQ}
                onChange={setNewQ}
                onSelect={addCreateTicker}
                onSubmit={(t) => addCreateTicker({ ticker: t, name: t })}
                clearOnSelect
                placeholder="Search ticker or company…"
                className="theme-stock-suggest-input"
                submitLabel="add"
              />
            </div>
          </div>
          <button
            type="submit"
            className="btn-ghost"
            disabled={creating || newName.trim().length < 2}
          >
            {creating ? "Saving…" : "Create group"}
          </button>
          {creating || (addWork && !addWork.groupId) ? (
            <FamilyAddProgress
              work={
                addWork && !addWork.groupId
                  ? addWork
                  : {
                      pct: 18,
                      label: "Saving group",
                      detail: newName.trim() || "New group",
                    }
              }
            />
          ) : null}
        </form>
      ) : null}
      {error &&
      dashView !== "stock" &&
      dashView !== "connected" &&
      dashView !== "network" &&
      dashView !== "outside" &&
      dashView !== "outside-din" &&
      dashView !== "group-rank" ? (
        <div className="table-meta">Could not load: {error}</div>
      ) : null}
      {dashView === "group-rank" ? (
        <GroupRankTable
          rows={rows}
          loading={loading}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          onTicker={(t) => {
            setStockFocus(t);
            setDashView("stock");
          }}
          onOpenGroup={(key) => {
            setGroupFilter(key);
            setDashView("groups");
          }}
        />
      ) : dashView === "connected" ? (
        <ConnectedStocksTable
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          onTicker={(t) => {
            setStockFocus(t);
            setDashView("stock");
          }}
        />
      ) : dashView === "outside" ? (
        <OutsideCommonsTable
          rows={rows}
          loading={loading}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          onTicker={(t) => {
            setStockFocus(t);
            setDashView("stock");
          }}
        />
      ) : dashView === "outside-din" ? (
        <OutsideMissingDinTable
          rows={rows}
          loading={loading}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          onTicker={(t) => {
            setStockFocus(t);
            setDashView("stock");
          }}
        />
      ) : dashView === "network" ? (
        <CompanyNetworkTable
          onPerson={(id, name) => openPerson(id, name)}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          onTargetTicker={(t) => {
            setStockFocus(t);
            setDashView("stock");
          }}
          refreshKey={networkRefreshKey}
          onLoadingChange={setNetworkLoading}
        />
      ) : dashView === "stock" ? (
        <StockNetworkSearch
          initialTicker={stockFocus}
          onPerson={(id, name) => openPerson(id, name)}
        />
      ) : dashView === "holdings" ? (
        holdingsLoading && !holdings.length ? (
          <div className="table-meta">Loading holdings graphs…</div>
        ) : (
          <FamilyMapCards
            rows={filteredHoldings}
            onPerson={(id, name) => openPerson(id, name)}
            chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
            onRefresh={(g) => {
              setRefreshingBox(g.group_id || g.family_name);
              void loadHoldingMaps({ refresh: true });
            }}
            refreshing={refreshingBox}
          />
        )
      ) : dashView === "people" ? (
        peopleLoading && !people.length ? (
          <div className="table-meta">Loading people and boards…</div>
        ) : (
          <PeopleBoardCards
            rows={filteredPeople}
            onTicker={(t) => openCompany(t)}
            onPerson={(id, name) => openPerson(id, name)}
            chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
            onRefresh={() => {
              const needle = q.trim();
              void loadPeople({
                refresh: true,
                q: needle.length >= 2 ? needle : undefined,
              });
            }}
            refreshingId={refreshingBox}
          />
        )
      ) : loading && !rows.length ? (
        <div className="table-meta">Loading business groups…</div>
      ) : rows.length > 0 && filteredWithPattern.length === 0 ? (
        <div className="table-meta">
          No groups match the current filters.{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setGroupFilter("");
              setOnlyMissingDin(false);
              setOnlyUnconnected(false);
              setQ("");
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <FamilyMapCards
          rows={filteredWithPattern}
          editable
          addWork={addWork}
          onPerson={(id, name) => openPerson(id, name)}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          onRefresh={(g) => {
            setRefreshingBox(g.group_id || g.family_name);
            void load({ refresh: true });
          }}
          refreshing={refreshingBox}
          onDeleteGroup={async (g) => {
            if (!g.group_id) return;
            const tickers = [
              ...new Set(
                [
                  ...g.companies.map((c) => c.ticker),
                  ...(g.listings ?? []).map((c) => c.ticker),
                ]
                  .map((t) => t.trim().toUpperCase())
                  .filter(Boolean),
              ),
            ];
            const res = await fetch("/api/family-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                group_id: g.group_id,
                deleteGroup: true,
                tickers,
              }),
            });
            const json = (await res.json().catch(() => null)) as {
              error?: string;
            } | null;
            if (!res.ok) {
              setError(json?.error || `Could not remove group (${res.status})`);
              return;
            }
            setRows((prev) => prev.filter((row) => row.group_id !== g.group_id));
            groupsStale.current = false;
            notifyGovMapChanged();
          }}
          onRename={async (g, label) => {
            if (!g.group_id) return;
            const res = await fetch("/api/family-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ group_id: g.group_id, rename: true, label }),
            });
            const json = (await res.json().catch(() => null)) as {
              error?: string;
            } | null;
            if (!res.ok) {
              setError(json?.error || `Could not rename (${res.status})`);
              return;
            }
            const name = label.replace(/\s+/g, " ").trim();
            setRows((prev) =>
              prev.map((row) =>
                row.group_id === g.group_id ? { ...row, family_name: name } : row,
              ),
            );
          }}
          onRemoveCompany={async (g, ticker) => {
            if (!g.group_id) return;
            const res = await fetch("/api/family-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                group_id: g.group_id,
                remove: true,
                ticker,
              }),
            });
            const json = (await res.json().catch(() => null)) as {
              error?: string;
            } | null;
            if (!res.ok) {
              setError(json?.error || `Could not remove company (${res.status})`);
              return;
            }
            const t = ticker.trim().toUpperCase();
            setRows((prev) =>
              prev.map((row) => {
                if (row.group_id !== g.group_id) return row;
                const companies = row.companies.filter(
                  (c) => c.ticker.toUpperCase() !== t,
                );
                return {
                  ...row,
                  companies,
                  company_count: companies.length,
                };
              }),
            );
            groupsStale.current = false;
            notifyGovMapChanged();
          }}
          onAddCompany={async (g, ticker, name) => {
            if (!g.group_id) return;
            const shown = ticker.trim().toUpperCase();
            setAddWork({
              groupId: g.group_id,
              pct: 8,
              label: "Listing",
              detail: `${shown} · exchange, quote, profile`,
            });
            try {
              const boot = await fetch("/api/tickers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ticker: shown,
                  name: name || shown,
                }),
              });
              const bootJson = (await boot.json()) as {
                ok?: boolean;
                error?: string;
                hit?: {
                  ticker: string;
                  name: string;
                  market: string;
                  mcap_cr: number | null;
                };
              };
              if (!boot.ok || bootJson.ok === false) {
                throw new Error(bootJson.error || `Add listing failed (${boot.status})`);
              }
              setAddWork({
                groupId: g.group_id,
                pct: 58,
                label: "Group",
                detail: `${shown} → ${g.family_name}`,
              });
              const fam = await fetch("/api/family-groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  group_id: g.group_id,
                  add: true,
                  ticker: shown,
                }),
              });
              if (!fam.ok) throw new Error(`Save group failed (${fam.status})`);
              const hit = bootJson.hit;
              const extra = stubCompany(
                hit?.ticker || shown,
                hit?.name || name || shown,
                hit?.market,
                hit?.mcap_cr,
              );
              setRows((prev) =>
                prev.map((row) => {
                  if (row.group_id !== g.group_id) {
                    return {
                      ...row,
                      companies: row.companies.filter(
                        (c) => c.ticker.toUpperCase() !== extra.ticker,
                      ),
                      company_count: row.companies.filter(
                        (c) => c.ticker.toUpperCase() !== extra.ticker,
                      ).length,
                    };
                  }
                  if (row.companies.some((c) => c.ticker === extra.ticker)) {
                    return row;
                  }
                  const companies = [...row.companies, extra];
                  return { ...row, companies, company_count: companies.length };
                }),
              );
              setAddWork({
                groupId: g.group_id,
                pct: 100,
                label: "Done",
                detail: `${shown} in ${g.family_name}`,
                done: true,
              });
              notifyGovMapChanged();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              setError(msg);
              setAddWork({
                groupId: g.group_id,
                pct: 100,
                label: "Failed",
                detail: msg,
                error: true,
              });
            }
          }}
        />
      )}
    </section>
  );
}

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
import { useOptionalAppTab } from "@/lib/app-tab";
import {
  tradingviewUrl,
  governancePersonUrl,
  governanceCompanyUrl,
} from "@/lib/links";
import { GOV_MAP_CHANGED, notifyGovMapChanged } from "@/lib/gov-map-sync";

type DashView =
  | "groups"
  | "ungrouped"
  | "sme"
  | "holdings"
  | "people"
  | "stock"
  | "network";

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
  const [solos, setSolos] = useState<FamilyRow[]>([]);
  const [smeRows, setSmeRows] = useState<FamilyRow[]>([]);
  const [holdings, setHoldings] = useState<FamilyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [solosLoading, setSolosLoading] = useState(false);
  const [smeLoading, setSmeLoading] = useState(false);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [dashHits, setDashHits] = useState<DashSuggestHit[]>([]);
  const [dashHitLoading, setDashHitLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTickers, setNewTickers] = useState<Array<{ ticker: string; name: string }>>([]);
  const [newQ, setNewQ] = useState("");
  const [newHits, setNewHits] = useState<Array<{ ticker: string; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [addWork, setAddWork] = useState<FamilyAddWork | null>(null);
  const [dashView, setDashView] = useState<DashView>("groups");
  const [groupFilter, setGroupFilter] = useState("");
  const [soloFilter, setSoloFilter] = useState("");
  const [smeFilter, setSmeFilter] = useState("");
  const [holdingFilter, setHoldingFilter] = useState("");
  const [stockFocus, setStockFocus] = useState<string | null>(null);
  const [people, setPeople] = useState<PersonBoardRow[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [refreshingBox, setRefreshingBox] = useState<string | null>(null);
  const [holdPattern, setHoldPattern] = useState<{
    tickers: string[];
    lines: string[];
  } | null>(null);
  const hasGroups = useRef(false);
  const hasSolos = useRef(false);
  const hasSme = useRef(false);
  const hasHoldings = useRef(false);

  const load = useCallback(async (opts?: { refresh?: boolean }) => {
    const hard = opts?.refresh === true;
    if (!hasGroups.current) setLoading(true);
    if (hard) setRefreshingBox((cur) => cur || "*");
    setError(null);
    try {
      const params = new URLSearchParams({
        view: "family",
        page: "1",
        pageSize: "5000",
      });
      if (hard) params.set("refresh", "1");
      const url = `/api/governance-map?${params}`;
      let res = await fetch(url, { cache: "no-store" });
      if (res.status === 503) {
        await new Promise((r) => setTimeout(r, 500));
        res = await fetch(url, { cache: "no-store" });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: FamilyRow[] };
      const next = json.rows ?? [];
      hasGroups.current = next.length > 0;
      setRows(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshingBox(null);
    }
  }, []);

  const loadSolos = useCallback(async (opts?: { refresh?: boolean }) => {
    const hard = opts?.refresh === true;
    if (!hasSolos.current) setSolosLoading(true);
    if (hard) setRefreshingBox((cur) => cur || "*");
    setError(null);
    try {
      const params = new URLSearchParams({
        view: "ungrouped",
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
      hasSolos.current = next.length > 0;
      setSolos(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSolosLoading(false);
      setRefreshingBox(null);
    }
  }, []);

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

  const loadSmeMaps = useCallback(async (opts?: { refresh?: boolean }) => {
    const hard = opts?.refresh === true;
    if (!hasSme.current) setSmeLoading(true);
    if (hard) setRefreshingBox((cur) => cur || "*");
    setError(null);
    try {
      const params = new URLSearchParams({
        view: "sme",
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
      hasSme.current = next.length > 0;
      setSmeRows(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSmeLoading(false);
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

  useEffect(() => {
    if (tabState?.tab && tabState.tab !== "dashboard") return;
    if (hasGroups.current) return;
    void load();
  }, [tabState?.tab, load]);

  useEffect(() => {
    const onChange = () => {
      if (dashView === "people") {
        const needle = q.trim();
        void loadPeople({
          refresh: true,
          q: needle.length >= 2 ? needle : undefined,
        });
      }
      else if (dashView === "ungrouped") void loadSolos({ refresh: true });
      else if (dashView === "sme") void loadSmeMaps({ refresh: true });
      else if (dashView === "holdings") void loadHoldingMaps({ refresh: true });
      else if (dashView === "groups") void load({ refresh: true });
    };
    window.addEventListener(GOV_MAP_CHANGED, onChange);
    return () => window.removeEventListener(GOV_MAP_CHANGED, onChange);
  }, [dashView, q, load, loadPeople, loadSolos, loadSmeMaps, loadHoldingMaps]);

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
    if (needle.length < 2) {
      void loadPeople();
      return;
    }
    const t = window.setTimeout(() => {
      void loadPeople({ q: needle });
    }, 220);
    return () => window.clearTimeout(t);
  }, [dashView, q, loadPeople]);

  useEffect(() => {
    if (dashView === "ungrouped") void loadSolos();
  }, [dashView, loadSolos]);

  useEffect(() => {
    if (dashView === "sme") void loadSmeMaps();
  }, [dashView, loadSmeMaps]);

  useEffect(() => {
    if (dashView === "holdings") void loadHoldingMaps();
  }, [dashView, loadHoldingMaps]);

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
    for (const f of solos) for (const c of f.companies) map.set(c.ticker, c.market);
    for (const f of smeRows) for (const c of f.companies) map.set(c.ticker, c.market);
    for (const f of holdings) for (const c of f.companies) map.set(c.ticker, c.market);
    for (const p of people) for (const c of p.companies) map.set(c.ticker, c.market);
    return map;
  }, [rows, solos, smeRows, holdings, people]);

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

  const soloOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; label: string; n: number }> = [];
    for (const f of solos) {
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
  }, [solos]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((f) => {
      if (groupFilter && (f.group_id || f.family_name) !== groupFilter) {
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
        (f.people ?? []).some((p) => p.name.toLowerCase().includes(needle))
      );
    });
  }, [rows, q, groupFilter]);

  const filteredWithPattern = useMemo(() => {
    const set = new Set(holdPattern?.tickers ?? []);
    const text = (holdPattern?.lines ?? []).filter(Boolean).join(" · ");
    if (!set.size || !text) return filtered;
    return filtered.map((f) => {
      const n = f.companies.filter((c) => set.has(c.ticker.toUpperCase())).length;
      const share = n / Math.max(1, f.company_count);
      if (n < 3 || share < 0.4) return f;
      return { ...f, pattern: text };
    });
  }, [filtered, holdPattern]);

  const filteredSolos = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return solos.filter((f) => {
      if (soloFilter && (f.group_id || f.family_name) !== soloFilter) {
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
  }, [solos, q, soloFilter]);

  const smeOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; label: string; n: number }> = [];
    for (const f of smeRows) {
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
  }, [smeRows]);

  const filteredSme = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return smeRows.filter((f) => {
      if (smeFilter && (f.group_id || f.family_name) !== smeFilter) {
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
  }, [smeRows, q, smeFilter]);

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
    return holdings.filter((f) => {
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
  }, [holdings, q, holdingFilter]);

  const filteredPeople = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/[.,]+/g, " ").replace(/\s+/g, " ").trim();
    if (!needle) return people;
    const dinQ = needle.replace(/\D/g, "");
    return people.filter((p) => {
      const name = p.name.toLowerCase().replace(/[.,]+/g, " ").replace(/\s+/g, " ");
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
            c.ticker.toLowerCase().startsWith(low) ||
            c.name.toLowerCase().includes(low),
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
    for (const f of solos) {
      const key = f.group_id || f.family_name;
      if (seenG.has(key)) continue;
      const t = f.companies[0]?.ticker || "";
      if (
        f.family_name.toLowerCase().includes(low) ||
        f.companies.some(
          (c) =>
            c.ticker.toLowerCase().startsWith(low) ||
            c.name.toLowerCase().includes(low),
        )
      ) {
        seenG.add(key);
        local.push({
          kind: "group",
          key,
          label: t || f.family_name,
          detail: "Ungrouped",
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
  }, [q, rows.length, solos.length, people.length]);

  const onDashPick = useCallback((hit: DashSuggestHit) => {
    const scrollKey = (key: string) => {
      window.setTimeout(() => {
        document
          .querySelector(`[data-fam-key="${CSS.escape(key)}"]`)
          ?.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 50);
    };
    if (hit.kind === "group") {
      const solo = solos.some(
        (f) => (f.group_id || f.family_name) === hit.key,
      );
      if (solo) {
        setDashView("ungrouped");
        setSoloFilter(hit.key);
        setQ("");
        scrollKey(hit.key);
        return;
      }
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
    if (dashView === "ungrouped") {
      const solo = solos.find((f) =>
        f.companies.some((c) => c.ticker.toUpperCase() === ticker),
      );
      if (solo) {
        setSoloFilter(solo.group_id || solo.family_name);
        setQ("");
        scrollKey(solo.group_id || solo.family_name);
        return;
      }
      setQ(ticker);
      setAdding(true);
      setNewTickers((prev) =>
        prev.some((x) => x.ticker.toUpperCase() === ticker)
          ? prev
          : [...prev, { ticker, name: hit.detail || ticker }],
      );
      setNewName((cur) => (cur.trim() ? cur : (hit.detail || ticker).trim()));
      return;
    }
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
    if (dashView === "sme") {
      const sme = smeRows.find((f) =>
        f.companies.some((c) => c.ticker.toUpperCase() === ticker),
      );
      if (sme) {
        setSmeFilter(sme.group_id || sme.family_name);
        setQ("");
        scrollKey(sme.group_id || sme.family_name);
        return;
      }
      setQ(ticker);
      return;
    }
    setDashView("stock");
    setStockFocus(ticker);
    setQ("");
  }, [dashView, solos, rows, holdings, smeRows]);

  const companySearch = useCallback(async (query: string) => {
    const res = await fetch(
      `/api/tickers?q=${encodeURIComponent(query)}&limit=14`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      hits?: Array<{ ticker: string; name: string }>;
    };
    return (json.hits ?? []).map((h) => ({ ticker: h.ticker, name: h.name }));
  }, []);

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

  useEffect(() => {
    const needle = newQ.trim();
    if (!adding || needle.length < 2) {
      setNewHits([]);
      return;
    }
    const skip = new Set(newTickers.map((t) => t.ticker.toUpperCase()));
    const t = window.setTimeout(() => {
      void companySearch(needle).then((rows) => {
        setNewHits(rows.filter((r) => !skip.has(r.ticker.toUpperCase())).slice(0, 8));
      });
    }, 200);
    return () => window.clearTimeout(t);
  }, [adding, newQ, newTickers, companySearch]);

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
      void loadSolos({ refresh: true });
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
              className={dashView === "ungrouped" ? "tab on" : "tab"}
              aria-selected={dashView === "ungrouped"}
              onClick={() => setDashView("ungrouped")}
            >
              Ungrouped
            </button>
            <button
              type="button"
              role="tab"
              className={dashView === "sme" ? "tab on" : "tab"}
              aria-selected={dashView === "sme"}
              onClick={() => setDashView("sme")}
            >
              SME
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
              className={dashView === "stock" ? "tab on" : "tab"}
              aria-selected={dashView === "stock"}
              onClick={() => setDashView("stock")}
            >
              Stock
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
          </div>
          <p className="fam-dash-sub">
            {dashView === "groups"
              ? "Click a ticker for that stock’s full board and related nodes. Outside shows only external boards and those people. Show all restores the group."
              : dashView === "ungrouped"
                ? "One listed company that is not in a business group, plus other listed boards its directors sit on (outside). Houses stay 2+ companies."
              : dashView === "sme"
                ? "NSE SME / BSE SME listings that have board seats, plus other listed boards those directors sit on. BSE SME without boards stays out of this graph view."
              : dashView === "holdings"
                ? "Each card is a stock in your holdings. The graph is that listing plus directors and other listed boards they sit on."
              : dashView === "people"
                ? "Each card is a person and the listed boards they sit on. Name opens Governance; ticker shows that stock’s related boards."
                : dashView === "network"
                  ? "Cap Gap and Holdings: board-linked market-cap gap columns. Counts are facts, not scores."
                  : "Search a stock. The graph is its directors plus every other listed company those directors sit on. Names open TradingView."}
          </p>
        </div>
        <div className="fam-dash-actions">
          {dashView !== "stock" && dashView !== "network" ? (
            <>
          {dashView === "groups" ? (
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
          ) : null}
          {dashView === "ungrouped" ? (
            <label className="fam-dash-group-filter">
              <select
                className="fam-dash-search fam-dash-group-select"
                value={soloFilter}
                onChange={(e) => setSoloFilter(e.target.value)}
                aria-label="Filter by ungrouped company"
              >
                <option value="">All ungrouped ({soloOptions.length})</option>
                {soloOptions.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label} ({g.n})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {dashView === "sme" ? (
            <label className="fam-dash-group-filter">
              <select
                className="fam-dash-search fam-dash-group-select"
                value={smeFilter}
                onChange={(e) => setSmeFilter(e.target.value)}
                aria-label="Filter by SME company"
              >
                <option value="">All SME ({smeOptions.length})</option>
                {smeOptions.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label} ({g.n})
                  </option>
                ))}
              </select>
            </label>
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
                : dashView === "ungrouped" ||
                    dashView === "sme" ||
                    dashView === "holdings"
                  ? "Ticker, company, director or outside board…"
                  : "Group, ticker, company or director…"
            }
            hits={dashHits}
            loading={dashHitLoading}
            onPick={onDashPick}
          />
          {dashView === "groups" || dashView === "ungrouped" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "Cancel" : "Add group"}
          </button>
          ) : null}
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              void (dashView === "people"
                ? loadPeople({
                    refresh: true,
                    q: q.trim().length >= 2 ? q.trim() : undefined,
                  })
                : dashView === "ungrouped"
                  ? loadSolos({ refresh: true })
                  : dashView === "sme"
                    ? loadSmeMaps({ refresh: true })
                  : dashView === "holdings"
                    ? loadHoldingMaps({ refresh: true })
                    : load({ refresh: true }))
            }
            disabled={
              dashView === "people"
                ? peopleLoading
                : dashView === "ungrouped"
                  ? solosLoading
                  : dashView === "sme"
                    ? smeLoading
                  : dashView === "holdings"
                    ? holdingsLoading
                    : loading
            }
          >
            {(dashView === "people"
              ? peopleLoading
              : dashView === "ungrouped"
                ? solosLoading
                : dashView === "sme"
                  ? smeLoading
                : dashView === "holdings"
                  ? holdingsLoading
                  : loading)
              ? "Loading…"
              : "Refresh"}
          </button>
            </>
          ) : null}
        </div>
      </div>
      {dashView === "groups" || dashView === "ungrouped" ? (
        addWork ? (
          <FamilyAddProgress work={addWork} />
        ) : null
      ) : null}
      {(dashView === "groups" || dashView === "ungrouped") && adding ? (
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
              <input
                type="search"
                className="gov-family-add-input"
                placeholder="Add company…"
                value={newQ}
                onChange={(e) => setNewQ(e.target.value)}
              />
              {newHits.length ? (
                <ul className="gov-family-add-hits">
                  {newHits.map((h) => (
                    <li key={h.ticker}>
                      <button
                        type="button"
                        onClick={() => {
                          setNewTickers((rows) =>
                            rows.some((x) => x.ticker === h.ticker)
                              ? rows
                              : [...rows, h],
                          );
                          setNewQ("");
                          setNewHits([]);
                        }}
                      >
                        <span className="mono">{h.ticker}</span>
                        <span>{h.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
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
      {error && dashView !== "stock" && dashView !== "network" ? (
        <div className="table-meta">Could not load: {error}</div>
      ) : null}
      {dashView === "network" ? (
        <CompanyNetworkTable
          onPerson={(id, name) => openPerson(id, name)}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          onTargetTicker={(t) => {
            setStockFocus(t);
            setDashView("stock");
          }}
        />
      ) : dashView === "stock" ? (
        <StockNetworkSearch
          initialTicker={stockFocus}
          onPerson={(id, name) => openPerson(id, name)}
        />
      ) : dashView === "ungrouped" ? (
        solosLoading && !solos.length ? (
          <div className="table-meta">Loading ungrouped companies…</div>
        ) : (
          <FamilyMapCards
            rows={filteredSolos}
            editable
            addWork={addWork}
            onPerson={(id, name) => openPerson(id, name)}
            chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
            companySearch={companySearch}
            onRefresh={(g) => {
              setRefreshingBox(g.group_id || g.family_name);
              void loadSolos({ refresh: true });
            }}
            refreshing={refreshingBox}
            onDeleteGroup={async (g) => {
              const id = g.group_id?.startsWith("user-") ? g.group_id : null;
              if (!id) {
                setSolos((prev) =>
                  prev.filter((row) => (row.group_id || row.family_name) !== (g.group_id || g.family_name)),
                );
                return;
              }
              const res = await fetch("/api/family-groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  group_id: id,
                  deleteGroup: true,
                  tickers: g.companies.map((c) => c.ticker),
                }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              setSolos((prev) => prev.filter((row) => row.group_id !== id));
              notifyGovMapChanged();
            }}
            onRename={async (g, label) => {
              const id = await ensureUserGroup(g);
              const res = await fetch("/api/family-groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ group_id: id, rename: true, label }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const name = label.replace(/\s+/g, " ").trim();
              setSolos((prev) =>
                prev.map((row) =>
                  (row.group_id || row.family_name) === (g.group_id || g.family_name)
                    ? { ...row, family_name: name, group_id: id }
                    : row,
                ),
              );
            }}
            onRemoveCompany={async (g, ticker) => {
              const id = g.group_id?.startsWith("user-") ? g.group_id : await ensureUserGroup(g);
              const res = await fetch("/api/family-groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  group_id: id,
                  remove: true,
                  ticker,
                }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const t = ticker.trim().toUpperCase();
              setSolos((prev) =>
                prev
                  .map((row) => {
                    if ((row.group_id || row.family_name) !== (g.group_id || g.family_name) && row.group_id !== id) {
                      return row;
                    }
                    const companies = row.companies.filter(
                      (c) => c.ticker.toUpperCase() !== t,
                    );
                    return {
                      ...row,
                      group_id: id,
                      companies,
                      company_count: companies.length,
                    };
                  })
                  .filter((row) => row.company_count >= 1),
              );
            }}
            onAddCompany={async (g, ticker, name) => {
              const shown = ticker.trim().toUpperCase();
              setAddWork({
                groupId: g.group_id || shown,
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
                const id = await ensureUserGroup(g);
                setAddWork({
                  groupId: id,
                  pct: 58,
                  label: "Group",
                  detail: `${shown} → ${g.family_name}`,
                });
                const fam = await fetch("/api/family-groups", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    group_id: id,
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
                setAddWork({
                  groupId: id,
                  pct: 100,
                  label: "Done",
                  detail: `${shown} in ${g.family_name}`,
                  done: true,
                });
                notifyGovMapChanged();
                setGroupFilter(id);
                setDashView("groups");
                void load({ refresh: true });
                void loadSolos({ refresh: true });
                void extra;
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setError(msg);
                setAddWork({
                  groupId: g.group_id || shown,
                  pct: 100,
                  label: "Failed",
                  detail: msg,
                  error: true,
                });
              }
            }}
          />
        )
      ) : dashView === "sme" ? (
        smeLoading && !smeRows.length ? (
          <div className="table-meta">Loading SME board graphs…</div>
        ) : (
          <FamilyMapCards
            rows={filteredSme}
            onPerson={(id, name) => openPerson(id, name)}
            chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
            onRefresh={(g) => {
              setRefreshingBox(g.group_id || g.family_name);
              void loadSmeMaps({ refresh: true });
            }}
            refreshing={refreshingBox}
          />
        )
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
      ) : (
        <FamilyMapCards
          rows={filteredWithPattern}
          editable
          addWork={addWork}
          onPerson={(id, name) => openPerson(id, name)}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          companySearch={companySearch}
          onRefresh={(g) => {
            setRefreshingBox(g.group_id || g.family_name);
            void load({ refresh: true });
          }}
          refreshing={refreshingBox}
          onDeleteGroup={async (g) => {
            if (!g.group_id) return;
            const res = await fetch("/api/family-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                group_id: g.group_id,
                deleteGroup: true,
                tickers: g.companies.map((c) => c.ticker),
              }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setRows((prev) => prev.filter((row) => row.group_id !== g.group_id));
            notifyGovMapChanged();
          }}
          onRename={async (g, label) => {
            if (!g.group_id) return;
            const res = await fetch("/api/family-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ group_id: g.group_id, rename: true, label }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

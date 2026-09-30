"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FamilyMapCards, type FamilyRow, FamilyAddProgress, type FamilyAddWork } from "@/components/FamilyMapCards";
import {
  PeopleBoardCards,
  type PersonBoardRow,
} from "@/components/PeopleBoardCards";
import { StockNetworkSearch } from "@/components/StockNetworkSearch";
import { useOptionalAppTab } from "@/lib/app-tab";
import {
  tradingviewUrl,
  governancePersonUrl,
  governanceCompanyUrl,
} from "@/lib/links";
import { GOV_MAP_CHANGED, notifyGovMapChanged } from "@/lib/gov-map-sync";

type DashView = "groups" | "people" | "stock";

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
    is_sme: false,
    directors: 0,
    din_verified: 0,
  };
}

export function FamilyDashboard() {
  const tabState = useOptionalAppTab();
  const [rows, setRows] = useState<FamilyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTickers, setNewTickers] = useState<Array<{ ticker: string; name: string }>>([]);
  const [newQ, setNewQ] = useState("");
  const [newHits, setNewHits] = useState<Array<{ ticker: string; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [addWork, setAddWork] = useState<FamilyAddWork | null>(null);
  const [dashView, setDashView] = useState<DashView>("groups");
  const [stockFocus, setStockFocus] = useState<string | null>(null);
  const [people, setPeople] = useState<PersonBoardRow[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [refreshingBox, setRefreshingBox] = useState<string | null>(null);
  const [holdPattern, setHoldPattern] = useState<{
    tickers: string[];
    lines: string[];
  } | null>(null);
  const hasGroups = useRef(false);

  const load = useCallback(async (opts?: { refresh?: boolean }) => {
    const hard = opts?.refresh === true;
    if (!hasGroups.current) setLoading(true);
    if (hard) setRefreshingBox((cur) => cur || "*");
    setError(null);
    try {
      const params = new URLSearchParams({
        view: "family",
        page: "1",
        pageSize: "200",
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

  const loadPeople = useCallback(async (opts?: { refresh?: boolean }) => {
    setPeopleLoading(true);
    if (opts?.refresh) setRefreshingBox((cur) => cur || "*");
    setError(null);
    try {
      const collected: PersonBoardRow[] = [];
      let page = 1;
      let pages = 1;
      while (page <= pages && page <= 1) {
        const params = new URLSearchParams({
          view: "director",
          sort: "boards",
          minBoards: "2",
          page: String(page),
          pageSize: "40",
        });
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
      if (dashView === "people") void loadPeople({ refresh: true });
      else if (dashView === "groups") void load({ refresh: true });
    };
    window.addEventListener(GOV_MAP_CHANGED, onChange);
    return () => window.removeEventListener(GOV_MAP_CHANGED, onChange);
  }, [dashView, load, loadPeople]);

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
    if (dashView === "people") void loadPeople();
  }, [dashView, loadPeople]);

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
    for (const p of people) for (const c of p.companies) map.set(c.ticker, c.market);
    return map;
  }, [rows, people]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (f) =>
        f.family_name.toLowerCase().includes(needle) ||
        f.companies.some(
          (c) =>
            c.ticker.toLowerCase().startsWith(needle) ||
            c.name.toLowerCase().includes(needle),
        ) ||
        (f.people ?? []).some((p) => p.name.toLowerCase().includes(needle)),
    );
  }, [rows, q]);

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

  const filteredPeople = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return people;
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.din || "").includes(needle.replace(/\D/g, "") || needle) ||
        p.companies.some(
          (c) =>
            c.ticker.toLowerCase().startsWith(needle) ||
            c.name.toLowerCase().includes(needle),
        ),
    );
  }, [people, q]);

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
          </div>
          <p className="fam-dash-sub">
            {dashView === "groups"
              ? "Click a ticker for that stock’s related nodes. Outside shows only external boards and those people. Show all restores the group."
              : dashView === "people"
                ? "Each card is a person and the listed boards they sit on. Name opens Governance; ticker shows that stock’s related boards."
                : "Search a stock. The graph is its directors plus every other listed company those directors sit on. Names open TradingView."}
          </p>
        </div>
        <div className="fam-dash-actions">
          {dashView !== "stock" ? (
            <>
          <input
            type="search"
            className="fam-dash-search"
            placeholder={
              dashView === "people"
                ? "Person, DIN, ticker or company…"
                : "Group, ticker, company or director…"
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
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
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              void (dashView === "people"
                ? loadPeople({ refresh: true })
                : load({ refresh: true }))
            }
            disabled={dashView === "people" ? peopleLoading : loading}
          >
            {(dashView === "people" ? peopleLoading : loading)
              ? "Loading…"
              : "Refresh"}
          </button>
            </>
          ) : null}
        </div>
      </div>
      {dashView === "groups" && addWork ? (
        <FamilyAddProgress work={addWork} />
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
      {error && dashView !== "stock" ? (
        <div className="table-meta">Could not load: {error}</div>
      ) : null}
      {dashView === "stock" ? (
        <StockNetworkSearch
          initialTicker={stockFocus}
          onPerson={(id, name) => openPerson(id, name)}
        />
      ) : dashView === "people" ? (
        peopleLoading && !people.length ? (
          <div className="table-meta">Loading people and boards…</div>
        ) : (
          <PeopleBoardCards
            rows={filteredPeople}
            onTicker={(t) => openCompany(t)}
            onPerson={(id, name) => openPerson(id, name)}
            chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
            onRefresh={(row) => {
              setRefreshingBox(row.person_id);
              void loadPeople({ refresh: true });
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

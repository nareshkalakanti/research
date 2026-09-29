"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FamilyMapCards, type FamilyRow, FamilyAddProgress, type FamilyAddWork } from "@/components/FamilyMapCards";
import {
  PeopleBoardCards,
  type PersonBoardRow,
} from "@/components/PeopleBoardCards";
import { StockNetworkSearch } from "@/components/StockNetworkSearch";
import { useSetAppTab } from "@/lib/app-tab";
import { tradingviewUrl } from "@/lib/links";
import { requestGovOpen } from "@/lib/gov-open";

type DashView = "groups" | "people" | "stock";

export function FamilyDashboard() {
  const setTab = useSetAppTab();
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ view: "family", page: "1", pageSize: "200" });
      const res = await fetch(`/api/governance-map?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: FamilyRow[] };
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPeople = useCallback(async () => {
    setPeopleLoading(true);
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
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      setAddWork({
        pct: 72,
        label: "Refreshing map",
        detail: label,
      });
      setAdding(false);
      setNewName("");
      setNewTickers([]);
      setNewQ("");
      setQ(label);
      await load();
      setAddWork({
        pct: 100,
        label: "Done",
        detail: label,
        done: true,
      });
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

  const showStockNetwork = (ticker: string) => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    setStockFocus(t);
    setDashView("stock");
  };

  const openPerson = (personId: string, name: string) => {
    setTab("governance");
    requestGovOpen({ kind: "director", personId, name, from: "Dashboard", returnTab: "dashboard" });
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
              void (dashView === "people" ? loadPeople() : load())
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
            onTicker={(t) => showStockNetwork(t)}
            onPerson={(id, name) => openPerson(id, name)}
            chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          />
        )
      ) : loading && !rows.length ? (
        <div className="table-meta">Loading business groups…</div>
      ) : (
        <FamilyMapCards
          rows={filtered}
          editable
          addWork={addWork}
          onPerson={(id, name) => openPerson(id, name)}
          chartUrl={(t) => tradingviewUrl(t, marketByTicker.get(t))}
          companySearch={companySearch}
          onRename={async (g, label) => {
            if (!g.group_id) return;
            await fetch("/api/family-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ group_id: g.group_id, rename: true, label }),
            });
            await load();
          }}
          onRemoveCompany={async (g, ticker) => {
            if (!g.group_id) return;
            await fetch("/api/family-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                group_id: g.group_id,
                remove: true,
                ticker,
              }),
            });
            await load();
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
              const bootJson = (await boot.json()) as { ok?: boolean; error?: string };
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
              setAddWork({
                groupId: g.group_id,
                pct: 78,
                label: "Map",
                detail: "Refreshing groups",
              });
              await load();
              setAddWork({
                groupId: g.group_id,
                pct: 100,
                label: "Done",
                detail: `${shown} in ${g.family_name}`,
                done: true,
              });
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

"use client";

import { useEffect, useState } from "react";
import { LazyFamilyGraph } from "@/components/FamilyGraph";
import { BoxRefreshButton } from "@/components/RefreshButton";

export type FamilyRow = {
  family_name: string;
  company_count: number;
  group_id?: string;
  companies: Array<{
    ticker: string;
    name: string;
    market: string;
    cap_code: string | null;
    market_cap_cr?: number | null;
    is_sme: boolean;
    family_directors?: number;
    directors?: number;
    din_verified?: number;
  }>;
  people?: Array<{
    person_id: string;
    name: string;
    din: string | null;
    tickers: string[];
    dir_score?: number;
  }>;
  outside?: Array<{ ticker: string; name: string; cap_code: string | null; market_cap_cr?: number | null }>;
};

function dinTone(verified: number, total: number): "full" | "part" | "none" {
  if (!total || !verified) return "none";
  return verified >= total ? "full" : "part";
}

function uniqueByTicker<T extends { ticker: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const t = row.ticker.trim().toUpperCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(row);
  }
  return out;
}

function sliceRelated(
  f: FamilyRow,
  ticker: string,
): {
  companies: FamilyRow["companies"];
  people: NonNullable<FamilyRow["people"]>;
  outside: NonNullable<FamilyRow["outside"]>;
} {
  const focus = ticker.trim().toUpperCase();
  const peopleAll = f.people ?? [];
  const people = peopleAll.filter((p) =>
    p.tickers.some((t) => t.toUpperCase() === focus),
  );
  if (!people.length) {
    return {
      companies: f.companies.filter((c) => c.ticker.toUpperCase() === focus),
      people: [],
      outside: [],
    };
  }
  const keep = new Set<string>([focus]);
  for (const p of people) {
    for (const t of p.tickers) {
      const u = t.toUpperCase();
      if (u) keep.add(u);
    }
  }
  const companies = f.companies.filter((c) => keep.has(c.ticker.toUpperCase()));
  const inGroup = new Set(companies.map((c) => c.ticker.toUpperCase()));
  const outside = (f.outside ?? []).filter((o) => {
    const u = o.ticker.toUpperCase();
    return keep.has(u) && !inGroup.has(u);
  });
  return { companies, people, outside };
}

function sliceExternal(opts: {
  companies: FamilyRow["companies"];
  people: NonNullable<FamilyRow["people"]>;
  outside: NonNullable<FamilyRow["outside"]>;
}): {
  companies: FamilyRow["companies"];
  people: NonNullable<FamilyRow["people"]>;
  outside: NonNullable<FamilyRow["outside"]>;
} {
  const ext = new Set(
    opts.outside.map((o) => o.ticker.toUpperCase()).filter(Boolean),
  );
  const people = opts.people.filter((p) =>
    p.tickers.some((t) => ext.has(t.toUpperCase())),
  );
  return { companies: [], people, outside: opts.outside };
}

export type FamilyAddWork = {
  groupId?: string;
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
};

export function FamilyAddProgress({
  work,
}: {
  work: FamilyAddWork;
}) {
  return (
    <div
      className={`filter-progress fam-add-progress${work.error ? " is-error" : ""}${work.done ? " is-done" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="filter-progress-track">
        <div
          className="filter-progress-fill"
          style={{ width: `${work.pct}%` }}
        />
      </div>
      <span className="filter-progress-text">
        <strong>{work.label}</strong>
        {work.detail ? ` · ${work.detail}` : null}
      </span>
    </div>
  );
}

export function FamilyMapCards({
  rows,
  onPerson,
  chartUrl,
  editable,
  onRename,
  onRemoveCompany,
  onAddCompany,
  companySearch,
  addWork,
  onRefresh,
  refreshing,
}: {
  rows: FamilyRow[];
  onTicker?: (ticker: string, group: FamilyRow) => void;
  onPerson: (personId: string, name: string, group: FamilyRow) => void;
  /** Ticker-name click: open TradingView. */
  chartUrl?: (ticker: string) => string;
  editable?: boolean;
  onRename?: (group: FamilyRow, label: string) => Promise<void> | void;
  onRemoveCompany?: (group: FamilyRow, ticker: string) => Promise<void> | void;
  onAddCompany?: (
    group: FamilyRow,
    ticker: string,
    name?: string,
  ) => Promise<void> | void;
  companySearch?: (
    q: string,
  ) => Promise<Array<{ ticker: string; name: string }>>;
  addWork?: FamilyAddWork | null;
  onRefresh?: (group: FamilyRow) => void | Promise<void>;
  refreshing?: string | null;
}) {
  const allCompanies = rows.flatMap((f) => f.companies);
  return (
    <>
      {rows.length > 0 ? (
        <div className="gov-family-summary">
          <strong>{rows.length.toLocaleString()}</strong> groups ·{" "}
          <strong>
            {rows.reduce((n, f) => n + f.company_count, 0).toLocaleString()}
          </strong>{" "}
          listed companies ·{" "}
          <strong>
            {allCompanies
              .reduce((n, c) => n + (c.din_verified ?? 0), 0)
              .toLocaleString()}
            /
            {allCompanies
              .reduce((n, c) => n + (c.directors ?? 0), 0)
              .toLocaleString()}
          </strong>{" "}
          directors DIN-validated
        </div>
      ) : null}
      <div className="gov-family-grid">
        {rows.map((f) => {
          const key = `${f.family_name}:${f.companies.map((c) => c.ticker).join(",")}`;
          return (
            <FamilyGroupCard
              key={key}
              f={f}
              onPerson={onPerson}
              chartUrl={chartUrl}
              editable={editable}
              onRename={onRename}
              onRemoveCompany={onRemoveCompany}
              onAddCompany={onAddCompany}
              companySearch={companySearch}
              addWork={addWork}
              onRefresh={onRefresh}
              refreshing={
                refreshing === "*" ||
                refreshing === (f.group_id || f.family_name)
              }
            />
          );
        })}
      </div>
      {rows.length === 0 ? (
        <div className="table-meta">No family groups found.</div>
      ) : null}
    </>
  );
}

function FamilyGroupCard({
  f,
  onPerson,
  chartUrl,
  editable,
  onRename,
  onRemoveCompany,
  onAddCompany,
  companySearch,
  addWork,
  onRefresh,
  refreshing,
}: {
  f: FamilyRow;
  onPerson: (personId: string, name: string, group: FamilyRow) => void;
  chartUrl?: (ticker: string) => string;
  editable?: boolean;
  onRename?: (group: FamilyRow, label: string) => Promise<void> | void;
  onRemoveCompany?: (group: FamilyRow, ticker: string) => Promise<void> | void;
  onAddCompany?: (
    group: FamilyRow,
    ticker: string,
    name?: string,
  ) => Promise<void> | void;
  companySearch?: (
    q: string,
  ) => Promise<Array<{ ticker: string; name: string }>>;
  addWork?: FamilyAddWork | null;
  onRefresh?: (group: FamilyRow) => void | Promise<void>;
  refreshing?: boolean;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [externalOnly, setExternalOnly] = useState(false);
  const peopleAll = f.people ?? [];
  const outsideAll = f.outside ?? [];
  const sliced = focus ? sliceRelated(f, focus) : null;
  let companies = sliced?.companies ?? f.companies;
  let people = sliced?.people ?? peopleAll;
  let outside = sliced?.outside ?? outsideAll;
  if (externalOnly) {
    const ext = sliceExternal({ companies, people, outside });
    companies = ext.companies;
    people = ext.people;
    outside = ext.outside;
  }
  const filtered = focus || externalOnly;
  const dirTotal = f.companies.reduce((n, c) => n + (c.directors ?? 0), 0);
  const dinTotal = f.companies.reduce((n, c) => n + (c.din_verified ?? 0), 0);
  const dinPct = dirTotal ? Math.round((dinTotal / dirTotal) * 100) : 0;

  const pickTicker = (ticker: string) => {
    const u = ticker.trim().toUpperCase();
    if (!u) return;
    setFocus((cur) => (cur === u ? null : u));
  };

  return (
    <article className="gov-card gov-family-card">
      <header className="gov-family-head">
        <div className="gov-family-head-row">
          <div className="gov-family-title-text">
            <span className="gov-family-name">
              {editable && onRename && f.group_id ? (
                <GroupRename label={f.family_name} onSave={(name) => onRename(f, name)} />
              ) : (
                f.family_name
              )}
            </span>
            <span className="gov-family-sub">
              {filtered ? (
                <>
                  {externalOnly ? "Outside boards" : null}
                  {externalOnly && focus ? " · " : null}
                  {focus ? `${focus} and related` : null}
                  {" · "}
                  {companies.length} in group · {outside.length} outside ·{" "}
                  {people.length} people
                </>
              ) : (
                <>
                  {f.company_count} companies · {peopleAll.length} linking people
                  {outsideAll.length ? ` · ${outsideAll.length} outside boards` : ""}
                </>
              )}
            </span>
          </div>
          <div className="gov-family-head-actions">
            {onRefresh ? (
              <BoxRefreshButton
                busy={refreshing}
                onRefresh={() => onRefresh(f)}
              />
            ) : null}
            <div
              className={`gov-family-din ${dinTone(dinTotal, dirTotal)}`}
              title={`${dinTotal} of ${dirTotal} directors have a validated DIN`}
            >
              <span className="gov-family-din-label">DIN</span>
              <span className="gov-family-din-val">
                {dinTotal}/{dirTotal}
              </span>
              <span className="gov-family-din-pct">{dinPct}%</span>
            </div>
          </div>
        </div>
        {filtered ? (
          <div className="gov-family-focus-bar">
            <span>
              {externalOnly ? "Outside-group boards and linking people" : null}
              {externalOnly && focus ? " · " : null}
              {focus ? (
                <>
                  Showing <strong className="mono">{focus}</strong> and connected
                  nodes
                </>
              ) : null}
            </span>
            <button
              type="button"
              className="chip tag-chip"
              onClick={() => {
                setFocus(null);
                setExternalOnly(false);
              }}
            >
              Show all ×
            </button>
          </div>
        ) : null}
      </header>
      <LazyFamilyGraph
        companies={companies}
        people={people}
        outside={outside}
        onCompany={pickTicker}
        onPerson={(id, name) => onPerson(id, name, f)}
        chartUrl={chartUrl}
      />
      <div className="gov-family-chips">
        <button
          type="button"
          className={`gov-family-chip part${externalOnly ? " is-focus" : ""}`}
          disabled={!outsideAll.length}
          title={
            outsideAll.length
              ? externalOnly
                ? "Show the full group again"
                : "Show only outside-group boards and the people on them"
              : "No outside-group boards on this map"
          }
          onClick={() => setExternalOnly((v) => !v)}
        >
          <span>Outside</span>
          <span className="gov-family-chip-din">{outsideAll.length}</span>
        </button>
        {uniqueByTicker(f.companies).map((c) => {
          const on = focus === c.ticker.toUpperCase();
          const title = on
            ? `${c.ticker} · click again or Show all to restore the group`
            : `${c.ticker} · ${c.din_verified ?? 0} of ${c.directors ?? 0} directors DIN-validated — show related boards`;
          const cls = `gov-family-chip ${dinTone(c.din_verified ?? 0, c.directors ?? 0)}${on ? " is-focus" : ""}`;
          return (
            <span key={c.ticker} className="gov-family-chip-wrap">
              <button
                type="button"
                className={cls}
                title={title}
                onClick={() => pickTicker(c.ticker)}
              >
                <span className="mono">{c.ticker}</span>
                <span className="gov-family-chip-din">
                  {c.din_verified ?? 0}/{c.directors ?? 0}
                </span>
              </button>
              {editable && onRemoveCompany && f.group_id ? (
                <button
                  type="button"
                  className="gov-family-chip-x"
                  title={
                    on ? "Show the full group" : `Remove ${c.ticker} from group`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (on) {
                      setFocus(null);
                      return;
                    }
                    void onRemoveCompany(f, c.ticker);
                  }}
                >
                  ×
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      {editable && onAddCompany && companySearch && f.group_id ? (
        <GroupAddCompany
          exclude={new Set(f.companies.map((c) => c.ticker.toUpperCase()))}
          search={companySearch}
          busy={!!addWork && !addWork.done && addWork.groupId === f.group_id}
          work={
            addWork && addWork.groupId === f.group_id ? addWork : null
          }
          onAdd={(ticker, name) => onAddCompany(f, ticker, name)}
        />
      ) : null}
    </article>
  );
}

function GroupRename({
  label,
  onSave,
}: {
  label: string;
  onSave: (name: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  useEffect(() => {
    setValue(label);
  }, [label]);
  if (!editing) {
    return (
      <button
        type="button"
        className="gov-family-rename"
        title="Rename group"
        onClick={() => setEditing(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <form
      className="gov-family-rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        const next = value.replace(/\s+/g, " ").trim();
        setEditing(false);
        if (next && next !== label) void onSave(next);
      }}
    >
      <input
        autoFocus
        className="gov-family-rename-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const next = value.replace(/\s+/g, " ").trim();
          setEditing(false);
          if (next && next !== label) void onSave(next);
        }}
        aria-label="Group name"
      />
    </form>
  );
}

function GroupAddCompany({
  exclude,
  search,
  onAdd,
  busy,
  work,
}: {
  exclude: Set<string>;
  search: (q: string) => Promise<Array<{ ticker: string; name: string }>>;
  onAdd: (ticker: string, name: string) => Promise<void> | void;
  busy?: boolean;
  work?: FamilyAddWork | null;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Array<{ ticker: string; name: string }>>([]);
  const [already, setAlready] = useState<Array<{ ticker: string; name: string }>>(
    [],
  );
  useEffect(() => {
    const needle = q.trim();
    if (busy || needle.length < 2) {
      setHits([]);
      setAlready([]);
      return;
    }
    const t = window.setTimeout(() => {
      void search(needle).then((rows) => {
        setAlready(
          rows.filter((r) => exclude.has(r.ticker.toUpperCase())).slice(0, 4),
        );
        setHits(
          rows.filter((r) => !exclude.has(r.ticker.toUpperCase())).slice(0, 8),
        );
      });
    }, 200);
    return () => window.clearTimeout(t);
  }, [q, exclude, search, busy]);
  const show = hits.length || already.length;
  return (
    <div className="gov-family-add">
      <input
        type="search"
        className="gov-family-add-input"
        placeholder={busy ? "Adding company…" : "Add company…"}
        value={q}
        disabled={busy}
        onChange={(e) => setQ(e.target.value)}
      />
      {work ? <FamilyAddProgress work={work} /> : null}
      {show && !busy ? (
        <ul className="gov-family-add-hits">
          {already.map((h) => (
            <li key={`have-${h.ticker}`}>
              <button type="button" disabled title="Already in this group">
                <span className="mono">{h.ticker}</span>
                <span>{h.name} · already in group</span>
              </button>
            </li>
          ))}
          {hits.map((h) => (
            <li key={h.ticker}>
              <button
                type="button"
                onClick={() => {
                  void onAdd(h.ticker, h.name);
                  setQ("");
                  setHits([]);
                  setAlready([]);
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
  );
}

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
    span_tickers?: string[];
    dir_score?: number;
  }>;
  outside?: Array<{ ticker: string; name: string; cap_code: string | null; market_cap_cr?: number | null }>;
  listings?: Array<{ ticker: string; name: string; cap_code: string | null; market_cap_cr?: number | null }>;
  pattern?: string | null;
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

function overlayNetwork(
  f: FamilyRow,
  net: {
    companies: Array<{
      ticker: string;
      name: string;
      market?: string;
      cap_code?: string | null;
      market_cap_cr?: number | null;
      is_sme?: boolean;
      directors?: number;
      din_verified?: number;
    }>;
    people: NonNullable<FamilyRow["people"]>;
  },
): {
  companies: FamilyRow["companies"];
  people: NonNullable<FamilyRow["people"]>;
  outside: NonNullable<FamilyRow["outside"]>;
} {
  const group = new Set(f.companies.map((c) => c.ticker.toUpperCase()));
  const fam = new Map(f.companies.map((c) => [c.ticker.toUpperCase(), c]));
  const info = new Map<
    string,
    {
      ticker: string;
      name: string;
      cap_code?: string | null;
      market_cap_cr?: number | null;
      market?: string;
      is_sme?: boolean;
      directors?: number;
      din_verified?: number;
    }
  >();
  for (const c of net.companies) {
    const u = c.ticker.toUpperCase();
    if (u) info.set(u, c);
  }
  for (const c of f.listings ?? []) {
    const u = c.ticker.toUpperCase();
    if (u && !info.has(u)) info.set(u, c);
  }
  const companies: FamilyRow["companies"] = [];
  const seenCo = new Set<string>();
  const outside: NonNullable<FamilyRow["outside"]> = [];
  const seenOut = new Set<string>();
  const addCompany = (u: string) => {
    if (seenCo.has(u)) return;
    seenCo.add(u);
    const hit = fam.get(u);
    const n = info.get(u);
    companies.push(
      hit ?? {
        ticker: n?.ticker || u,
        name: n?.name || u,
        market: n?.market || "",
        cap_code: n?.cap_code ?? null,
        market_cap_cr: n?.market_cap_cr,
        is_sme: Boolean(n?.is_sme),
        directors: n?.directors,
        din_verified: n?.din_verified,
      },
    );
  };
  const addOutside = (u: string) => {
    if (seenOut.has(u) || group.has(u)) return;
    seenOut.add(u);
    const n = info.get(u);
    outside.push({
      ticker: n?.ticker || u,
      name: n?.name || u,
      cap_code: n?.cap_code ?? null,
      market_cap_cr: n?.market_cap_cr,
    });
  };
  for (const c of net.companies) {
    const u = c.ticker.toUpperCase();
    if (!u) continue;
    if (group.has(u)) addCompany(u);
    else addOutside(u);
  }
  for (const p of net.people) {
    for (const t of p.tickers) {
      const u = t.toUpperCase();
      if (!u) continue;
      if (group.has(u)) addCompany(u);
      else addOutside(u);
    }
  }
  return { companies, people: net.people, outside };
}

function outsideFromPeople(
  group: Set<string>,
  people: NonNullable<FamilyRow["people"]>,
  known: Array<{
    ticker: string;
    name: string;
    cap_code?: string | null;
    market_cap_cr?: number | null;
  }>,
): NonNullable<FamilyRow["outside"]> {
  const info = new Map<string, (typeof known)[number]>();
  for (const row of known) {
    const u = row.ticker.toUpperCase();
    if (u) info.set(u, row);
  }
  const out: NonNullable<FamilyRow["outside"]> = [];
  const seen = new Set<string>();
  for (const p of people) {
    for (const t of p.tickers) {
      const u = t.toUpperCase();
      if (!u || group.has(u) || seen.has(u)) continue;
      seen.add(u);
      const n = info.get(u);
      out.push({
        ticker: n?.ticker || u,
        name: n?.name || u,
        cap_code: n?.cap_code ?? null,
        market_cap_cr: n?.market_cap_cr,
      });
    }
  }
  return out;
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
  onDeleteGroup,
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
  onDeleteGroup?: (group: FamilyRow) => Promise<void> | void;
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
              onDeleteGroup={onDeleteGroup}
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
  onDeleteGroup,
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
  onDeleteGroup?: (group: FamilyRow) => Promise<void> | void;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [externalOnly, setExternalOnly] = useState(false);
  const [net, setNet] = useState<{
    companies: Array<{
      ticker: string;
      name: string;
      market?: string;
      cap_code?: string | null;
      market_cap_cr?: number | null;
      is_sme?: boolean;
    }>;
    people: NonNullable<FamilyRow["people"]>;
  } | null>(null);
  const peopleAll = f.people ?? [];
  useEffect(() => {
    setNet(null);
    if (!focus) return;
    const ticker = focus;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/governance-map?view=network&ticker=${encodeURIComponent(ticker)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { row?: typeof net };
        if (cancelled) return;
        setNet(json.row ?? null);
      } catch {
        if (!cancelled) setNet(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focus]);
  const sliced = focus ? sliceRelated(f, focus) : null;
  const ego = focus && net ? overlayNetwork(f, net) : null;
  let companies = ego?.companies ?? sliced?.companies ?? f.companies;
  let people = ego?.people ?? sliced?.people ?? peopleAll;
  const groupSet = new Set(f.companies.map((c) => c.ticker.toUpperCase()));
  const shownSet = new Set(companies.map((c) => c.ticker.toUpperCase()));
  let outside = uniqueByTicker(
    outsideFromPeople(shownSet.size ? shownSet : groupSet, people, [
      ...(net?.companies ?? []),
      ...f.companies,
      ...(f.listings ?? []),
      ...(f.outside ?? []),
      ...(ego?.outside ?? []),
    ]),
  );
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

  const outsideShown = uniqueByTicker(outside);
  const outsideN = outsideShown.length;

  const pickTicker = (ticker: string) => {
    const u = ticker.trim().toUpperCase();
    if (!u) return;
    setFocus((cur) => (cur === u ? null : u));
  };

  return (
    <article className="gov-card gov-family-card" data-fam-key={f.group_id || f.family_name}>
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
                  {companies.length} in group · {outsideN} outside ·{" "}
                  {people.length} people
                  {focus ? " (full board)" : ""}
                </>
              ) : (
                <>
                  {f.company_count} companies · {peopleAll.length} linking people
                  {outsideN ? ` · ${outsideN} outside boards` : ""}
                  {f.pattern ? ` · ${f.pattern}` : ""}
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
            {editable && onDeleteGroup && f.group_id ? (
              <button
                type="button"
                className="btn-box-remove"
                title="Remove this whole group"
                onClick={() => {
                  if (
                    typeof window !== "undefined" &&
                    !window.confirm(`Remove group “${f.family_name}”?`)
                  ) {
                    return;
                  }
                  void onDeleteGroup(f);
                }}
              >
                ×
              </button>
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
                  Showing <strong className="mono">{focus}</strong> board and
                  connected nodes
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
        outside={outsideShown}
        onCompany={pickTicker}
        onPerson={(id, name) => onPerson(id, name, f)}
        chartUrl={chartUrl}
      />
      <div className="gov-family-chips">
        <button
          type="button"
          className={`gov-family-chip part${externalOnly ? " is-focus" : ""}`}
          disabled={!outsideN}
          title={
            outsideN
              ? externalOnly
                ? "Show the full group again"
                : "Show only outside-group boards and the people on them"
              : "No outside-group boards on this map"
          }
          onClick={() => setExternalOnly((v) => !v)}
        >
          <span>Outside</span>
          <span className="gov-family-chip-din">{outsideN}</span>
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

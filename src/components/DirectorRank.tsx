"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { FamilyGraph } from "@/components/FamilyGraph";
import { Loading } from "@/components/Loading";
import { usePagedRows } from "@/components/MoreRows";
import type { RankDirector, RankSeat } from "@/app/api/director-rank/route";
import { napkinUrl } from "@/lib/links";

/**
 * Directors → ranked league table of everyone on 2+ listed boards, with
 * analytics (board-count spread, role mix, groups spanned, combined market
 * cap) and a node graph per director: their boards plus the co-directors who
 * share 2+ of those boards.
 */

type Kind = "independent" | "executive" | "bridge" | "nonexec";
type SortKey = "boards" | "mcap" | "groups" | "score" | "recent";
type KindFilter = "all" | Kind;

type Ranked = RankDirector & {
  boards: number;
  ind: number;
  exec: number;
  non: number;
  mcap: number;
  top: RankSeat | null;
  groups: number;
  groupNames: string[];
  sectors: string[];
  sme: number;
  kind: Kind;
};

const KIND_LABEL: Record<Kind, string> = {
  independent: "Independent",
  executive: "Executive",
  bridge: "Bridge",
  nonexec: "Non-executive",
};

const KIND_HINT: Record<Kind, string> = {
  independent: "Independent director on every board",
  executive: "Executive (MD / whole-time / CFO) on at least one board, all inside one group",
  bridge: "Non-independent seats in 2+ different business groups — links houses",
  nonexec: "Non-executive, non-independent (often promoter side) inside one group",
};

/** SEBI LODR: at most 7 listed boards as independent director. */
const BUSY = 7;

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(1)} lakh Cr`;
  return `₹${Math.round(n).toLocaleString("en-IN")} Cr`;
}

function enrich(r: RankDirector): Ranked {
  let ind = 0;
  let exec = 0;
  let non = 0;
  let mcap = 0;
  let top: RankSeat | null = null;
  const groups = new Set<string>();
  const nonIndGroups = new Set<string>();
  const sec = new Map<string, number>();
  let sme = 0;
  for (const s of r.seats) {
    if (s.r === "I") ind += 1;
    else if (s.r === "E") exec += 1;
    else non += 1;
    if (s.mc) mcap += s.mc;
    if (s.mc && (!top || s.mc > (top.mc ?? 0))) top = s;
    const g = s.g || `solo:${s.t}`;
    groups.add(g);
    if (s.r !== "I") nonIndGroups.add(g);
    if (s.sec) sec.set(s.sec, (sec.get(s.sec) ?? 0) + 1);
    if (s.sme) sme += 1;
  }
  const kind: Kind =
    nonIndGroups.size >= 2 ? "bridge" : exec ? "executive" : non ? "nonexec" : "independent";
  return {
    ...r,
    boards: r.seats.length,
    ind,
    exec,
    non,
    mcap,
    top,
    groups: groups.size,
    groupNames: [...groups].filter((g) => !g.startsWith("solo:")),
    sectors: [...sec.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s),
    sme,
    kind,
  };
}

function RoleBar({ r }: { r: Ranked }) {
  const pct = (n: number) => `${(n / r.boards) * 100}%`;
  return (
    <span
      className="dr-role"
      title={`${r.ind} independent · ${r.exec} executive · ${r.non} other non-executive`}
    >
      <span className="dr-role-bar">
        <span className="i" style={{ width: pct(r.ind) }} />
        <span className="e" style={{ width: pct(r.exec) }} />
        <span className="n" style={{ width: pct(r.non) }} />
      </span>
      <span className="dr-role-n">
        {r.ind}I · {r.exec}E · {r.non}N
      </span>
    </span>
  );
}

function DirectorDetail({
  r,
  byTicker,
  byId,
  onTicker,
  onPerson,
  chartUrl,
}: {
  r: Ranked;
  byTicker: Map<string, string[]>;
  byId: Map<string, Ranked>;
  onTicker: (t: string) => void;
  onPerson: (id: string, name: string) => void;
  chartUrl?: (t: string) => string;
}) {
  // Co-directors: other people on 2+ of this director's boards.
  const co = useMemo(() => {
    const n = new Map<string, string[]>();
    for (const s of r.seats)
      for (const id of byTicker.get(s.t) ?? []) {
        if (id === r.id) continue;
        const xs = n.get(id) ?? [];
        xs.push(s.t);
        n.set(id, xs);
      }
    return [...n.entries()]
      .filter(([, ts]) => ts.length >= 2)
      .map(([id, ts]) => ({ p: byId.get(id)!, ts }))
      .filter((x) => x.p)
      .sort((a, b) => b.ts.length - a.ts.length || b.p.boards - a.p.boards);
  }, [r, byTicker, byId]);
  const shown = co.slice(0, 10);
  return (
    <div className="dr-detail">
      <FamilyGraph
        companies={r.seats.map((s) => ({ ticker: s.t, name: s.n, market_cap_cr: s.mc }))}
        people={[
          { person_id: r.id, name: r.name, din: r.din, tickers: r.seats.map((s) => s.t), recent_join: r.recent },
          ...shown.map((x) => ({ person_id: x.p.id, name: x.p.name, din: x.p.din, tickers: x.ts })),
        ]}
        outside={[]}
        onCompany={onTicker}
        onPerson={onPerson}
        chartUrl={chartUrl}
      />
      <div className="dr-detail-cols">
        <div>
          <h4>Boards</h4>
          <ul className="dr-seats">
            {[...r.seats]
              .sort((a, b) => (b.mc ?? 0) - (a.mc ?? 0))
              .map((s) => (
                <li key={s.t}>
                  <button type="button" className="link-btn mono" onClick={() => onTicker(s.t)}>
                    {s.t}
                  </button>{" "}
                  <span className={`dr-tag r-${s.r}`}>{s.r === "I" ? "Independent" : s.r === "E" ? "Executive" : "Non-exec"}</span>{" "}
                  <span className="dr-muted">
                    {fmtCr(s.mc)}
                    {s.m !== "NSE" ? ` · ${s.m}` : ""}
                    {s.g ? ` · ${s.g}` : ""}
                    {s.sec ? ` · ${s.sec}` : ""}
                  </span>{" "}
                  <a className="np-chip" href={napkinUrl(s.t)} target="_blank" rel="noopener noreferrer">
                    NP
                  </a>
                </li>
              ))}
          </ul>
        </div>
        <div>
          <h4>Sits with (2+ shared boards)</h4>
          {co.length ? (
            <ul className="dr-seats">
              {co.slice(0, 20).map((x) => (
                <li key={x.p.id}>
                  <button type="button" className="link-btn" onClick={() => onPerson(x.p.id, x.p.name)}>
                    {x.p.name}
                  </button>{" "}
                  <span className="dr-muted">
                    {x.ts.length} shared · {x.ts.join(", ")} · {x.p.boards} boards in all
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dr-muted">No one else shares two of these boards.</p>
          )}
          {co.length > 10 ? <p className="dr-muted">Graph shows the top 10.</p> : null}
        </div>
      </div>
    </div>
  );
}

export function DirectorRank({
  q,
  reloadKey,
  onTicker,
  onPerson,
  chartUrl,
}: {
  q: string;
  reloadKey: number;
  onTicker: (t: string) => void;
  onPerson: (id: string, name: string) => void;
  chartUrl?: (t: string) => string;
}) {
  const [raw, setRaw] = useState<RankDirector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("boards");
  const [kind, setKind] = useState<KindFilter>("all");
  const [minBoards, setMinBoards] = useState(2);
  const [busyOnly, setBusyOnly] = useState(false);
  const [smeOnly, setSmeOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/director-rank", { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; rows?: RankDirector[]; error?: string };
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRaw(json.rows ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load, reloadKey]);

  const all = useMemo(() => (raw ?? []).map(enrich), [raw]);
  const byId = useMemo(() => new Map(all.map((r) => [r.id, r])), [all]);
  const byTicker = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of all)
      for (const s of r.seats) {
        const xs = m.get(s.t) ?? [];
        xs.push(r.id);
        m.set(s.t, xs);
      }
    return m;
  }, [all]);

  const needle = q.trim().toLowerCase();
  const base = useMemo(
    () =>
      all.filter(
        (r) =>
          r.boards >= minBoards &&
          (!busyOnly || r.boards >= BUSY) &&
          (!smeOnly || r.sme > 0) &&
          (!needle ||
            r.name.toLowerCase().includes(needle) ||
            (r.din ?? "").includes(needle) ||
            r.seats.some((s) => s.t.toLowerCase() === needle || s.n.toLowerCase().includes(needle))),
      ),
    [all, minBoards, busyOnly, smeOnly, needle],
  );
  const rows = useMemo(() => {
    const xs = base.filter((r) => kind === "all" || r.kind === kind);
    const by: Record<SortKey, (a: Ranked, b: Ranked) => number> = {
      boards: (a, b) => b.boards - a.boards || b.mcap - a.mcap,
      mcap: (a, b) => b.mcap - a.mcap,
      groups: (a, b) => b.groups - a.groups || b.boards - a.boards,
      score: (a, b) => b.score - a.score,
      recent: (a, b) =>
        Number(b.recent) - Number(a.recent) || (b.joined_at ?? "").localeCompare(a.joined_at ?? "") || b.boards - a.boards,
    };
    return [...xs].sort(by[sort]);
  }, [base, kind, sort]);
  const { visible, more } = usePagedRows(rows, 50);

  const stats = useMemo(() => {
    const seats = all.reduce((n, r) => n + r.boards, 0);
    const ind = all.reduce((n, r) => n + r.ind, 0);
    const spread = [2, 3, 4, 5, 6].map((b) => ({
      b,
      n: all.filter((r) => (b === 6 ? r.boards >= 6 : r.boards === b)).length,
    }));
    const kinds = (Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ k, n: all.filter((r) => r.kind === k).length }));
    return {
      people: all.length,
      seats,
      indPct: seats ? Math.round((ind / seats) * 100) : 0,
      busy: all.filter((r) => r.boards >= BUSY).length,
      dinPct: all.length ? Math.round((all.filter((r) => r.din_backed).length / all.length) * 100) : 0,
      spread,
      kinds,
      maxSpread: Math.max(1, ...spread.map((s) => s.n)),
    };
  }, [all]);

  if (error && !raw) return <p className="miq-empty-hint">Could not load directors: {error}</p>;
  if (!raw) return <Loading label="Ranking directors across listed boards" variant="block" />;

  const kindCount = (k: Kind) => base.filter((r) => r.kind === k).length;

  return (
    <div className="dr">
      <div className="dr-tiles">
        <div className="dr-tile">
          <strong>{stats.people.toLocaleString("en-IN")}</strong>
          <span>directors on 2+ listed boards</span>
        </div>
        <div className="dr-tile">
          <strong>{stats.seats.toLocaleString("en-IN")}</strong>
          <span>board seats · {stats.indPct}% independent</span>
        </div>
        <div className="dr-tile">
          <strong>{stats.busy}</strong>
          <span>on {BUSY}+ boards (SEBI cap for independents)</span>
        </div>
        <div className="dr-tile">
          <strong>{stats.dinPct}%</strong>
          <span>matched by DIN, not just name</span>
        </div>
        <div className="dr-tile dr-spread" aria-label="Directors by board count">
          {stats.spread.map((s) => (
            <button
              key={s.b}
              type="button"
              className={minBoards === s.b ? "on" : ""}
              title={`${s.n} directors on ${s.b === 6 ? "6+" : s.b} boards — click to show ${s.b}+`}
              onClick={() => setMinBoards(minBoards === s.b ? 2 : s.b)}
            >
              <span className="bar" style={{ height: `${Math.max(6, Math.sqrt(s.n / stats.maxSpread) * 100)}%` }} />
              <span className="lbl">{s.b === 6 ? "6+" : s.b}</span>
              <span className="cnt">{s.n}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="ss-filters">
        <div className="ss-chips" role="group" aria-label="Director type">
          <button type="button" className={`chip${kind === "all" ? " on" : ""}`} onClick={() => setKind("all")}>
            All <span className="nano-count">{base.length}</span>
          </button>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`chip${kind === k ? " on" : ""}`}
              title={KIND_HINT[k]}
              onClick={() => setKind(k)}
            >
              {KIND_LABEL[k]} <span className="nano-count">{kindCount(k)}</span>
            </button>
          ))}
        </div>
        <div className="ss-chips" role="group" aria-label="Minimum boards">
          {[2, 3, 4, 5].map((b) => (
            <button
              key={b}
              type="button"
              className={`chip${minBoards === b ? " on" : ""}`}
              onClick={() => setMinBoards(b)}
            >
              {b}+ boards
            </button>
          ))}
        </div>
        <label className="mom-clean">
          <input type="checkbox" checked={busyOnly} onChange={(e) => setBusyOnly(e.target.checked)} /> {BUSY}+ boards only
        </label>
        <label className="mom-clean">
          <input type="checkbox" checked={smeOnly} onChange={(e) => setSmeOnly(e.target.checked)} /> Has an SME board
        </label>
        <label className="dr-sort">
          Rank by{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="boards">Boards</option>
            <option value="mcap">Combined market cap</option>
            <option value="groups">Groups spanned</option>
            <option value="score">Director score</option>
            <option value="recent">Recent joins</option>
          </select>
        </label>
      </div>

      <div className="table-wrap">
        <table className="data-table dr-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Director</th>
              <th className="num">Boards</th>
              <th>Roles</th>
              <th className="num" title="Sum of market caps of the boards they sit on">Combined cap</th>
              <th>Largest board</th>
              <th className="num" title="Distinct business groups (an ungrouped listing counts as its own)">Groups</th>
              <th>Sectors</th>
              <th className="num" title="Director score (board quality, DIN match, spread)">Score</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <Fragment key={r.id}>
                <tr className={open === r.id ? "dr-open" : ""}>
                  <td className="num dr-muted">{i + 1}</td>
                  <td>
                    <button
                      type="button"
                      className="dr-name"
                      aria-expanded={open === r.id}
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      title="Show their boards and co-directors as a graph"
                    >
                      <span className="dr-caret">{open === r.id ? "▾" : "▸"}</span> {r.name}
                    </button>
                    {r.recent ? (
                      <span className="gov-badge recent-join" title={r.joined_at ? `Joined ${r.joined_at.slice(0, 10)}` : ""}>
                        new
                      </span>
                    ) : null}
                    <span className={`dr-kind k-${r.kind}`} title={KIND_HINT[r.kind]}>
                      {KIND_LABEL[r.kind]}
                    </span>
                    <span className="dr-sub">
                      {r.din ? `DIN ${r.din}` : "no DIN"}
                      {" · "}
                      <button type="button" className="link-btn" onClick={() => onPerson(r.id, r.name)}>
                        Governance ↗
                      </button>
                    </span>
                  </td>
                  <td className={`num${r.boards >= BUSY ? " dr-busy" : ""}`}>{r.boards}</td>
                  <td>
                    <RoleBar r={r} />
                  </td>
                  <td className="num">{fmtCr(r.mcap)}</td>
                  <td>
                    {r.top ? (
                      <>
                        <button type="button" className="link-btn mono" onClick={() => onTicker(r.top!.t)}>
                          {r.top.t}
                        </button>{" "}
                        <span className="dr-muted">{fmtCr(r.top.mc)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num" title={r.groupNames.join(", ")}>
                    {r.groups}
                  </td>
                  <td className="dr-muted">{r.sectors.slice(0, 2).join(", ") || "—"}</td>
                  <td className="num">{Math.round(r.score)}</td>
                </tr>
                {open === r.id ? (
                  <tr className="dr-detail-row">
                    <td colSpan={9}>
                      <DirectorDetail
                        r={r}
                        byTicker={byTicker}
                        byId={byId}
                        onTicker={onTicker}
                        onPerson={onPerson}
                        chartUrl={chartUrl}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
        {rows.length ? null : <p className="miq-empty-hint">No directors match these filters.</p>}
        {more}
      </div>
      <p className="nano-note">
        Roles: <strong>I</strong> independent · <strong>E</strong> executive (MD, whole-time, CFO) · <strong>N</strong> other
        non-executive. <strong>Bridge</strong> = non-independent seats in two or more business groups. Click a name for the
        graph of their boards (large nodes) and the people who share two or more of them.
      </p>
    </div>
  );
}

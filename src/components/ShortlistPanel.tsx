"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FilterBar, MultiPick, PageHead, Pick, Seg, Toggle } from "@/components/FilterBar";
import { Loading } from "@/components/Loading";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import type { NanoFillJob } from "@/lib/nanocap-champs";
import type { ShortlistPage, ShortlistRow } from "@/lib/shortlist";

type CapBand = "all" | "tiny" | "small" | "mid" | "upper";
const CAP_BANDS: ReadonlyArray<readonly [CapBand, string, number, number]> = [
  ["all", "₹100–6,000 Cr", 0, Infinity],
  ["tiny", "₹100–500 Cr", 0, 500],
  ["small", "₹500–1,000 Cr", 500, 1000],
  ["mid", "₹1,000–3,000 Cr", 1000, 3000],
  ["upper", "₹3,000–6,000 Cr", 3000, Infinity],
];
type Style = "value" | "growth";
const STYLE_KEY = "shortlist.style";
type Mkt = "all" | "nse" | "bse" | "bsesme";
const mktOf = (m: string): Mkt => (m === "BSE" ? "bse" : m === "BSE SME" ? "bsesme" : "nse");

const CHECK_LABEL: Record<ShortlistRow["checks"][number]["id"], string> = {
  watch: "No GSM",
  profit: "Profit",
  tax: "Pays tax",
  debt: "Debt",
};

const THEME_KEY = "shortlist.themes";

function num(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

function Bar({ v, title }: { v: number | null; title: string }) {
  return (
    <span className="sl-bar" title={title}>
      <span className="sl-bar-track">
        <span className="sl-bar-fill" style={{ width: `${v ?? 0}%`, opacity: v == null ? 0 : 1 }} />
      </span>
      <span className="sl-bar-num">{v == null ? "—" : v}</span>
    </span>
  );
}

/** Shortlist tab: theme → trust → safety → cheap + happening, top 80. */
export function ShortlistPanel() {
  const [page, setPage] = useState<ShortlistPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<NanoFillJob | null>(null);
  const [themes, setThemes] = useState<string[]>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(THEME_KEY) : null;
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : ["premium", "infra"];
    } catch {
      return ["premium", "infra"];
    }
  });
  const [cap, setCap] = useState<CapBand>("all");
  const [style, setStyle] = useState<Style>(() => {
    try {
      return window.localStorage.getItem(STYLE_KEY) === "growth" ? "growth" : "value";
    } catch {
      return "value";
    }
  });
  const pickStyle = (v: Style) => {
    setStyle(v);
    try {
      window.localStorage.setItem(STYLE_KEY, v);
    } catch {
      /* storage blocked */
    }
  };
  const [mkt, setMkt] = useState<Mkt>("all");
  const [happeningOnly, setHappeningOnly] = useState(false);
  const [smartOnly, setSmartOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_KEY, JSON.stringify(themes));
    } catch {
      /* storage blocked */
    }
  }, [themes]);

  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/shortlist${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const json = (await res.json()) as ShortlistPage & { ok: boolean; error?: string; job: NanoFillJob | null };
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPage(json);
      setJob(json.job);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // Poll the fill while it runs; reload the list when it finishes.
  const running = job?.running && job.kind === "shortlist";
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(async () => {
      try {
        const res = await fetch("/api/shortlist?job=1", { cache: "no-store" });
        const json = (await res.json()) as { job: NanoFillJob | null };
        setJob(json.job);
        if (!json.job?.running) void load(true);
      } catch {
        /* retry next tick */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [running, load]);

  const startFill = async () => {
    const res = await fetch("/api/shortlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themes }),
    });
    const json = (await res.json()) as { job: NanoFillJob | null };
    setJob(json.job);
  };
  const stopFill = async () => {
    await fetch("/api/shortlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stop: true }),
    });
  };

  const scoreOf = useCallback((r: ShortlistRow) => (style === "growth" ? r.score_growth : r.score), [style]);
  const inTheme = useMemo(() => {
    const all = [...(page?.rows ?? [])].sort((a, b) => scoreOf(b) - scoreOf(a));
    if (!themes.length) return all;
    const want = new Set(themes);
    return all.filter((r) => r.themes.some((t) => want.has(t)));
  }, [page, themes, scoreOf]);
  const inMkt = inTheme.filter((r) => mkt === "all" || mktOf(r.market) === mkt);
  const inCap = inMkt.filter((r) => {
    const b = CAP_BANDS.find((x) => x[0] === cap)!;
    return r.mcap_cr != null && r.mcap_cr >= b[2] && r.mcap_cr < b[3];
  });
  const filtered = inCap.filter(
    (r) => (!happeningOnly || r.happenings.length > 0) && (!smartOnly || r.smart.length > 0),
  );
  const topN = page?.rules.topN ?? 80;
  const rows = showAll ? filtered : filtered.slice(0, topN);
  const needFill = inTheme.filter((r) => r.checks.some((c) => (c.id === "tax" || c.id === "debt") && c.ok == null)).length;

  if (error && !page) return <div className="table-meta">Could not load: {error}</div>;
  if (!page) return <Loading label="Scoring boards, safety and valuation" variant="block" />;

  const themeLabel = new Map(page.themes.map((t) => [t.id, t.label]));
  const capCount = (lo: number, hi: number) => inMkt.filter((r) => r.mcap_cr != null && r.mcap_cr >= lo && r.mcap_cr < hi).length;
  const mktCount = (id: Mkt) => (id === "all" ? inTheme.length : inTheme.filter((r) => mktOf(r.market) === id).length);

  return (
    <section className="nano-section sl-panel">
      <PageHead
        title="Shortlist"
        sub={`Small companies worth fundamental work — trusted board, safe books, cheap or something happening. Top ${topN} shown.`}
      >
        <p>
          The Goldiam / Sanghvi Movers process: <strong>1 Theme</strong> — a trend you believe in ·{" "}
          <strong>2 Trust</strong> — board quality from who the directors are and where else they sit ·{" "}
          <strong>3 Safety</strong> — profitable, pays tax, debt in check, not under GSM / insolvency ·{" "}
          <strong>4 Cheap + happening</strong> — P/E vs its sector, strong director joins, buybacks, profit jumps.
          Past growth is not required.
        </p>
        <p>
          <strong>Score</strong> — Value: 40% Trust + 25% Cheap + 20% Happening + 15% Quality. Growth: 40% Trust + 30%
          Quality + 20% Growth (sales and profit on last year&apos;s quarter) + 10% Happening.
        </p>
        <p>
          <strong>Trust</strong> — independent share, board size, directors who also sit on ₹5,000 Cr+ boards, average
          ROCE of their other boards; minus resigning independents, directors on GSM / insolvency companies, directors
          on 7+ boards. <strong>Cheap</strong> — P/E against the sector median. <strong>Happening</strong> — a
          well-connected director joined, a buyback, or a profit jump / turnaround. <strong>Quality</strong> — ROCE,
          5-year sales growth, steady margins (ranking only). Director CVs are not in yet.
        </p>
      </PageHead>

      <FilterBar>
        <Seg
          label="Style"
          value={style}
          onChange={pickStyle}
          options={[
            { id: "value", label: "Value", title: "40% Trust · 25% Cheap · 20% Happening · 15% Quality — Goldiam / Sanghvi kind" },
            { id: "growth", label: "Growth", title: "40% Trust · 30% Quality · 20% Growth · 10% Happening — Listed Ventures kind" },
          ]}
        />
        <MultiPick
          label="Themes"
          allLabel="Any sector"
          values={themes}
          onChange={setThemes}
          options={page.themes.map((t) => ({ id: t.id, label: t.label, count: page.rows.filter((r) => r.themes.includes(t.id)).length }))}
        />
        <Pick
          label="Size"
          value={cap}
          onChange={setCap}
          options={CAP_BANDS.map(([id, label, lo, hi]) => ({ id, label, count: capCount(lo, hi) }))}
        />
        <Pick
          label="Exchange"
          value={mkt}
          onChange={setMkt}
          options={(
            [
              ["all", "All"],
              ["nse", "NSE + NSE SME"],
              ["bse", "BSE"],
              ["bsesme", "BSE SME"],
            ] as const
          ).map(([id, label]) => ({ id, label, count: mktCount(id) }))}
        />
        <Toggle
          label="Happening"
          checked={happeningOnly}
          onChange={setHappeningOnly}
          count={inCap.filter((r) => r.happenings.length).length}
          title="Only stocks where something is happening: director joins, buybacks, profit jumps"
        />
        <Toggle
          label="Smart money"
          checked={smartOnly}
          onChange={setSmartOnly}
          count={inCap.filter((r) => r.smart.length).length}
          title="Only stocks held by the investors on the Smart Money tab"
        />
      </FilterBar>

      <div className="sl-status">
        <span>
          <strong>{filtered.length.toLocaleString("en-IN")}</strong> pass · showing {rows.length}
          <span className="sl-sub-inline">
            {" "}
            · {page.counts.universe.toLocaleString("en-IN")} at ₹100–6,000 Cr, {page.counts.no_board.toLocaleString("en-IN")} board unknown,{" "}
            {page.counts.failed_safety.toLocaleString("en-IN")} failed safety
          </span>
        </span>
        {running ? (
          <span className="sl-fill">
            <span className="ld-spin" aria-hidden /> Tax &amp; debt: {job!.done} of {job!.total || "…"}
            <button type="button" className="btn-ghost" onClick={() => void stopFill()}>
              Stop
            </button>
          </span>
        ) : page.paused_until ? (
          <span className="sl-fill">Screener paused until {new Date(page.paused_until).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
        ) : needFill > 0 ? (
          <span className="sl-fill" title="Until checked, Pays tax and Debt show “?”">
            {needFill.toLocaleString("en-IN")} not tax/debt-checked
            <button type="button" className="btn-ghost" disabled={!!job?.running} onClick={() => void startFill()}>
              Check now (~{Math.max(1, Math.round((needFill * 5) / 60))} min)
            </button>
          </span>
        ) : null}
      </div>

      <LvCheck lv={page.lv} shown={rows} passing={new Set(page.rows.map((r) => r.ticker))} />

      {rows.length ? (
        <ShortlistTable rows={rows} themeLabel={themeLabel} scoreOf={scoreOf} lv={page.lv} />
      ) : (
        <p className="miq-empty-hint">None with these filters.</p>
      )}
      {filtered.length > topN ? (
        <div className="rot-more">
          <button type="button" className="rot-chip" onClick={() => setShowAll((v) => !v)}>
            {showAll ? `Show top ${topN} only` : `Show all ${filtered.length}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** How many Listed Ventures (Lotusdew) holdings this view catches — a check on the screen. */
function LvCheck({
  lv,
  shown,
  passing,
}: {
  lv: ShortlistPage["lv"];
  shown: ShortlistRow[];
  passing: Set<string>;
}) {
  if (!lv.current.length) return null;
  const inView = new Set(shown.map((r) => r.ticker));
  const cur = lv.current.filter((t) => inView.has(t));
  const past = lv.past.filter((t) => inView.has(t));
  const curPass = lv.current.filter((t) => passing.has(t)).length;
  return (
    <p className="sl-lv" title="Listed Ventures = Lotusdew's basket (named lists “others” and “lvhistorical”)">
      <strong>Listed Ventures check:</strong> {cur.length} of {lv.current.length} current holdings in this list
      {cur.length ? ` (${cur.join(", ")})` : ""} · {past.length} past holding{past.length === 1 ? "" : "s"}
      {past.length ? ` (${past.join(", ")})` : ""} · {curPass} of {lv.current.length} pass all checks
    </p>
  );
}

function ShortlistTable({
  rows,
  themeLabel,
  scoreOf,
  lv,
}: {
  rows: ShortlistRow[];
  themeLabel: Map<string, string>;
  scoreOf: (r: ShortlistRow) => number;
  lv: ShortlistPage["lv"];
}) {
  const lvCur = new Set(lv.current);
  const lvPast = new Set(lv.past);
  return (
    <div className="table-wrap nano-wrap">
      <table className="data-table nano-table sl-table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="nano-col-name">Stock</th>
            <th className="num">Score</th>
            <th title="Board quality from the director network">Trust</th>
            <th title="P/E vs sector median">Cheap</th>
            <th title="Director joins, buybacks, profit jumps">Happening</th>
            <th title="Sales and profit on last year's quarter">Growth</th>
            <th title="ROCE, sales growth, margin steadiness">Quality</th>
            <th className="num">Value ₹ Cr</th>
            <th className="num">P/E</th>
            <th>Safety</th>
            <th className="sl-why">Why it&apos;s here</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.ticker}>
              <td className="num">{i + 1}</td>
              <td className="nano-col-name">
                <a className="nano-name" href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noreferrer">
                  {r.name}
                </a>
                <span className="nano-meta">
                  {r.ticker}
                  {r.market && r.market !== "NSE" ? <span>· {r.market}</span> : null}
                  <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                    NP
                  </a>
                  {websiteUrl(r.website) ? (
                    <a className="np-chip" href={websiteUrl(r.website)!} target="_blank" rel="noopener noreferrer" title={r.website ?? ""}>
                      Web
                    </a>
                  ) : null}
                  {r.zauba_url ? (
                    <a className="np-chip" href={r.zauba_url} target="_blank" rel="noopener noreferrer" title="Directors on Zaubacorp">
                      Board ↗
                    </a>
                  ) : null}
                </span>
                {r.sector ? (
                  <span className="mom-sector">
                    {r.sector}
                    {r.sub_sector ? ` › ${r.sub_sector}` : ""}
                  </span>
                ) : null}
                {r.themes.length || r.group || lvCur.has(r.ticker) || lvPast.has(r.ticker) ? (
                  <span className="sl-tags">
                    {lvCur.has(r.ticker) ? <span className="sl-tag sl-tag-lv">Listed Ventures holds</span> : null}
                    {lvPast.has(r.ticker) ? <span className="sl-tag sl-tag-lv past">Listed Ventures held</span> : null}
                    {r.themes.map((t) => (
                      <span key={t} className="sl-tag">
                        {themeLabel.get(t)}
                      </span>
                    ))}
                    {r.group ? <span className="sl-tag sl-tag-group">{r.group}</span> : null}
                  </span>
                ) : null}
              </td>
              <td className="num">
                <span className="mom-q">{scoreOf(r)}</span>
              </td>
              <td>
                <Bar
                  v={r.trust}
                  title={`${r.board} directors, ${r.independent} independent${r.linked_roce != null ? ` · their other boards average ${r.linked_roce}% ROCE` : ""}`}
                />
              </td>
              <td>
                <Bar
                  v={r.cheap}
                  title={r.pe != null && r.sector_pe != null ? `P/E ${r.pe.toFixed(1)} vs sector ${r.sector_pe}` : "No P/E"}
                />
              </td>
              <td>
                <Bar v={r.events} title={r.happenings.join(" · ") || "Nothing new"} />
              </td>
              <td>
                <Bar v={r.growth} title="Sales and profit on last year's quarter" />
              </td>
              <td>
                <Bar
                  v={r.quality}
                  title={[
                    r.roce != null ? `ROCE ${r.roce}%` : null,
                    r.sales_cagr_5y != null ? `5-yr sales ${r.sales_cagr_5y > 0 ? "+" : ""}${r.sales_cagr_5y}%/yr` : null,
                    r.opm_range ? `margins ${r.opm_range[0]}–${r.opm_range[1]}%` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "No data"}
                />
              </td>
              <td className="num">{num(r.mcap_cr)}</td>
              <td className="num">
                {num(r.pe, 1)}
                {r.sector_pe != null ? <span className="sl-sub">sector {r.sector_pe}</span> : null}
              </td>
              <td>
                <span className="mom-checks">
                  {r.checks.map((c) => (
                    <span key={c.id} className={`mom-ck ${c.ok === true ? "ok" : c.ok === false ? "bad" : "unk"}`} title={c.note}>
                      {c.ok === true ? "✓" : c.ok === false ? "✗" : "?"} {CHECK_LABEL[c.id]}
                    </span>
                  ))}
                </span>
              </td>
              <td className="sl-why">
                <ul>
                  <li>
                    Board {r.board} · {r.independent} independent
                    {r.big_links.length
                      ? ` · ${r.big_links.length} also on big boards (${r.big_links
                          .slice(0, 2)
                          .map((b) => `${b.name.split(" ")[0]} → ${b.board}`)
                          .join(", ")})`
                      : ""}
                  </li>
                  {r.smart.length ? (
                    <li className="sl-smart">
                      Smart money:{" "}
                      {r.smart
                        .map(
                          (s) =>
                            `${s.label}${s.pct != null ? ` ${s.pct.toFixed(1)}%` : ""}${s.move === "new" ? " (new)" : s.move === "up" ? " (added)" : s.move === "down" ? " (cut)" : ""}`,
                        )
                        .join(", ")}
                    </li>
                  ) : null}
                  {r.happenings.map((h) => (
                    <li key={h} className="sl-happen">
                      {h}
                    </li>
                  ))}
                  {r.red_flags.map((f) => (
                    <li key={f} className="sl-flag">
                      {f}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

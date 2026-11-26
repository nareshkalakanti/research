"use client";

import { useEffect, useMemo, useState } from "react";
import { napkinUrl, tradingviewUrl } from "@/lib/links";
import type { MmBase, MmResult, MmRow } from "@/lib/momentum-money";

type Data = (MmResult & { ok: true }) | { ok: false; error: string };

const CAPS = [0, 100, 300, 500, 1000, 2500, 5000, 10000, 25000];
const GAINS = [100, 150, 200, 300, 500];
type Exch = "all" | "nse" | "nsesme" | "bse" | "bsesme";
const EXCH: Array<[Exch, string]> = [
  ["all", "All"],
  ["nse", "NSE"],
  ["nsesme", "NSE SME"],
  ["bse", "BSE"],
  ["bsesme", "BSE SME"],
];
function exchOf(market: string): Exch {
  const m = market.toUpperCase();
  const sme = m.includes("SME") || m.includes("EMERGE");
  if (m.startsWith("BSE")) return sme ? "bsesme" : "bse";
  return sme ? "nsesme" : "nse";
}

const pct = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const cr = (v: number | null) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const day = (iso: string | null | undefined, withYear = false) =>
  iso
    ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        ...(withYear ? { year: "2-digit" } : {}),
        timeZone: "UTC",
      })
    : "—";
const listed = (iso: string | null) =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).replace(/\//g, "-") : "—";
const base = (b: MmBase | null) => (b ? `${Math.round(b.depth_pct)}/${b.weeks}W${b.open ? " (open)" : ""}` : "—");

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const r1 = (n: number | null) => (n == null ? "—" : String(Math.round(n * 10) / 10));

/** Winners table as CSV (opens in Excel). */
function exportCsv(year: number, rows: MmRow[]) {
  const head = ["Symbol", "Date of Listing", "YoY Change %", "Gains from 52wk Low %", "Industry", "Market Cap (Cr)", "Stage 4 Decline %", "Lockout rally %", "Period", "Base1", "Base2"];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map((r) =>
    [
      r.ticker,
      listed(r.listing_date),
      r.yoy_pct ?? "",
      r.gain_pct,
      r.industry ?? "",
      r.mcap_cr != null ? Math.round(r.mcap_cr) : "",
      r.study?.stage4_pct ?? "",
      r.study?.rally_pct ?? "",
      r.study ? `${day(r.study.rally_from, true)} - ${day(r.study.rally_to, true)}` : "",
      base(r.study?.base1 ?? null),
      base(r.study?.base2 ?? null),
    ]
      .map((v) => esc(String(v)))
      .join(","),
  );
  const blob = new Blob([[head.join(","), ...lines].join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `yearly-winners-${year}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The notes, each checked against this year's winners. */
function NotesTest({ rows }: { rows: MmRow[] }) {
  const st = rows.map((r) => r.study).filter((s): s is NonNullable<MmRow["study"]> => s != null);
  const n = st.length;
  const count = (f: (s: (typeof st)[number]) => boolean) => st.filter(f).length;
  const of = (k: number, d = n) => `${k} of ${d}`;
  const s4 = st.filter((s) => !s.short_history && s.stage4_pct != null);
  const s4x = s4.map((s) => s.stage4_x).filter((x): x is number => x != null);
  const b1 = st.map((s) => s.base1).filter((b): b is MmBase => b != null && !b.open);
  const b2 = st.map((s) => s.base2).filter((b): b is MmBase => b != null && !b.open);
  const bx = b1.filter((b) => b.nifty_pct != null && b.nifty_pct >= 1).map((b) => b.depth_pct / b.nifty_pct!);
  const g12 = st.filter((s) => s.green12 != null);
  const tests: Array<[string, string, string]> = [
    ["Depth of stage 4 decline", "40–50%", `${of(s4.filter((s) => s.stage4_pct! >= 40 && s.stage4_pct! <= 50).length, s4.length)} in range · median ${r1(median(s4.map((s) => s.stage4_pct!)))}%`],
    ["Stage 4 decline vs index decline", "2–2.5x", `${of(s4x.filter((x) => x >= 2 && x <= 2.5).length, s4x.length)} in range · median ${r1(median(s4x))}x`],
    ["Rise of lockout rally", "min 50% up move", `median +${r1(median(st.map((s) => s.rally_pct)))}%`],
    ["Period of lockout rally", "—", `median ${r1(median(st.map((s) => s.rally_weeks)))} weeks`],
    ["Urgency", "6/8 green weeks", `${of(count((s) => s.green8 >= 6))} (used to find the rally)`],
    ["Urgency", "9/12 green weeks", `${of(g12.filter((s) => s.green12! >= 9).length, g12.length)}`],
    ["Posts a 20% week move", "within the lockout rally", `${of(count((s) => s.big_weeks > 0))}`],
    ["Base pause", "4–12 weeks", `${of(b1.filter((b) => b.weeks >= 4 && b.weeks <= 12).length, b1.length)} base 1s`],
    ["Move up in week", "6–9", `${of(b1.filter((b) => b.weeks >= 6 && b.weeks <= 9).length, b1.length)} base 1s`],
    ["Base 1 depth", "15–25%", `${of(b1.filter((b) => b.depth_pct >= 15 && b.depth_pct <= 25).length, b1.length)} · median ${r1(median(b1.map((b) => b.depth_pct)))}%`],
    ["Base 2 depth", "15–25%", `${of(b2.filter((b) => b.depth_pct >= 15 && b.depth_pct <= 25).length, b2.length)} · median ${r1(median(b2.map((b) => b.depth_pct)))}%`],
    ["Base depth vs market pullback", "3x", `median ${r1(median(bx))}x`],
    ["Emerge from IPOs", "IPOs / mother theme", `${of(rows.filter((r) => r.ipo).length, rows.length)} listed within 3 years of the rally`],
  ];
  return (
    <table className="vx-table mm-table">
      <thead>
        <tr>
          <th>Note</th>
          <th>Notes say</th>
          <th>These winners</th>
        </tr>
      </thead>
      <tbody>
        {tests.map(([a, b, c], i) => (
          <tr key={i}>
            <td>{a}</td>
            <td className="mm-muted">{b}</td>
            <td>{c}</td>
          </tr>
        ))}
        <tr>
          <td>Early risers · Remain leaders · Crisp and calm bases · Mother theme</td>
          <td className="mm-muted">—</td>
          <td className="mm-muted">Not measured yet</td>
        </tr>
      </tbody>
    </table>
  );
}

function Sym({ r }: { r: MmRow }) {
  return (
    <span className="mm-sym">
      <a href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noopener noreferrer">
        {r.ticker}
      </a>
      {r.market !== "NSE" ? <span className="mm-exch">{r.market}</span> : null}
      <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
        NP
      </a>
    </span>
  );
}

/** Momentum and Money: yearly winners and the user's winner-study notes tested on them. */
export function MomentumMoneyPanel() {
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1);
  const [data, setData] = useState<Data | null>(null);
  const [minCap, setMinCap] = useState(300);
  const [maxCap, setMaxCap] = useState(0);
  const [minGain, setMinGain] = useState(200);
  const [exch, setExch] = useState<Exch>("nse");

  useEffect(() => {
    let live = true;
    void fetch(`/api/momentum-money?year=${year}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Data) => {
        if (live) setData(j);
      })
      .catch((e) => {
        if (live) setData({ ok: false, error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [year]);

  const rows = useMemo(
    () =>
      data?.ok
        ? data.rows.filter(
            (r) =>
              r.gain_pct >= minGain &&
              (minCap === 0 || (r.mcap_cr ?? 0) >= minCap) &&
              (maxCap === 0 || (r.mcap_cr != null && r.mcap_cr <= maxCap)) &&
              (exch === "all" || exchOf(r.market) === exch),
          )
        : [],
    [data, minGain, minCap, maxCap, exch],
  );
  const loading = !data || (data.ok && data.year !== year);

  return (
    <section className="vx mm">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">Yearly winners and what they had in common</span>
          <h2 className="vx-title">
            Momentum <span>and Money</span>
          </h2>
        </div>
      </header>

      <div className="mm-filters">
        <label className="vx-field">
          <span className="vx-label">Year</span>
          <select
            value={year}
            onChange={(e) => {
              setData(null);
              setYear(Number(e.target.value));
            }}
          >
            {(data?.ok ? data.years : [year]).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="vx-field">
          <span className="vx-label">Min market cap (₹ Cr)</span>
          <select value={minCap} onChange={(e) => setMinCap(Number(e.target.value))}>
            {CAPS.filter((v) => maxCap === 0 || v < maxCap).map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "Any" : v.toLocaleString("en-IN")}
              </option>
            ))}
          </select>
        </label>
        <label className="vx-field">
          <span className="vx-label">Max market cap (₹ Cr)</span>
          <select value={maxCap} onChange={(e) => setMaxCap(Number(e.target.value))}>
            {CAPS.filter((v) => v === 0 || v > minCap).map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "Any" : v.toLocaleString("en-IN")}
              </option>
            ))}
          </select>
        </label>
        <label className="vx-field">
          <span className="vx-label">Min gain %</span>
          <select value={minGain} onChange={(e) => setMinGain(Number(e.target.value))}>
            {GAINS.map((v) => (
              <option key={v} value={v}>
                {v}%
              </option>
            ))}
          </select>
        </label>
        <label className="vx-field">
          <span className="vx-label">Exchange</span>
          <select value={exch} onChange={(e) => setExch(e.target.value as Exch)}>
            {EXCH.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="mm-export" disabled={!rows.length} onClick={() => exportCsv(year, rows)}>
          Export to Excel
        </button>
      </div>

      {loading ? (
        <div className="vx-card vx-empty">Finding the {year} winners…</div>
      ) : !data.ok ? (
        <div className="vx-card vx-empty vx-msg--err">Could not load: {data.error}</div>
      ) : (
        <>
          <h3 className="mm-h">
            1. Yearly winners ({year}) <span>{rows.length} stocks with {minGain}%+ gains from the 52-week low</span>
          </h3>
          <div className="mm-wrap">
            <table className="vx-table mm-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Date of Listing</th>
                  <th className="num">YoY Change</th>
                  <th className="num">Gains from 52wk Low</th>
                  <th>Industry</th>
                  <th className="num">Market Cap (₹ Cr)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ticker}>
                    <td>
                      <Sym r={r} />
                    </td>
                    <td>{listed(r.listing_date)}</td>
                    <td className={`num ${r.yoy_pct != null && r.yoy_pct < 0 ? "neg" : ""}`}>{pct(r.yoy_pct)}</td>
                    <td className="num pos">{pct(r.gain_pct)}</td>
                    <td>{r.industry ?? "—"}</td>
                    <td className="num">{cr(r.mcap_cr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mm-h">
            2. Previous notes, tested on these winners <span>Know your winners · Deep dive outcome · Urgency</span>
          </h3>
          <div className="mm-wrap">
            <NotesTest rows={rows} />
          </div>

          <h3 className="mm-h">
            Winners – {year} <span>Stage 4 decline, lockout rally and bases for each</span>
          </h3>
          <div className="mm-wrap">
            <table className="vx-table mm-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Category</th>
                  <th className="num">Stage 4 Decline</th>
                  <th className="num">Lockout rally</th>
                  <th>Period</th>
                  <th>Base1</th>
                  <th>Base2</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s = r.study;
                  return (
                    <tr key={r.ticker}>
                      <td>
                        <Sym r={r} />
                      </td>
                      <td>{r.ipo ? <span className="mm-tag">IPO</span> : null}</td>
                      <td className="num">{s?.stage4_pct != null ? Math.round(s.stage4_pct) : "—"}</td>
                      <td className="num">{s ? Math.round(s.rally_pct) : "—"}</td>
                      <td>{s ? `${day(s.rally_from)} – ${day(s.rally_to)}` : "No lockout rally found"}</td>
                      <td>{base(s?.base1 ?? null)}</td>
                      <td>{base(s?.base2 ?? null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="vx-hint mm-foot">
            Gains from 52wk low: the year’s best close vs the lowest close of the 52 weeks before it (a rise, so stocks that only fell
            don’t count); YoY on that same day. From saved daily closes (no highs or lows), so base and decline depths read shallower than on candle charts. Market cap is
            today’s. Lockout rally: first 6/8-green-week run after the 52-week low that makes a 50%+ move, ending at the first pause of 4+
            weeks. Bases: pause from a high until a weekly close above it (depth / weeks). Stage 4 decline: highest close of the 2 years
            before the rally to the low after it. {data.nifty ? "" : "Nifty prices unavailable: index comparisons blank."}
          </p>
        </>
      )}
    </section>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FilterBar, MultiPick, PageHead, Pick, Seg } from "@/components/FilterBar";
import { Loading } from "@/components/Loading";
import { ModelView } from "@/components/ModelView";
import { SmartEntities } from "@/components/SmartEntities";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import type { NanoFillJob } from "@/lib/nanocap-champs";
import type { SmartPage, SmartRow } from "@/lib/smart-money-page";
import type { SmartHolding } from "@/lib/smart-money";

type Show = "all" | "bought" | "cut" | "multi";
type Mkt = "all" | "nse" | "bse" | "bsesme";
const mktOf = (m: string): Mkt => (m === "BSE" ? "bse" : m === "BSE SME" ? "bsesme" : "nse");

const MOVE: Record<NonNullable<SmartHolding["move"]>, { label: string; cls: string }> = {
  new: { label: "new", cls: "ok" },
  up: { label: "added", cls: "ok" },
  down: { label: "cut", cls: "bad" },
  exit: { label: "sold out", cls: "bad" },
  same: { label: "held", cls: "unk" },
};

function num(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

const bought = (h: SmartHolding) => h.move === "new" || h.move === "up";
const cut = (h: SmartHolding) => h.move === "down" || h.move === "exit";

/** Smart money: what six tracked investors hold and changed this quarter. */
export function SmartMoneyPanel() {
  const [page, setPage] = useState<SmartPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<NanoFillJob | null>(null);
  const [who, setWho] = useState<string[]>([]);
  const [show, setShow] = useState<Show>("all");
  const [mkt, setMkt] = useState<Mkt>("all");
  const [view, setView] = useState<"holdings" | "model">("holdings");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/smart-money", { cache: "no-store" });
      const json = (await res.json()) as SmartPage & { ok: boolean; error?: string; job: NanoFillJob | null };
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

  const running = job?.running && job.kind === "smartmoney";
  useEffect(() => {
    if (!running) return;
    let n = 0;
    const id = window.setInterval(async () => {
      try {
        const res = await fetch("/api/smart-money?job=1", { cache: "no-store" });
        const json = (await res.json()) as { job: NanoFillJob | null };
        setJob(json.job);
        // Reload the list now and then while it fills, and once at the end.
        n++;
        if (!json.job?.running || n % 10 === 0) void load();
      } catch {
        /* retry next tick */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [running, load]);

  const post = async (body: object) => {
    const res = await fetch("/api/smart-money", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { job: NanoFillJob | null };
    setJob(json.job);
  };

  const label = useMemo(() => new Map((page?.investors ?? []).map((i) => [i.id, i.label])), [page]);

  if (error && !page) return <div className="table-meta">Could not load: {error}</div>;
  if (!page) return <Loading label="Loading investor holdings" variant="block" />;

  // Restrict each row to the chosen investors, then apply the move filter.
  const pick = (r: SmartRow): SmartRow => (who.length ? { ...r, holders: r.holders.filter((h) => who.includes(h.investor)) } : r);
  const base = page.rows.map(pick).filter((r) => r.holders.length);
  const inMkt = base.filter((r) => mkt === "all" || mktOf(r.market) === mkt);
  const test: Record<Show, (r: SmartRow) => boolean> = {
    all: (r) => r.holders.some((h) => h.move !== "exit"),
    bought: (r) => r.holders.some(bought),
    cut: (r) => r.holders.some(cut),
    multi: (r) => r.holders.filter((h) => h.move !== "exit").length >= 2,
  };
  const rows = inMkt.filter(test[show]);
  const st = page.status;
  const mktCount = (id: Mkt) => (id === "all" ? base.length : base.filter((r) => mktOf(r.market) === id).length);

  return (
    <section className="nano-section sl-panel">
      <PageHead title="Smart money" sub="What tracked investors hold, and what they bought or cut this quarter.">
        <p>
          From NSE shareholding filings (every named holder over 1%, this quarter vs last) plus Trendlyne portfolio
          pages for Kacholia, Kela and Dolly Khanna (adds BSE stocks). Stakes under 1% are not disclosed, so they
          can&apos;t be seen. Each investor counts every name they file under — funds, family, investment companies —
          see “Manage investors”.
        </p>
        <p>
          <strong>Model</strong> scores every NSE stock at ₹100–6,000 Cr from 3 years of holder moves, and shows how it
          did on quarters it never saw.
        </p>
      </PageHead>

      <div className="sm-top">
        <Seg
          value={view}
          onChange={setView}
          options={[
            { id: "holdings", label: "Holdings" },
            { id: "model", label: "Model — whole universe" },
          ]}
        />
        {view === "holdings" ? <SmartEntities onChanged={() => void load()} /> : null}
      </div>

      {view === "model" ? (
        <ModelView />
      ) : (
        <>
      <FilterBar>
        <MultiPick
          label="Investors"
          allLabel="All investors"
          values={who}
          onChange={setWho}
          options={st.investors.map((i) => ({
            id: i.id,
            label: i.label,
            count: i.holds,
            title: `${i.note ? `${i.note} · ` : ""}${i.bought} bought or added this quarter`,
          }))}
        />
        <Seg
          label="Show"
          value={show}
          onChange={setShow}
          options={(
            [
              ["all", "All"],
              ["bought", "Bought / added"],
              ["multi", "2+ investors"],
              ["cut", "Cut / sold"],
            ] as const
          ).map(([id, label]) => ({ id, label, count: inMkt.filter(test[id]).length }))}
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
      </FilterBar>

      <div className="sl-status" role="status" aria-live="polite">
        <span>
          <strong>{rows.length.toLocaleString("en-IN")}</strong> stocks
          <span className="sl-sub-inline">
            {" "}
            · {st.nse.scanned.toLocaleString("en-IN")} of {st.nse.universe.toLocaleString("en-IN")} NSE filings read ·{" "}
            {st.nse.with_prev} with last quarter to compare
          </span>
        </span>
        {running ? (
          <span className="sl-fill">
            <span className="ld-spin" aria-hidden /> Reading filings {job!.done.toLocaleString("en-IN")} of{" "}
            {(job!.total || 0).toLocaleString("en-IN")}
            <button type="button" className="btn-ghost" onClick={() => void post({ stop: true })}>
              Stop
            </button>
          </span>
        ) : (
          <span className="sl-fill">
            {job?.kind === "smartmoney" && job.error ? job.error : null}
            <button
              type="button"
              className="btn-ghost"
              disabled={!!job?.running}
              onClick={() => void post({})}
              title="Trendlyne pages, then NSE filings not read in 20 days, then last quarter wherever these investors appear"
            >
              Refresh
            </button>
          </span>
        )}
      </div>

      {rows.length ? (
        <div className="table-wrap nano-wrap">
          <table className="data-table nano-table sl-table">
            <thead>
              <tr>
                <th className="nano-col-name">Stock</th>
                <th className="num" title="More tracked investors and fresh buying score higher">
                  Smart
                </th>
                <th>Investors · stake · this quarter</th>
                <th className="num">Value ₹ Cr</th>
                <th className="num">P/E</th>
                <th title="Board trust from the Shortlist (— = not in the Shortlist's ₹100–6,000 Cr screen)">Trust</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticker}>
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
                      {r.trust == null && r.zauba_url ? (
                        <a className="np-chip" href={r.zauba_url} target="_blank" rel="noopener noreferrer" title="Board not scored — check directors on Zaubacorp">
                          ? Board ↗
                        </a>
                      ) : null}
                    </span>
                    {r.sector ? (
                      <span className="mom-sector">
                        {r.sector}
                        {r.sub_sector ? ` › ${r.sub_sector}` : ""}
                      </span>
                    ) : null}
                  </td>
                  <td className="num">
                    <span className="mom-q">{r.smart}</span>
                  </td>
                  <td>
                    <span className="sm-holders">
                      {r.holders.map((h) => {
                        const mv = h.move ? MOVE[h.move] : null;
                        const delta =
                          h.pct != null && h.prev_pct != null && (h.move === "up" || h.move === "down")
                            ? ` (${h.move === "up" ? "+" : ""}${(h.pct - h.prev_pct).toFixed(2)})`
                            : "";
                        return (
                          <span
                            key={h.investor}
                            className={`sm-holder ${mv?.cls ?? "unk"}`}
                            title={`${label.get(h.investor)} · ${h.source === "nse" ? `NSE filing ${h.as_of}` : `Trendlyne, fetched ${h.as_of}`}${h.prev_pct != null ? ` · last quarter ${h.prev_pct.toFixed(2)}%` : ""}`}
                          >
                            <b>{label.get(h.investor)}</b> {h.move === "exit" ? "" : `${h.pct != null ? h.pct.toFixed(2) : "?"}%`}
                            {mv ? ` · ${mv.label}${delta}` : " · no last quarter yet"}
                          </span>
                        );
                      })}
                    </span>
                  </td>
                  <td className="num">{num(r.mcap_cr)}</td>
                  <td className="num">{num(r.pe, 1)}</td>
                  <td>{r.trust == null ? "—" : <span className="mom-q">{r.trust}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="miq-empty-hint">None with these filters.</p>
      )}
        </>
      )}
    </section>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import type { PeopleStatus, PullResult } from "@/lib/screener-people";

/** Watchlist: the Screener investor / fund pages that keep the fund lists up to date. */
export function FundPagesBar() {
  const [st, setSt] = useState<PeopleStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/fund-people", { cache: "no-store" });
      const json = (await res.json()) as PeopleStatus & { ok: boolean };
      if (json.ok) setSt(json);
    } catch {
      /* retry on next open */
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const update = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/fund-people", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const json = (await res.json()) as PeopleStatus & { ok: boolean; error?: string; results?: PullResult[] };
      if (json.ok) {
        setSt(json);
        const ok = (json.results ?? []).filter((r) => !r.error);
        const bad = (json.results ?? []).filter((r) => r.error);
        setMsg(
          `${ok.length} pages updated · ${ok.reduce((n, r) => n + r.added, 0)} stocks added · ${ok.reduce((n, r) => n + r.removed, 0)} removed` +
            (bad.length ? ` · ${bad.length} failed: ${bad[0]!.error}` : ""),
        );
      } else setMsg(json.error ?? "Update failed");
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;
  const last = st.sources.map((s) => s.last_pulled).filter((x): x is string => !!x).sort().at(-1);
  const errors = st.sources.filter((s) => s.last_error).length;
  return (
    <div className="fund-pages">
      <div className="fund-pages-head">
        <strong>Investor pages (Screener)</strong>
        <span className="sl-sub">
          {st.sources.length} pages →{" "}
          {new Set(st.sources.map((s) => s.list_key)).size} fund lists ·{" "}
          {last ? `updated ${new Date(last).toLocaleString("en-IN")}` : "not updated yet"}
          {errors ? ` · ${errors} with errors` : ""} · updates daily by itself
        </span>
        <button type="button" className="btn-fill" disabled={busy || !st.login} onClick={() => void update()}>
          {busy ? "Updating…" : "Update now"}
        </button>
        <button type="button" className="btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide pages" : "Show pages"}
        </button>
      </div>
      {!st.login ? (
        <p className="sm-warn">
          Screener only shows these pages when you&apos;re logged in. Log in at screener.in, then copy the{" "}
          <code>sessionid</code> cookie (browser DevTools → Application → Cookies → screener.in) into{" "}
          <code>.env.local</code> as <code>SCREENER_SESSIONID=…</code> and reload this page.
        </p>
      ) : null}
      {msg ? <p className="table-meta">{msg}</p> : null}
      {open ? (
        <ul className="fund-pages-list">
          {st.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {decodeURIComponent(s.url.replace(/^https:\/\/www\.screener\.in\/people\/\d+\//, "").replace(/\/$/, "")).replace(/-/g, " ")}
              </a>
              <span className="sl-sub">
                → list “{s.label}” ·{" "}
                {s.last_pulled ? `${s.last_count ?? 0} stocks, ${new Date(s.last_pulled).toLocaleDateString("en-IN")}` : "not pulled yet"}
              </span>
              {s.last_error ? <span className="sl-flag-text">{s.last_error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

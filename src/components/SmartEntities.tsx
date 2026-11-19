"use client";

import { useCallback, useEffect, useState } from "react";
import type { Entity, Investor } from "@/lib/smart-entities";

type Data = { investors: Investor[]; entities: Entity[] };

/** Investor entity model editor: names each investor files under, with the model's suggestions. */
export function SmartEntities({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newInv, setNewInv] = useState("");
  const [adding, setAdding] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/smart-money/entities", { cache: "no-store" });
    const json = (await res.json()) as Data & { ok: boolean; error?: string };
    if (json.ok) setData(json);
    else setMsg(json.error ?? "Could not load");
  }, []);

  useEffect(() => {
    if (!open || data) return;
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [open, data, load]);

  const post = async (body: object, label: string) => {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch("/api/smart-money/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        results?: Record<string, { suggested?: number; rejected?: number; error?: string }>;
      };
      if (!json.ok) setMsg(json.error ?? "Failed");
      else if (json.results) {
        const parts = Object.entries(json.results).map(([k, r]) =>
          r.error ? `${k}: ${r.error}` : `${k}: ${r.suggested ?? 0} to review`,
        );
        setMsg(`Model looked again — ${parts.join(" · ")}`);
      }
      await load();
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const kindLabel = (k: string | null) => (k ? ` · ${k}` : "");

  return (
    <div className="sm-ent">
      <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Manage"} investors &amp; their names
      </button>
      {open ? (
        <div className="sm-ent-body">
          <p className="nano-note">
            Each investor files under several names — funds, family members, investment companies. Only
            <strong> confirmed</strong> names count. <strong>Find more names</strong> runs the model: it picks names
            that share a rare word with the investor or keep turning up in the same companies, then the LLM judges them.
            Accept or reject each suggestion.
          </p>
          <div className="sm-ent-actions">
            <button type="button" className="btn-fill" disabled={!!busy} onClick={() => void post({ action: "suggest" }, "all")}>
              {busy === "all" ? "Looking…" : "Find more names (all investors)"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={!!busy}
              onClick={() => void post({ action: "clear" }, "clear")}
              title="Remove the model's unconfirmed suggestions and rejections so it can look again"
            >
              Clear suggestions
            </button>
            <form
              className="sm-ent-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (newInv.trim().length < 2) return;
                void post({ action: "add_investor", label: newInv.trim() }, "inv").then(() => setNewInv(""));
              }}
            >
              <input
                className="fam-dash-search"
                placeholder="Add an investor (e.g. Vijay Kedia)"
                value={newInv}
                onChange={(e) => setNewInv(e.target.value)}
                aria-label="New investor name"
              />
              <button type="submit" className="btn-ghost" disabled={!!busy || newInv.trim().length < 2}>
                Add
              </button>
            </form>
          </div>
          {msg ? <p className="table-meta">{msg}</p> : null}
          {!data ? (
            <p className="table-meta">Loading…</p>
          ) : (
            <div className="sm-ent-grid">
              {data.investors.map((inv) => {
                const mine = data.entities.filter((e) => e.investor_id === inv.id);
                const confirmed = mine.filter((e) => e.status === "confirmed");
                const suggested = mine.filter((e) => e.status === "suggested");
                const rejected = mine.filter((e) => e.status === "rejected").length;
                return (
                  <section key={inv.id} className="sm-ent-card">
                    <header>
                      <strong>{inv.label}</strong>
                      {inv.note ? <span className="sl-sub">{inv.note}</span> : null}
                      {inv.tl_portfolio_id ? <span className="sl-sub">+ Trendlyne portfolio page</span> : null}
                    </header>
                    <ul className="sm-ent-list">
                      {confirmed.map((e) => (
                        <li key={e.id}>
                          <span className={e.match_type === "pattern" ? "mono sm-pat" : ""} title={e.match_type === "pattern" ? "Pattern: matches every spelling of this" : undefined}>
                            {e.match_type === "pattern" ? `≈ ${e.name}` : e.name}
                          </span>
                          <span className="sl-sub">
                            {e.holds != null ? `${e.holds} co.` : ""}
                            {kindLabel(e.kind)}
                          </span>
                          <button
                            type="button"
                            className="gov-family-chip-x"
                            title="Remove this name"
                            disabled={!!busy}
                            onClick={() => void post({ action: "status", id: e.id, status: "delete" }, `d${e.id}`)}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                    {suggested.length ? (
                      <ul className="sm-ent-list sm-ent-sugg">
                        {suggested.map((e) => (
                          <li key={e.id} title={e.reason ?? ""}>
                            <span>
                              {e.name}
                              <span className="sl-sub">{e.reason}</span>
                            </span>
                            <span className="sm-ent-btns">
                              <button
                                type="button"
                                className="chip on"
                                disabled={!!busy}
                                onClick={() => void post({ action: "status", id: e.id, status: "confirmed" }, `c${e.id}`)}
                              >
                                Accept
                              </button>
                              <button
                                type="button"
                                className="chip"
                                disabled={!!busy}
                                onClick={() => void post({ action: "status", id: e.id, status: "rejected" }, `r${e.id}`)}
                              >
                                Reject
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <form
                      className="sm-ent-add"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = (adding[inv.id] ?? "").trim();
                        if (name.length < 3) return;
                        void post({ action: "add_entity", investor: inv.id, name }, `a${inv.id}`).then(() =>
                          setAdding((m) => ({ ...m, [inv.id]: "" })),
                        );
                      }}
                    >
                      <input
                        className="fam-dash-search"
                        placeholder="Add a name they file under"
                        value={adding[inv.id] ?? ""}
                        onChange={(e) => setAdding((m) => ({ ...m, [inv.id]: e.target.value }))}
                        aria-label={`Add a name for ${inv.label}`}
                      />
                      <button type="submit" className="btn-ghost" disabled={!!busy}>
                        Add
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={!!busy}
                        onClick={() => void post({ action: "suggest", investor: inv.id }, `s${inv.id}`)}
                      >
                        {busy === `s${inv.id}` ? "Looking…" : "Find more"}
                      </button>
                    </form>
                    {rejected ? <p className="sl-sub">{rejected} names the model ruled out</p> : null}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { TickerSuggest, type TickerSuggestHit } from "@/components/TickerSuggest";

type Seat = {
  person_id: string;
  din: string | null;
  name: string;
  designation: string;
  source: string;
};

export function GovernanceDinCrud({ onChanged }: { onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [tickerQ, setTickerQ] = useState("");
  const [hit, setHit] = useState<TickerSuggestHit | null>(null);
  const [dinText, setDinText] = useState("");
  const [directorName, setDirectorName] = useState("");
  const [seats, setSeats] = useState<Seat[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ticker = (hit?.ticker || tickerQ).trim().toUpperCase();

  const loadSeats = useCallback(async (sym: string) => {
    if (!sym) {
      setSeats([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/governance-board?ticker=${encodeURIComponent(sym)}`,
      );
      const json = (await res.json()) as { ok?: boolean; seats?: Seat[] };
      setSeats(json.seats ?? []);
    } catch {
      setSeats([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadSeats(ticker);
  }, [open, ticker, loadSeats]);

  const add = async () => {
    if (!ticker) {
      setError("Pick a ticker");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/governance-board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          name: hit?.name || ticker,
          market: hit?.market || null,
          dins: dinText,
          directorName,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        seats?: Seat[];
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || "Could not add DIN");
      }
      setSeats(json.seats ?? []);
      setDinText("");
      setDirectorName("");
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add DIN");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (personId: string) => {
    if (!ticker) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/governance-board?ticker=${encodeURIComponent(ticker)}&personId=${encodeURIComponent(personId)}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        seats?: Seat[];
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || "Could not remove");
      }
      setSeats(json.seats ?? []);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gov-din-crud">
      <button
        type="button"
        className={`chip tag-chip${open ? " on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Manually add or remove DINs on a stock board"
      >
        Add DIN
      </button>
      {open ? (
        <div className="gov-din-crud-box">
          <div className="gov-din-crud-row">
            <TickerSuggest
              value={tickerQ}
              onChange={(v) => {
                setTickerQ(v);
                setHit(null);
              }}
              onSelect={(sel) => {
                setHit(sel);
                setTickerQ(sel.ticker);
              }}
              placeholder="Ticker or company (Groww if missing)…"
              className="theme-stock-suggest-input"
            />
            <input
              className="miq-search"
              placeholder="DIN (8 digits, several ok)"
              value={dinText}
              onChange={(e) => setDinText(e.target.value)}
            />
            <input
              className="miq-search"
              placeholder="Director name (if new DIN)"
              value={directorName}
              onChange={(e) => setDirectorName(e.target.value)}
            />
            <button
              type="button"
              className="btn-ghost"
              disabled={busy || !ticker}
              onClick={() => void add()}
            >
              {busy ? "…" : "Add"}
            </button>
          </div>
          {error ? (
            <p className="hint tight" role="alert">
              {error}
            </p>
          ) : null}
          {ticker ? (
            <ul className="gov-din-crud-list">
              {seats.length === 0 ? (
                <li className="muted">No board seats on file for {ticker}.</li>
              ) : (
                seats.map((s) => (
                  <li key={s.person_id}>
                    <span>
                      {s.name}
                      {s.din ? ` · ${s.din}` : ""}
                      {s.designation ? ` · ${s.designation}` : ""}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() => void remove(s.person_id)}
                    >
                      Remove
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

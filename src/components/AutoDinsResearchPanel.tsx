"use client";

import { useCallback, useState } from "react";
import {
  TickerSuggest,
  type TickerSuggestHit,
} from "@/components/TickerSuggest";
import { notifyGovMapChanged } from "@/lib/gov-map-sync";

type Seat = {
  din: string;
  name: string;
  designation: string;
  category?: string;
  source?: string;
};

type SourceLog = {
  source: string;
  ok: boolean;
  seats: number;
  detail?: string;
  url?: string;
};

export function AutoDinsResearchPanel() {
  const [ticker, setTicker] = useState("");
  const [company, setCompany] = useState("");
  const [listingName, setListingName] = useState<string | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [pdfs, setPdfs] = useState<string[]>([]);
  const [logs, setLogs] = useState<SourceLog[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedWhy, setSavedWhy] = useState<string | null>(null);

  const runPreview = useCallback(async (sym: string) => {
    const t = sym.trim().toUpperCase();
    if (!t) {
      setError("Pick an NSE/BSE symbol");
      return;
    }
    setBusy(true);
    setError(null);
    setSavedWhy(null);
    setStatus(`Resolving ${t} → NSE CG → MCA → filings…`);
    setSeats([]);
    setPdfs([]);
    setLogs([]);
    try {
      const res = await fetch("/api/auto-dins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", ticker: t }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        ticker?: string;
        company?: string;
        seats?: Seat[];
        pdfs?: string[];
        logs?: SourceLog[];
        why?: string;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setTicker((json.ticker || t).toUpperCase());
      setCompany(json.company || "");
      setListingName(json.company || null);
      setSeats(json.seats || []);
      setPdfs(json.pdfs || []);
      setLogs(json.logs || []);
      setStatus(json.why || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const approve = useCallback(async () => {
    if (!ticker.trim() || !seats.length) return;
    setBusy(true);
    setError(null);
    setSavedWhy(null);
    try {
      const res = await fetch("/api/auto-dins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          ticker,
          company,
          seats,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        why?: string;
        ticker?: string;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setSavedWhy(json.why || `Saved ${seats.length} DIN seats`);
      if (json.ticker) setTicker(json.ticker.toUpperCase());
      notifyGovMapChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [company, seats, ticker]);

  const canSave = seats.length > 0 && Boolean(ticker.trim());

  return (
    <div className="buyback-research-panel din-fill-panel">
      <p className="buyback-status">
        Pull current board DINs from NSE corporate governance filings, enrich
        names from MCA / director directories (authoritative DIN master data),
        then fill gaps from annual-report PDFs. Review before saving.
      </p>

      <div className="din-fill-split">
        <div className="din-fill-approve">
          <div className="buyback-result-card din-fill-review">
            <div className="din-fill-review-form">
              <label className="din-fill-field">
                <span>NSE symbol</span>
                <TickerSuggest
                  value={ticker}
                  disabled={busy}
                  placeholder="Ticker or company"
                  onChange={(t) => {
                    setTicker(t.toUpperCase());
                    setSavedWhy(null);
                  }}
                  onSelect={(hit: TickerSuggestHit) => {
                    setTicker(hit.ticker.toUpperCase());
                    setListingName(hit.name);
                    setCompany(hit.name);
                    setSavedWhy(null);
                    void runPreview(hit.ticker);
                  }}
                />
              </label>
              {listingName || company ? (
                <p className="din-fill-listing">{listingName || company}</p>
              ) : null}
              <div className="din-fill-actions">
                <button
                  type="button"
                  className="din-fill-btn din-fill-btn-quiet"
                  disabled={busy || !ticker.trim()}
                  onClick={() => void runPreview(ticker)}
                >
                  {busy ? "Reading…" : "Fetch DINs"}
                </button>
                <button
                  type="button"
                  className="din-fill-btn"
                  disabled={busy || !canSave}
                  onClick={() => void approve()}
                >
                  Approve & save
                </button>
              </div>
              {status ? <p className="buyback-status">{status}</p> : null}
              {error ? <p className="buyback-error">{error}</p> : null}
              {savedWhy ? <p className="din-fill-saved">{savedWhy}</p> : null}
            </div>

            {seats.length ? (
              <ul className="din-fill-seats">
                {seats.map((s) => (
                  <li key={s.din}>
                    {s.din} · {s.name}
                    {s.designation ? ` · ${s.designation}` : ""}
                    {s.source ? ` · ${s.source}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <div className="din-paste-well" style={{ cursor: "default" }}>
          <div className="buyback-status" style={{ padding: "0.75rem 1rem" }}>
            <strong>Sources</strong>
            {!logs.length ? (
              <p className="table-meta">
                No sources yet — NSE CG, MCA registry, then filing PDFs.
              </p>
            ) : (
              <ul className="din-fill-seats">
                {logs.map((l, i) => (
                  <li key={`${l.source}-${l.url || i}`}>
                    {l.ok ? "✓" : "✗"} {l.source} · {l.seats} DIN
                    {l.detail ? ` · ${l.detail}` : ""}
                    {l.url ? (
                      <>
                        {" · "}
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {l.url.replace(/^https?:\/\//, "").slice(0, 56)}
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {pdfs.length ? (
              <p className="table-meta" style={{ marginTop: "0.75rem" }}>
                {pdfs.length} filing PDF(s) scanned
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

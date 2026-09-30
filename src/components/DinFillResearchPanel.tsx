"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notifyGovMapChanged } from "@/lib/gov-map-sync";
import { TickerSuggest } from "@/components/TickerSuggest";

type Seat = { din: string; name: string; designation: string };

function fileFromClipboard(e: ClipboardEvent | React.ClipboardEvent): File | null {
  const items =
    "clipboardData" in e && e.clipboardData
      ? [...e.clipboardData.items]
      : [];
  const item = items.find((i) => i.type.startsWith("image/"));
  return item?.getAsFile() ?? null;
}

export function DinFillResearchPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [company, setCompany] = useState("");
  const [ticker, setTicker] = useState("");
  const [listingName, setListingName] = useState<string | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [savedWhy, setSavedWhy] = useState<string | null>(null);
  const wellRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<string | null>(null);
  const fileRef = useRef<File | null>(null);
  const resolveTimer = useRef<number | null>(null);

  useEffect(() => {
    wellRef.current?.focus();
  }, []);

  const sendImage = useCallback(async (file: File) => {
    fileRef.current = file;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPreview(url);
    setBusy(true);
    setError(null);
    setSavedWhy(null);
    setStatus("Reading screenshot…");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("action", "preview");
      const res = await fetch("/api/din-fill", { method: "POST", body: form });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        ticker?: string | null;
        listing_name?: string | null;
        company_extracted?: string | null;
        seats?: Seat[];
        why?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error || "Extract failed");
      setSeats(json.seats ?? []);
      setCompany(json.company_extracted ?? "");
      setTicker((json.ticker || "").toUpperCase());
      setListingName(json.listing_name ?? null);
      setStatus(json.why || "Review and approve to save.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extract failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const resolveCompany = useCallback(async (name: string, hint?: string) => {
    const q = name.trim();
    if (q.length < 3 && !(hint || "").trim()) return;
    try {
      const res = await fetch("/api/din-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "resolve",
          company: q,
          ticker: hint || "",
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        ticker?: string | null;
        listing_name?: string | null;
        why?: string;
      };
      if (!res.ok || !json.ok) return;
      if (json.ticker) setTicker(json.ticker.toUpperCase());
      setListingName(json.listing_name ?? null);
      if (json.why) setStatus(json.why);
    } catch {
      /* keep current ticker */
    }
  }, []);

  const onCompanyChange = useCallback(
    (value: string) => {
      setCompany(value);
      setSavedWhy(null);
      if (resolveTimer.current) window.clearTimeout(resolveTimer.current);
      resolveTimer.current = window.setTimeout(() => {
        void resolveCompany(value);
      }, 450);
    },
    [resolveCompany],
  );

  const approve = useCallback(async () => {
    if (!seats.length) return;
    setBusy(true);
    setError(null);
    setStatus("Saving…");
    try {
      const res = await fetch("/api/din-fill", {
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
        ticker?: string;
        why?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error || "Save failed");
      if (json.ticker) setTicker(json.ticker.toUpperCase());
      setSavedWhy(json.why || "Saved");
      setStatus(json.why || "Saved");
      notifyGovMapChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [company, seats, ticker]);

  useEffect(() => {
    function onDocPaste(e: ClipboardEvent) {
      const file = fileFromClipboard(e);
      if (!file) return;
      e.preventDefault();
      void sendImage(file);
    }
    window.addEventListener("paste", onDocPaste);
    return () => window.removeEventListener("paste", onDocPaste);
  }, [sendImage]);

  const canSave = seats.length > 0 && Boolean(ticker.trim());

  return (
    <div className="buyback-research-panel din-fill-panel">
      <p className="buyback-status">
        Paste a Zauba Current Directors screenshot. Review the company and
        listing, then approve to save. Rescan re-reads the same image.
      </p>

      <div
        ref={wellRef}
        className={`din-paste-well${dragOver ? " is-drag" : ""}${busy ? " is-busy" : ""}`}
        tabIndex={0}
        role="button"
        onClick={() => wellRef.current?.focus()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file?.type.startsWith("image/")) void sendImage(file);
        }}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="din-paste-preview" src={preview} alt="" />
        ) : (
          <div className="din-paste-hint">
            <strong>Paste screenshot here</strong>
            <span>⌘V · Ctrl+V · or drop an image</span>
            <label className="din-paste-upload">
              Choose file
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void sendImage(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        )}
        {busy ? <p className="din-paste-busy">Reading…</p> : null}
      </div>

      {status ? <p className="buyback-status">{status}</p> : null}
      {error ? <p className="buyback-error">{error}</p> : null}

      {seats.length ? (
        <div className="buyback-result-card din-fill-review">
          <label className="din-fill-field">
            <span>Company in image</span>
            <input
              className="buyback-url-input"
              value={company}
              disabled={busy}
              onChange={(e) => onCompanyChange(e.target.value)}
              placeholder="Correct the extracted company name"
            />
          </label>
          <label className="din-fill-field">
            <span>Save on listing</span>
            <TickerSuggest
              value={ticker}
              disabled={busy}
              placeholder="Ticker or company"
              onChange={(t) => {
                setTicker(t.toUpperCase());
                setSavedWhy(null);
              }}
              onSelect={(hit) => {
                setTicker(hit.ticker.toUpperCase());
                setListingName(hit.name);
                setSavedWhy(null);
              }}
            />
          </label>
          {listingName ? (
            <p className="din-fill-listing">{listingName}</p>
          ) : null}
          <div className="din-fill-actions">
            <button
              type="button"
              className="din-fill-btn din-fill-btn-quiet"
              disabled={busy || !fileRef.current}
              onClick={() => fileRef.current && void sendImage(fileRef.current)}
            >
              Rescan
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
          {savedWhy ? <p className="din-fill-saved">{savedWhy}</p> : null}
          <ul>
            {seats.map((s) => (
              <li key={s.din}>
                {s.din} · {s.name} · {s.designation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  const [extracted, setExtracted] = useState<{
    ticker?: string;
    company: string | null;
    seats: Seat[];
    why: string;
  } | null>(null);
  const wellRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<string | null>(null);

  useEffect(() => {
    wellRef.current?.focus();
  }, []);

  const sendImage = useCallback(async (file: File) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPreview(url);
    setBusy(true);
    setError(null);
    setStatus("Reading screenshot…");
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/din-fill", { method: "POST", body: form });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        ticker?: string;
        company_extracted?: string | null;
        seats?: Seat[];
        why?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error || "Extract failed");
      setExtracted({
        ticker: json.ticker,
        company: json.company_extracted ?? null,
        seats: json.seats ?? [],
        why: json.why || "Saved",
      });
      setStatus(json.why || "Saved");
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extract failed");
    } finally {
      setBusy(false);
    }
  }, []);

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

  return (
    <div className="buyback-research-panel din-fill-panel">
      <p className="buyback-status">
        Paste a Zauba Current Directors screenshot. Company name in the image
        is matched to a ticker (Groww if it is not in the DB yet) and DINs are
        saved on that listing.
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

      {extracted ? (
        <div className="buyback-result-card">
          <p>
            Company in image: <strong>{extracted.company || "—"}</strong>
            {extracted.ticker ? (
              <>
                {" "}
                → saved on <strong>{extracted.ticker}</strong>
              </>
            ) : null}
          </p>
          <p>{extracted.why}</p>
          <ul>
            {extracted.seats.map((s) => (
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

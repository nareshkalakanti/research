"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Job = {
  ticker: string;
  name: string;
  market: string;
  zauba_query: string;
  zauba_google: string;
  zauba_site: string;
};

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
  const [current, setCurrent] = useState<Job | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [queue, setQueue] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [extracted, setExtracted] = useState<{
    company: string | null;
    seats: Seat[];
    why: string;
  } | null>(null);
  const wellRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef(current);
  const previewRef = useRef<string | null>(null);
  currentRef.current = current;

  const load = useCallback(async () => {
    const res = await fetch("/api/din-fill", { cache: "no-store" });
    const json = (await res.json()) as {
      current?: Job | null;
      remaining?: number;
      queue?: Job[];
    };
    if (res.ok) {
      setCurrent(json.current ?? null);
      setRemaining(json.remaining ?? 0);
      setQueue(json.queue ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    wellRef.current?.focus();
  }, [current?.ticker]);

  const sendImage = useCallback(
    async (file: File) => {
      const job = currentRef.current;
      if (!job) return;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      const url = URL.createObjectURL(file);
      previewRef.current = url;
      setPreview(url);
      setBusy(true);
      setError(null);
      setStatus("Reading screenshot…");
      try {
        const form = new FormData();
        form.set("ticker", job.ticker);
        form.set("file", file);
        const res = await fetch("/api/din-fill", { method: "POST", body: form });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          company_extracted?: string | null;
          seats?: Seat[];
          why?: string;
          current?: Job | null;
          remaining?: number;
          queue?: Job[];
        };
        if (!res.ok || !json.ok) throw new Error(json.error || "Extract failed");
        setExtracted({
          company: json.company_extracted ?? null,
          seats: json.seats ?? [],
          why: json.why || "Saved",
        });
        setStatus(json.why || "Saved");
        setCurrent(json.current ?? null);
        setRemaining(json.remaining ?? 0);
        setQueue(json.queue ?? []);
        setPreview(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Extract failed");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    function onDocPaste(e: ClipboardEvent) {
      const file = fileFromClipboard(e);
      if (!file || !currentRef.current) return;
      e.preventDefault();
      void sendImage(file);
    }
    window.addEventListener("paste", onDocPaste);
    return () => window.removeEventListener("paste", onDocPaste);
  }, [sendImage]);

  function skip() {
    if (queue.length < 2) return;
    const rest = queue.slice(1);
    setCurrent(rest[0] ?? null);
    setQueue(rest);
    setExtracted(null);
    setPreview(null);
    setStatus("Skipped this name — still missing until a screenshot is saved.");
  }

  async function scanTickers(tickers: string[], label: string) {
    if (!tickers.length) return;
    setBusy(true);
    setError(null);
    setStatus(`${label}…`);
    try {
      const web = await fetch("/api/governance-web-din", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tickers,
          limit: tickers.length,
          missingOnly: true,
        }),
      });
      const webJson = (await web.json()) as {
        ok?: boolean;
        saved?: number;
        message?: string;
        error?: string;
      };
      if (!web.ok) throw new Error(webJson.error || "Web DIN scan failed");
      let msg = webJson.message || "Web DIN done";
      if (!(webJson.saved ?? 0)) {
        const nse = await fetch("/api/governance-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tickers,
            limit: tickers.length,
            missingOnly: true,
          }),
        });
        const nseJson = (await nse.json()) as {
          ok?: boolean;
          saved?: number;
          message?: string;
          error?: string;
        };
        if (!nse.ok) throw new Error(nseJson.error || "NSE DIN scan failed");
        msg = `${msg} · ${nseJson.message || "NSE scan done"}`;
      }
      setStatus(msg);
      setExtracted(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="buyback-research-panel din-fill-panel">
      <p className="buyback-status">
        One missing board at a time. <strong>Scan</strong> tries web + NSE DINs
        for this name; or paste a Zauba screenshot (⌘V) into the box.
      </p>

      {current ? (
        <>
          <p className="buyback-status">
            <strong>{remaining.toLocaleString()}</strong> still missing · now{" "}
            <strong>{current.ticker}</strong> · {current.name}
          </p>
          <p className="buyback-status">
            Search: <code>{current.zauba_query}</code>
          </p>
          <div className="buyback-input-row">
            <a
              className="chip tag-chip"
              href={current.zauba_google}
              target="_blank"
              rel="noopener noreferrer"
            >
              Google · zauba corp
            </a>
            <a
              className="chip tag-chip"
              href={current.zauba_site}
              target="_blank"
              rel="noopener noreferrer"
            >
              Zauba search
            </a>
            <button
              type="button"
              className={`chip chip-scan tag-chip${busy ? " busy" : ""}`}
              disabled={busy}
              onClick={() =>
                void scanTickers([current.ticker], `Scan ${current.ticker}`)
              }
              title="Web DIN then NSE board fetch for this ticker"
            >
              {busy ? "…" : "Scan"}
            </button>
            <button
              type="button"
              className="chip chip-scan tag-chip"
              disabled={busy || queue.length === 0}
              onClick={() =>
                void scanTickers(
                  queue.slice(0, 8).map((j) => j.ticker),
                  "Scan next 8",
                )
              }
              title="Web DIN then NSE for the next 8 missing boards"
            >
              Scan 8
            </button>
            <button
              type="button"
              className="chip tag-chip"
              disabled={busy || queue.length < 2}
              onClick={skip}
            >
              Skip
            </button>
          </div>

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
        </>
      ) : (
        <p className="buyback-status">No missing DIN boards in the NSE queue.</p>
      )}

      {status ? <p className="buyback-status">{status}</p> : null}
      {error ? <p className="buyback-error">{error}</p> : null}

      {extracted ? (
        <div className="buyback-result-card">
          <p>
            Company in image: <strong>{extracted.company || "—"}</strong>
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

      {queue.length > 1 ? (
        <p className="buyback-status">
          Next: {queue.slice(1, 6).map((j) => j.ticker).join(" · ")}
          {queue.length > 6 ? " …" : ""}
        </p>
      ) : null}
    </div>
  );
}

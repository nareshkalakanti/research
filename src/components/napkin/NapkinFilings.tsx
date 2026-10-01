"use client";

import { useState } from "react";
import { analyseNapkinPdf, type NapkinExtractHit } from "@/lib/napkin/client";
import { napkinDocumentCollection } from "@/lib/napkin/doc-collection";
import type { NapkinFiling, NapkinPdfPage } from "@/lib/napkin/types";

export function NapkinFilings({
  filings,
  extracts = [],
}: {
  filings: NapkinFiling[];
  extracts?: NapkinExtractHit[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    title: string;
    pages: NapkinPdfPage[];
    note: string;
  } | null>(null);

  const slots = napkinDocumentCollection(filings);

  const onAnalyse = async (url: string) => {
    setBusy(url);
    setError(null);
    try {
      const doc = await analyseNapkinPdf(url);
      setPreview({
        title: doc.title,
        pages: doc.preview.length ? doc.preview : doc.pages.slice(0, 3),
        note: doc.qwen,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="napkin-filings">
      <div className="napkin-table-wrap">
        <table className="napkin-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Document</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => (
              <tr key={`${s.kind}-${s.url || s.label}`}>
                <td>{formatDocDate(s.date)}</td>
                <td>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title}
                    </a>
                  ) : (
                    s.title
                  )}
                </td>
                <td>
                  {s.found && s.url ? (
                    <div className="napkin-doc-actions">
                      <button
                        type="button"
                        className="napkin-analyse napkin-analyse-sm"
                        disabled={busy === s.url}
                        onClick={() => void onAnalyse(s.url!)}
                      >
                        {busy === s.url ? "Extracting…" : "Analyse"}
                      </button>
                      <span className="napkin-badge is-picked">Picked</span>
                    </div>
                  ) : (
                    <span className="napkin-not-found">Not Found</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <p className="napkin-error">{error}</p> : null}
      {extracts.map((ex) => (
        <div key={ex.url} className="napkin-pdf-preview">
          <h3>
            {ex.kind ? `${ex.kind} · ` : ""}
            {ex.title}
          </h3>
          {ex.error ? (
            <p className="napkin-error">{ex.error}</p>
          ) : (
            <>
              <p className="napkin-pending">
                Auto-extracted {ex.pages} page{ex.pages === 1 ? "" : "s"}.
              </p>
              {ex.preview.map((p) => (
                <article key={p.page_number}>
                  <h4>Page {p.page_number}</h4>
                  <pre>{p.text || "(no extractable text on this page)"}</pre>
                </article>
              ))}
            </>
          )}
        </div>
      ))}
      {preview ? (
        <div className="napkin-pdf-preview">
          <h3>{preview.title}</h3>
          <p className="napkin-pending">{preview.note}</p>
          {preview.pages.map((p) => (
            <article key={p.page_number}>
              <h4>Page {p.page_number}</h4>
              <pre>{p.text || "(no extractable text on this page)"}</pre>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatDocDate(raw: string): string {
  if (!raw || raw === "N/A" || raw === "—") return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
}

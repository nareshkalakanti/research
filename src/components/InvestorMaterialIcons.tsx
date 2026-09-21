"use client";

import type { MaterialIconItem } from "@/lib/investor-material-types";

type Props = {
  items: MaterialIconItem[] | null | undefined;
  loading?: boolean;
  note?: string | null;
};

function iconLabel(m: MaterialIconItem): string {
  if (m.kind === "concall" || m.kind === "transcript") return "PDF";
  if (m.kind === "ppt") return "PPT";
  return "Rslt";
}

function kindLabel(m: MaterialIconItem): string {
  if (m.kind === "concall" || m.kind === "transcript") return "Transcript";
  if (m.kind === "ppt") return "PPT";
  return "Results";
}

function iconClass(m: MaterialIconItem): string {
  if (m.kind === "concall" || m.kind === "transcript") return "inv-mat-icon--pdf";
  if (m.kind === "ppt") return "inv-mat-icon--ppt";
  return "inv-mat-icon--results";
}

export function InvestorMaterialIcons({ items, loading, note }: Props) {
  const list = items ?? [];
  if (loading && !list.length) {
    return (
      <p className="viq-mat-hint">Downloading PPT / concall and analysing…</p>
    );
  }
  if (!list.length) {
    return note ? <p className="viq-mat-hint">{note}</p> : null;
  }
  return (
    <div className="viq-mat-row">
      <div className="inv-mat-icons">
        {list.map((m) => {
          const inner = (
            <>
              <span
                className={`inv-mat-icon ${iconClass(m)}${m.pending ? " inv-mat-icon--pending" : ""}`}
                title={`${kindLabel(m)}${m.distilled ? " · analysed" : ""}${m.pending ? " · downloading" : ""}`}
              >
                {iconLabel(m)}
              </span>
              <span className="inv-mat-icon-period">
                {m.period || kindLabel(m)}
                {m.distilled ? " · analysed" : m.pending ? " · wait" : m.has_text ? " · saved" : ""}
              </span>
            </>
          );
          if (m.source_url) {
            return (
              <a
                key={m.id}
                className="inv-mat-icon-wrap"
                href={m.source_url}
                target="_blank"
                rel="noreferrer"
              >
                {inner}
              </a>
            );
          }
          return (
            <span key={m.id} className="inv-mat-icon-wrap">
              {inner}
            </span>
          );
        })}
      </div>
      {note ? <p className="viq-mat-hint">{note}</p> : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestorMaterial } from "@/lib/investor-materials";

type Props = {
  ticker: string;
  market: string;
  onMaterialsChange?: () => void;
};

function isPdfKind(kind: InvestorMaterial["kind"]): boolean {
  return kind === "concall" || kind === "transcript";
}

function iconLabel(m: InvestorMaterial): string {
  return isPdfKind(m.kind) ? "PDF" : "PPT";
}

function visibleMaterials(materials: InvestorMaterial[]): InvestorMaterial[] {
  return materials.filter(
    (m) => m.kind === "concall" || m.kind === "transcript" || m.kind === "ppt",
  );
}

export function ExpandInvestorMaterials({ ticker, onMaterialsChange }: Props) {
  const [materials, setMaterials] = useState<InvestorMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoDownloaded = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/investor-materials?ticker=${encodeURIComponent(ticker)}`,
      );
      const j = (await res.json()) as {
        ok?: boolean;
        materials?: InvestorMaterial[];
        error?: string;
      };
      if (!res.ok || !j.ok) throw new Error(j.error || "Could not load");
      setMaterials(j.materials ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  const download = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/investor-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import_latest",
          ticker,
          limit: 2,
          kinds: ["concall", "ppt"],
          distill: true,
        }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        materials?: InvestorMaterial[];
      };
      setMaterials(j.materials ?? []);
      if (!res.ok || j.ok === false) {
        throw new Error(j.error || "Download failed");
      }
      if (!visibleMaterials(j.materials ?? []).length) {
        throw new Error("No concall / PPT downloaded");
      }
      onMaterialsChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(false);
    }
  }, [ticker, onMaterialsChange]);

  useEffect(() => {
    autoDownloaded.current = false;
    void load();
  }, [load]);

  useEffect(() => {
    if (loading || busy || autoDownloaded.current) return;
    autoDownloaded.current = true;
    if (visibleMaterials(materials).length === 0) void download();
  }, [loading, materials, busy, download]);

  const icons = visibleMaterials(materials);

  if ((loading || busy) && !icons.length) {
    return (
      <div className="inv-mat-panel inv-mat-panel--minimal">
        <span className="inv-mat-busy">…</span>
      </div>
    );
  }

  return (
    <div className="inv-mat-panel inv-mat-panel--minimal">
      <div className="inv-mat-icons">
        {icons.map((m) => {
          const pdf = isPdfKind(m.kind);
          const inner = (
            <span className={`inv-mat-icon ${pdf ? "inv-mat-icon--pdf" : "inv-mat-icon--ppt"}`}>
              {iconLabel(m)}
            </span>
          );
          const title = [m.period, m.title].filter(Boolean).join(" · ") || iconLabel(m);
          if (m.source_url) {
            return (
              <a
                key={m.id}
                href={m.source_url}
                target="_blank"
                rel="noreferrer"
                className="inv-mat-icon-wrap"
                title={title}
              >
                {inner}
              </a>
            );
          }
          return (
            <span key={m.id} className="inv-mat-icon-wrap" title={title}>
              {inner}
            </span>
          );
        })}
        {!busy && !icons.length ? (
          <button type="button" className="inv-mat-dl-btn" onClick={() => void download()}>
            Download
          </button>
        ) : null}
      </div>
      {error ? <p className="inv-mat-error">{error}</p> : null}
    </div>
  );
}

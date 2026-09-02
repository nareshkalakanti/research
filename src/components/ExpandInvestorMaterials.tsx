"use client";

import { useCallback, useEffect, useState } from "react";
import type { InvestorMaterial } from "@/lib/investor-materials";
import { materialHeadline } from "@/lib/investor-material-labels";
import { parseFetchJson } from "@/lib/fetch-json";

type Props = {
  ticker: string;
  market: string;
  onMaterialsChange?: () => void;
};

function isPending(m: { raw_text: string; pending?: boolean }): boolean {
  return m.pending === true || m.raw_text.startsWith("[pending]");
}

function hasUsableText(m: { raw_text: string; has_text?: boolean; pending?: boolean }): boolean {
  if (isPending(m)) return false;
  if (m.has_text === true) return true;
  return m.raw_text.replace(/\s/g, "").length >= 200;
}

function iconLabel(m: InvestorMaterial): string {
  if (m.kind === "concall" || m.kind === "transcript") return "PDF";
  if (m.kind === "ppt") return "PPT";
  return "Rslt";
}

function kindLabel(m: InvestorMaterial): string {
  if (m.kind === "concall" || m.kind === "transcript") return "Transcript";
  if (m.kind === "ppt") return "PPT";
  return "Results";
}

function iconClass(m: InvestorMaterial): string {
  if (m.kind === "concall" || m.kind === "transcript") return "inv-mat-icon--pdf";
  if (m.kind === "ppt") return "inv-mat-icon--ppt";
  return "inv-mat-icon--results";
}

function visibleMaterials(materials: InvestorMaterial[]): InvestorMaterial[] {
  const eligible = materials.filter((m) => {
    if (m.kind === "concall" || m.kind === "transcript" || m.kind === "ppt") {
      return hasUsableText(m) || isPending(m);
    }
    if (m.kind === "other") {
      return (
        hasUsableText(m) &&
        /financial\s+result|outcome\s+of\s+board/i.test(m.title || "")
      );
    }
    return false;
  });

  const byKey = new Map<string, InvestorMaterial>();
  for (const m of eligible) {
    const key = m.source_url || `id:${m.id}`;
    const prev = byKey.get(key);
    if (!prev || m.raw_text.length > prev.raw_text.length) byKey.set(key, m);
  }

  return [...byKey.values()].sort((a, b) => {
    const ca = a.created_at || a.period || "";
    const cb = b.created_at || b.period || "";
    return cb.localeCompare(ca);
  });
}

export function ExpandInvestorMaterials({ ticker, onMaterialsChange }: Props) {
  const [materials, setMaterials] = useState<InvestorMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<{ firecrawl: boolean; llm: boolean }>({
    firecrawl: false,
    llm: false,
  });
  const [parsedWith, setParsedWith] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/investor-materials?ticker=${encodeURIComponent(ticker)}`,
      );
      const j = await parseFetchJson<{
        ok?: boolean;
        materials?: InvestorMaterial[];
        error?: string;
        tools?: { firecrawl?: boolean; llm?: boolean };
      }>(res);
      if (!res.ok || !j.ok) throw new Error(j.error || "Could not load");
      setMaterials(j.materials ?? []);
      setTools({
        firecrawl: Boolean(j.tools?.firecrawl),
        llm: Boolean(j.tools?.llm),
      });
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
          kinds: ["concall", "ppt", "transcript"],
          distill: true,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const j = await parseFetchJson<{
        ok?: boolean;
        error?: string;
        materials?: InvestorMaterial[];
        parsed_with?: string;
        distilled?: number;
      }>(res);
      setMaterials(j.materials ?? []);
      if (j.parsed_with) setParsedWith(j.parsed_with);
      if (!res.ok || j.ok === false) {
        throw new Error(j.error || "Fetch failed");
      }
      if (!visibleMaterials(j.materials ?? []).length) {
        throw new Error("No concall, PPT, or results PDF found on NSE/BSE");
      }
      onMaterialsChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setBusy(false);
    }
  }, [ticker, onMaterialsChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const icons = visibleMaterials(materials);
  const pending = icons.some(isPending);

  if (loading && !icons.length) {
    return (
      <div className="sx-docs">
        <p className="sx-docs-hint">Checking saved filings…</p>
      </div>
    );
  }

  return (
    <div className="sx-docs">
      <div className="sx-docs-bar">
        <p className="sx-docs-hint">
          {busy
            ? "Firecrawl is parsing PDFs, then the LLM writes a distill…"
            : icons.length
              ? "Saved filings. Fetch again to pull new PDFs."
              : "Nothing downloaded yet. Fetch runs Firecrawl on click, then the LLM."}
        </p>
        <button
          type="button"
          className="sx-fetch-btn"
          onClick={() => void download()}
          disabled={busy}
        >
          {busy ? "Fetching…" : icons.length ? "Refresh PDFs" : "Fetch PDFs"}
        </button>
      </div>

      {parsedWith || tools.firecrawl || tools.llm ? (
        <p className="sx-docs-tools">
          {tools.firecrawl ? "Firecrawl" : "Local parse"}
          {tools.llm ? " · LLM distill" : ""}
          {parsedWith ? ` · last parse: ${parsedWith}` : ""}
        </p>
      ) : null}

      {icons.length ? (
        <ul className="sx-doc-list">
          {icons.map((m) => (
            <li key={m.id} className="sx-doc-card">
              <div className="sx-doc-card-head">
                <span className={`inv-mat-icon ${iconClass(m)}`}>{iconLabel(m)}</span>
                <div>
                  <strong>{kindLabel(m)}</strong>
                  <span>{materialHeadline(m)}</span>
                  {isPending(m) ? <em>Waiting for Firecrawl</em> : null}
                </div>
              </div>
              {m.source_url ? (
                <a className="sx-doc-open" href={m.source_url} target="_blank" rel="noreferrer">
                  Open source
                </a>
              ) : null}
              {m.brief_text ? <p className="sx-doc-brief">{m.brief_text}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {pending && !busy ? (
        <p className="sx-docs-hint">A filing is still pending — click Fetch PDFs to parse it.</p>
      ) : null}
      {error ? <p className="inv-mat-error">{error}</p> : null}
    </div>
  );
}

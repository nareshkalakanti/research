import type { NapkinConcallTrack } from "./concall-track";
import type { NapkinFilingRow } from "./filings";
import type { NapkinStepEvent } from "./progress";
import type { NapkinFiling, NapkinPdfPage, NapkinResearch } from "./types";

export type NapkinExtractHit = {
  url: string;
  title: string;
  kind?: string;
  preview: NapkinPdfPage[];
  pages: number;
  error: string | null;
};

export type NapkinQwenHit = {
  model: string | null;
  sections: Array<{ heading: string; body: string }>;
  error: string | null;
};

export type NapkinLoadDebug = {
  yahoo_ms?: number;
  source?: string;
  filings?: string;
  filings_ms?: number;
  filings_count?: number;
  filings_error?: string;
};

function toFiling(f: NapkinFilingRow): NapkinFiling {
  return {
    title: f.document_title,
    period: f.date ? f.date.slice(0, 10) : "N/A",
    kind: f.document_type,
    source: f.source,
    url: f.url,
    picked: Boolean(f.picked),
  };
}

export async function loadNapkinResearch(
  ticker: string,
): Promise<{ research: NapkinResearch; debug: NapkinLoadDebug }> {
  const t = ticker.trim().toUpperCase();
  if (!t) throw new Error("Enter an NSE ticker");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  const res = await fetch(`/api/napkin?ticker=${encodeURIComponent(t)}`, {
    cache: "no-store",
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
  const json = (await res.json()) as {
    ok?: boolean;
    error?: string;
    research?: NapkinResearch;
    debug?: NapkinLoadDebug;
  };
  if (!res.ok || !json.ok || !json.research) {
    throw new Error(json.error || `Could not load ${t}`);
  }
  return { research: json.research, debug: json.debug || {} };
}

export async function loadNapkinFilings(
  ticker: string,
  onStep?: (step: NapkinStepEvent) => void,
  onUpdate?: (next: {
    filings: NapkinFiling[];
    extracts: NapkinExtractHit[];
    qwen: NapkinQwenHit | null;
    concall: NapkinConcallTrack | null;
    debug: NapkinLoadDebug;
  }) => void,
): Promise<{
  filings: NapkinFiling[];
  extracts: NapkinExtractHit[];
  qwen: NapkinQwenHit | null;
  concall: NapkinConcallTrack | null;
  debug: NapkinLoadDebug;
}> {
  const t = ticker.trim().toUpperCase();
  const res = await fetch(`/api/napkin/filings?ticker=${encodeURIComponent(t)}`, {
    cache: "no-store",
  });
  if (!res.body) {
    throw new Error("Filings stream unavailable");
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let filings: NapkinFiling[] = [];
  const extracts: NapkinExtractHit[] = [];
  let qwen: NapkinQwenHit | null = null;
  let concall: NapkinConcallTrack | null = null;
  let debug: NapkinLoadDebug = {};
  const emit = () =>
    onUpdate?.({ filings, extracts: [...extracts], qwen, concall, debug });
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: {
        type?: string;
        step?: NapkinStepEvent;
        filings?: NapkinFilingRow[];
        debug?: { filings_ms?: number; count?: number };
        error?: string;
        url?: string;
        title?: string;
        kind?: string;
        preview?: NapkinPdfPage[];
        pages?: number;
        model?: string | null;
        sections?: Array<{ heading: string; body: string }>;
        track?: NapkinConcallTrack;
      };
      try {
        ev = JSON.parse(line) as typeof ev;
      } catch {
        continue;
      }
      if (ev.type === "step" && ev.step) onStep?.(ev.step);
      if (ev.type === "filings") {
        filings = (ev.filings || []).map(toFiling);
        debug = {
          filings_ms: ev.debug?.filings_ms,
          filings_count: ev.debug?.count ?? filings.length,
        };
        emit();
      }
      if (ev.type === "extract" && ev.url) {
        extracts.push({
          url: ev.url,
          title: ev.title || ev.url,
          kind: ev.kind,
          preview: ev.preview || [],
          pages: ev.pages || 0,
          error: ev.error || null,
        });
        emit();
      }
      if (ev.type === "qwen") {
        qwen = {
          model: ev.model ?? null,
          sections: ev.sections || [],
          error: ev.error || null,
        };
        emit();
      }
      if (ev.type === "concall" && ev.track) {
        concall = ev.track;
        emit();
      }
      if (ev.type === "error") {
        debug = { ...debug, filings_error: ev.error };
        emit();
      }
    }
  }
  return { filings, extracts, qwen, concall, debug };
}

export async function analyseNapkinPdf(url: string): Promise<{
  title: string;
  pages: NapkinPdfPage[];
  full_text: string;
  preview: NapkinPdfPage[];
  qwen: string;
}> {
  const res = await fetch("/api/napkin/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const json = (await res.json()) as {
    ok?: boolean;
    error?: string;
    title?: string;
    pages?: NapkinPdfPage[];
    full_text?: string;
    preview?: NapkinPdfPage[];
    qwen?: string;
  };
  if (!res.ok || !json.ok) {
    throw new Error(json.error || "Could not extract PDF");
  }
  return {
    title: json.title || "filing.pdf",
    pages: json.pages || [],
    full_text: json.full_text || "",
    preview: json.preview || [],
    qwen: json.qwen || "Local Qwen is not connected yet.",
  };
}

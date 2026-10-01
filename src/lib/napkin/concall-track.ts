import type { NapkinFilingRow } from "./filings";
import { getCachedExtract } from "./pdf";
import { askQwen, napkinQwenModel, QWEN_DOWN } from "./qwen";
import { buildNapkinConcallUser, NAPKIN_CONCALL_SYSTEM } from "./concall-prompt";

export type ConcallStatus =
  | "ACHIEVED"
  | "PARTIALLY_ACHIEVED"
  | "MISSED"
  | "DELAYED"
  | "UNKNOWN";

export type NapkinConcallRow = {
  quarter: string;
  claim: string;
  timeframe: string;
  subsequent_result: string;
  status: ConcallStatus;
  source: string;
};

export type NapkinConcallTrack = {
  rows: NapkinConcallRow[];
  themes: Record<string, string[]>;
  repeated_across_quarters: string[];
  model: string | null;
  error: string | null;
  transcripts: number;
};

const STATUSES = new Set<ConcallStatus>([
  "ACHIEVED",
  "PARTIALLY_ACHIEVED",
  "MISSED",
  "DELAYED",
  "UNKNOWN",
]);

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim()).map((x) => x.trim());
}

function parseTrack(raw: string): Pick<
  NapkinConcallTrack,
  "rows" | "themes" | "repeated_across_quarters"
> {
  const json = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()) as {
    rows?: unknown;
    themes?: Record<string, unknown>;
    repeated_across_quarters?: unknown;
  };
  const rows: NapkinConcallRow[] = [];
  if (Array.isArray(json.rows)) {
    for (const r of json.rows) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const statusRaw = String(o.status || "UNKNOWN").toUpperCase().replace(/\s+/g, "_");
      const status = STATUSES.has(statusRaw as ConcallStatus)
        ? (statusRaw as ConcallStatus)
        : "UNKNOWN";
      rows.push({
        quarter: String(o.quarter || "N/A"),
        claim: String(o.claim || "Not available"),
        timeframe: String(o.timeframe || "Not available"),
        subsequent_result: String(o.subsequent_result || "Not available"),
        status,
        source: String(o.source || "Not available"),
      });
    }
  }
  const th = json.themes && typeof json.themes === "object" ? json.themes : {};
  const themes: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(th)) themes[k] = strList(v);
  return {
    rows,
    themes,
    repeated_across_quarters: strList(json.repeated_across_quarters),
  };
}

export async function runNapkinConcallTrack(
  transcripts: NapkinFilingRow[],
  results: NapkinFilingRow[],
): Promise<NapkinConcallTrack> {
  const model = napkinQwenModel();
  const docs = [...transcripts, ...results].map((row) => {
    const cached = getCachedExtract(row.url);
    return {
      title: row.document_title,
      kind: row.document_type,
      date: row.date,
      pages: (cached?.pages || []).slice(0, 12).map((p) => ({
        page_number: p.page_number,
        text: p.text,
      })),
    };
  }).filter((d) => d.pages.some((p) => p.text.trim()));

  if (!docs.length) {
    return {
      rows: [],
      themes: {},
      repeated_across_quarters: [],
      model,
      error: "No concall transcripts with extractable text",
      transcripts: transcripts.length,
    };
  }

  try {
    const text = await askQwen(
      buildNapkinConcallUser(docs),
      NAPKIN_CONCALL_SYSTEM,
      { json: true, numPredict: 1800 },
    );
    const parsed = parseTrack(text);
    return { ...parsed, model, error: null, transcripts: transcripts.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      rows: [],
      themes: {},
      repeated_across_quarters: [],
      model,
      error: msg.includes("not running") ? QWEN_DOWN : msg,
      transcripts: transcripts.length,
    };
  }
}

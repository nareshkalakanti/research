import type { NapkinDocType } from "./types";

export const NAPKIN_DOC_SLOTS: Array<{
  kind: NapkinDocType;
  label: string;
  take: number;
}> = [
  { kind: "RESULT", label: "Results", take: 2 },
  { kind: "INVESTOR_PRESENTATION", label: "Investor Presentation", take: 1 },
  { kind: "ANNUAL_REPORT", label: "Annual Report", take: 1 },
  { kind: "CONCALL_TRANSCRIPT", label: "Concall Transcript", take: 1 },
];

export type NapkinDocSlot = {
  kind: NapkinDocType;
  label: string;
  date: string;
  title: string;
  url: string | null;
  found: boolean;
};

/** Collection table: picked docs plus one Not Found row per missing type. */
export function napkinDocumentCollection(
  rows: Array<{
    title: string;
    period: string;
    kind: NapkinDocType;
    url: string;
    picked?: boolean;
  }>,
): NapkinDocSlot[] {
  const picked = rows.filter((r) => r.picked);
  const pool = picked.length ? picked : rows;
  const used = new Set<string>();
  const out: NapkinDocSlot[] = [];
  for (const slot of NAPKIN_DOC_SLOTS) {
    const hits = pool.filter((r) => r.kind === slot.kind && !used.has(r.url));
    const take = hits.slice(0, slot.take);
    for (const hit of take) {
      used.add(hit.url);
      out.push({
        kind: slot.kind,
        label: slot.label,
        date: hit.period,
        title: hit.title || slot.label,
        url: hit.url,
        found: true,
      });
    }
    if (!take.length) {
      out.push({
        kind: slot.kind,
        label: slot.label,
        date: "—",
        title: slot.label,
        url: null,
        found: false,
      });
    }
  }
  return out;
}

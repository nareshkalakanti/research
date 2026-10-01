export function napkinMetric(
  items: Array<{ key: string; label: string; value: string }>,
  key: string,
): string {
  return items.find((i) => i.key === key)?.value || "N/A";
}

export function napkinPeDisplay(v: string): string {
  if (!v || v === "N/A") return "N/A";
  return /x$/i.test(v.trim()) ? v : `${v}x`;
}

export function parseDisplayedPct(s: string | undefined): number | null {
  if (!s || s === "N/A") return null;
  const n = Number(s.replace(/[+%]/g, "").trim());
  return Number.isFinite(n) ? n / 100 : null;
}

export function formatNapkinPct(v: number | null, signed = false): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  const core = `${(v * 100).toFixed(1)}%`;
  return signed && v > 0 ? `+${core}` : core;
}

/** Fact notes from displayed CAGRs only. No buy/sell language. */
export function napkinMathNotes(input: {
  historicalEpsCagr: string;
  growthGap: string;
  usedFiveYear: boolean;
}): string[] {
  const notes: string[] = [];
  const hist = parseDisplayedPct(input.historicalEpsCagr);
  const gap = parseDisplayedPct(input.growthGap);
  if (hist != null && hist < 0) {
    notes.push(
      input.usedFiveYear
        ? "EPS declined over the 5-year period"
        : "EPS declined over the 3-year period",
    );
  }
  if (gap != null && gap < 0) {
    notes.push("Required growth is above historical growth");
  }
  return notes;
}

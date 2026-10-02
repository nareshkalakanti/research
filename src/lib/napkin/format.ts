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

export function parseDisplayedMoney(s: string | undefined): number | null {
  if (!s || s === "N/A") return null;
  if (/\bcr\b/i.test(s)) return null;
  const n = Number(s.replace(/[₹$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

export function parseDisplayedPe(s: string | undefined): number | null {
  if (!s || s === "N/A") return null;
  const n = Number(s.replace(/x$/i, "").trim());
  return Number.isFinite(n) ? n : null;
}

export function formatNapkinRupee(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  const digits = Math.abs(v) >= 100 ? 0 : 1;
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: digits })}`;
}

export function formatNapkinPctWhole(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  const p = v * 100;
  const digits = Number.isInteger(p) || Math.abs(p - Math.round(p)) < 1e-9 ? 0 : 1;
  return `${p.toFixed(digits)}%`;
}

/** Fact notes from displayed CAGRs only. No buy/sell language. */
export function napkinMathNotes(input: {
  historicalEpsCagr: string;
  usedFiveYear: boolean;
  aboveHistory?: boolean;
}): string[] {
  const notes: string[] = [];
  const hist = parseDisplayedPct(input.historicalEpsCagr);
  if (hist != null && hist < 0) {
    notes.push(
      input.usedFiveYear
        ? "EPS declined over the 5-year period"
        : "EPS declined over the 3-year period",
    );
  }
  if (input.aboveHistory) {
    notes.push(
      "Your assumption requires EPS growth significantly above history",
    );
  }
  return notes;
}

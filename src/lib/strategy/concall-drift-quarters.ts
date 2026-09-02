/** Indian FY quarter: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. */
export type FyQuarterKey = `Q${1 | 2 | 3 | 4}FY${string}`;

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

function fyLabel(q: 1 | 2 | 3 | 4, fy: number): string {
  return `Q${q}FY${String(fy).slice(-2)}`;
}

/** FY quarter for a calendar period-end date (Mar → Q4 of that FY). */
export function fyQuarterFromPeriodEnd(d: Date): string {
  const m = d.getMonth();
  const y = d.getFullYear();
  if (m === 2) return fyLabel(4, y);
  if (m === 5) return fyLabel(1, y + 1);
  if (m === 8) return fyLabel(2, y + 1);
  if (m === 11) return fyLabel(3, y + 1);
  return fyQuarterFromEarnEvent(d);
}

/** Parse "quarter ended 31 March 2026" from NSE earn subject when present. */
export function parsePeriodEndFromEarnSubject(subject: string | null | undefined): Date | null {
  if (!subject?.trim()) return null;
  const s = subject.toLowerCase();

  const m1 = s.match(
    /(?:quarter|period|year)\s+(?:and\s+year\s+)?ended\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})/i,
  );
  if (m1) {
    const day = Number(m1[1]);
    const mon = MONTHS[m1[2]!.toLowerCase()];
    const year = Number(m1[3]);
    if (mon != null && day >= 1 && day <= 31) {
      const d = new Date(year, mon, day);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  const m2 = s.match(
    /(?:quarter|period|year)\s+(?:and\s+year\s+)?ended\s+([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (m2) {
    const mon = MONTHS[m2[1]!.toLowerCase()];
    const day = Number(m2[2]);
    const year = Number(m2[3]);
    if (mon != null && day >= 1 && day <= 31) {
      const d = new Date(year, mon, day);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  return null;
}

/** Reported FY quarter for an earn filing — not the calendar quarter of the filing date. */
export function fyQuarterFromEarnEvent(
  earnAt: string | Date,
  subject?: string | null,
): string {
  const parsedEnd = parsePeriodEndFromEarnSubject(subject);
  if (parsedEnd) return fyQuarterFromPeriodEnd(parsedEnd);

  const d = earnAt instanceof Date ? earnAt : new Date(earnAt);
  if (Number.isNaN(d.getTime())) return fyQuarterFromDate(new Date());

  const m = d.getMonth();
  const y = d.getFullYear();
  // Typical NSE filing season → reported quarter (Indian FY).
  if (m >= 3 && m <= 5) return fyLabel(4, y);
  if (m >= 6 && m <= 8) return fyLabel(1, y + 1);
  if (m >= 9 && m <= 11) return fyLabel(2, y + 1);
  return fyLabel(3, y);
}

/** Which results season is live now (by earn announcement window). */
export function currentEarnSeasonQuarter(): string {
  return fyQuarterFromEarnEvent(new Date());
}

/** Normalize Q1FY27-style labels for comparison. */
export function normalizeFyQuarterLabel(label: string | null | undefined): string {
  return (label || "").trim().toUpperCase().replace(/\s+/g, "");
}

/** True when an earn row belongs to the selected results quarter. */
export function earnMatchesQuarterFilter(
  earnAt: string,
  earnSubject: string | null | undefined,
  filterQuarter: string | null | undefined,
): boolean {
  if (!filterQuarter?.trim()) return true;
  const rowQ = normalizeFyQuarterLabel(
    fyQuarterFromEarnEvent(earnAt, earnSubject),
  );
  return rowQ === normalizeFyQuarterLabel(filterQuarter);
}

/** Earn announcement window for a reported FY quarter (not the reporting period itself). */
export function earnAnnouncementWindowForFyQuarter(
  label: string,
): { from: Date; to: Date } | null {
  const m = label.trim().toUpperCase().match(/^Q([1-4])FY(\d{2})$/);
  if (!m) return null;
  const q = Number(m[1]) as 1 | 2 | 3 | 4;
  const fyShort = Number(m[2]);
  const fy = fyShort >= 50 ? 1900 + fyShort : 2000 + fyShort;
  const stragglers = 15;

  if (q === 4) {
    return {
      from: new Date(fy, 3, 1),
      to: new Date(fy, 6, stragglers, 23, 59, 59, 999),
    };
  }
  if (q === 1) {
    return {
      from: new Date(fy - 1, 6, 1),
      to: new Date(fy - 1, 9, stragglers, 23, 59, 59, 999),
    };
  }
  if (q === 2) {
    return {
      from: new Date(fy - 1, 9, 1),
      to: new Date(fy - 1, 11, 31 + stragglers, 23, 59, 59, 999),
    };
  }
  return {
    from: new Date(fy, 0, 1),
    to: new Date(fy, 3, stragglers, 23, 59, 59, 999),
  };
}

export function fyQuarterFromDate(d: Date): string {
  const m = d.getMonth();
  const calY = d.getFullYear();
  const fy = m >= 3 ? calY + 1 : calY;
  let q: 1 | 2 | 3 | 4;
  if (m >= 3 && m <= 5) q = 1;
  else if (m <= 8) q = 2;
  else if (m <= 11) q = 3;
  else q = 4;
  return `Q${q}FY${String(fy).slice(-2)}`;
}

export function parseFyQuarter(label: string): { from: Date; to: Date } | null {
  const m = label.trim().toUpperCase().match(/^Q([1-4])FY(\d{2})$/);
  if (!m) return null;
  const q = Number(m[1]) as 1 | 2 | 3 | 4;
  const fyShort = Number(m[2]);
  const fy = fyShort >= 50 ? 1900 + fyShort : 2000 + fyShort;
  const startMonth = q === 1 ? 3 : q === 2 ? 6 : q === 3 ? 9 : 0;
  const startYear = q === 4 ? fy : fy - 1;
  const from = new Date(startYear, startMonth, 1);
  const to =
    q === 1
      ? new Date(fy - 1, 5, 30, 23, 59, 59)
      : q === 2
        ? new Date(fy - 1, 8, 30, 23, 59, 59)
        : q === 3
          ? new Date(fy - 1, 11, 31, 23, 59, 59)
          : new Date(fy, 2, 31, 23, 59, 59);
  return { from, to };
}

export function previousFyQuarter(label: string): string | null {
  const m = label.trim().toUpperCase().match(/^Q([1-4])FY(\d{2})$/);
  if (!m) return null;
  const q = Number(m[1]) as 1 | 2 | 3 | 4;
  const fyShort = Number(m[2]);
  if (q === 1) {
    const prevFy = fyShort === 0 ? 99 : fyShort - 1;
    return `Q4FY${String(prevFy).padStart(2, "0")}`;
  }
  return `Q${q - 1}FY${String(fyShort).padStart(2, "0")}`;
}

export function fyQuarterSortKey(label: string): number {
  const m = label.trim().toUpperCase().match(/^Q([1-4])FY(\d{2})$/);
  if (!m) return 0;
  const q = Number(m[1]);
  const fyShort = Number(m[2]);
  const fy = fyShort >= 50 ? 1900 + fyShort : 2000 + fyShort;
  return fy * 10 + q;
}

/** Reporting period for an Indian FY quarter label (Apr–Jun, Jul–Sep, …). */
export function fyQuarterReportingPeriod(
  label: string,
): { from: Date; to: Date } | null {
  return parseFyQuarter(label);
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** UI chip — calendar period of the results, e.g. Apr–Jun '26 (not FY27). */
export function fyQuarterChipLabel(label: string): string {
  const range = fyQuarterReportingPeriod(label);
  if (!range) return label;
  const fromM = MONTH_SHORT[range.from.getMonth()]!;
  const toM = MONTH_SHORT[range.to.getMonth()]!;
  const y = String(range.to.getFullYear()).slice(-2);
  return `${fromM}–${toM} '${y}`;
}

/** Tooltip / meta — Indian FY id + results period + typical NSE filing window. */
export function fyQuarterExplain(label: string): string {
  const results = fyQuarterReportingPeriod(label);
  const earn = earnAnnouncementWindowForFyQuarter(label);
  if (!results || !earn) return label;
  const resFrom = MONTH_SHORT[results.from.getMonth()];
  const resTo = MONTH_SHORT[results.to.getMonth()];
  const resY = results.to.getFullYear();
  return `${label} · ${resFrom}–${resTo} ${resY} results · NSE filings ${isoDate(earn.from)} – ${isoDate(earn.to)}`;
}

export function recentFyQuarterOptions(count = 6): string[] {
  const out: string[] = [];
  let label: string | null = currentEarnSeasonQuarter();
  while (label && out.length < count) {
    if (!out.includes(label)) out.push(label);
    label = previousFyQuarter(label);
  }
  return out;
}

export function windowRange(
  window: string,
  customFrom?: string | null,
  customTo?: string | null,
): { from: Date; to: Date } | null {
  const w = (window || "all").toLowerCase();
  if (w === "all" || w === "quarter") return null;

  const now = new Date();
  const day = 86_400_000;

  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  if (w === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: endOfDay(y) };
  }
  if (w === "today") {
    return { from: startOfDay(now), to: endOfDay(now) };
  }
  if (w === "tomorrow") {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    return { from: startOfDay(t), to: endOfDay(t) };
  }
  if (w === "last7") {
    return { from: new Date(now.getTime() - 7 * day), to: now };
  }
  if (w === "next7") {
    return { from: now, to: new Date(now.getTime() + 7 * day) };
  }
  if (w === "90d") {
    return { from: new Date(now.getTime() - 90 * day), to: now };
  }
  if (w === "custom" && customFrom && customTo) {
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59`);
    if (Number.isFinite(from.getTime()) && Number.isFinite(to.getTime())) {
      return { from, to };
    }
  }
  return null;
}

export function intersectRanges(
  a: { from: Date; to: Date } | null,
  b: { from: Date; to: Date } | null,
): { from: Date; to: Date } | null {
  if (!a) return b;
  if (!b) return a;
  const from = new Date(Math.max(a.from.getTime(), b.from.getTime()));
  const to = new Date(Math.min(a.to.getTime(), b.to.getTime()));
  if (from.getTime() > to.getTime()) return null;
  return { from, to };
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

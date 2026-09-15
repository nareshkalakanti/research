/**
 * India exchange (NSE / BSE) civil time — always Asia/Kolkata.
 * Never use the host timezone for announcement clocks or Today/Yesterday buckets.
 */

export const INDIA_TZ = "Asia/Kolkata";
const IST_MS = (5 * 60 + 30) * 60_000;

export type IstCivilDay = {
  year: number;
  month: number; // 1–12
  day: number;
};

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/** NSE/BSE wall clock → UTC ISO. */
export function nseWallTimeToUtcIso(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): string {
  const utcMs =
    Date.UTC(year, monthIndex, day, hour, minute, second) - IST_MS;
  return new Date(utcMs).toISOString();
}

/** Parse NSE an_dt / sort_date strings (DD-Mon-YYYY or DD-MM-YYYY [HH:MM:SS]). */
export function parseNseDateTime(raw: unknown): string | null {
  const text = safeStr(raw);
  if (!text) return null;
  const m = text.match(
    /^(\d{2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (m) {
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const mon = months[m[2]!.toLowerCase()];
    if (mon == null) return null;
    return nseWallTimeToUtcIso(
      Number(m[3]),
      mon,
      Number(m[1]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0),
    );
  }
  const n = text.match(
    /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (n) {
    return nseWallTimeToUtcIso(
      Number(n[3]),
      Number(n[2]) - 1,
      Number(n[1]),
      Number(n[4] || 0),
      Number(n[5] || 0),
      Number(n[6] || 0),
    );
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** IST calendar day (YYYY-MM-DD) for an announcement timestamp. */
export function istDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Legacy rows stuffed NSE wall-clock digits into `Date` (host/UTC).
 * Reinterpret YYYY-MM-DDTHH:mm:ss as IST and emit real UTC.
 */
export function repairLegacyNseIso(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null;
  const m = iso
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return iso;
  return nseWallTimeToUtcIso(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0),
  );
}

export function istTodayParts(now = new Date()): IstCivilDay {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return {
    year: Number(parts.find((p) => p.type === "year")?.value),
    month: Number(parts.find((p) => p.type === "month")?.value),
    day: Number(parts.find((p) => p.type === "day")?.value),
  };
}

export function shiftIstCivilDay(day: IstCivilDay, deltaDays: number): IstCivilDay {
  const utc = new Date(Date.UTC(day.year, day.month - 1, day.day + deltaDays));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

/** DD-MM-YYYY for NSE corporate-announcements API. */
export function formatNseApiDate(day: IstCivilDay): string {
  return `${String(day.day).padStart(2, "0")}-${String(day.month).padStart(2, "0")}-${day.year}`;
}

/** YYYYMMDD for BSE announcement APIs. */
export function formatBseApiDate(day: IstCivilDay): string {
  return `${day.year}${String(day.month).padStart(2, "0")}${String(day.day).padStart(2, "0")}`;
}

/**
 * Synthetic UTC Date whose YYYY-MM-DD equals the IST civil day.
 * Used when callers compare `toISOString().slice(0,10)` to `istDateKey(...)`.
 * Not a true IST→UTC instant bound.
 */
export function istCivilDayUtcBounds(day: IstCivilDay): {
  from: Date;
  to: Date;
} {
  const from = new Date(Date.UTC(day.year, day.month - 1, day.day, 0, 0, 0, 0));
  const to = new Date(
    Date.UTC(day.year, day.month - 1, day.day, 23, 59, 59, 999),
  );
  return { from, to };
}

/** True UTC instants spanning an IST civil day (for Date.parse range checks). */
export function istCivilDayTrueUtcBounds(day: IstCivilDay): {
  from: Date;
  to: Date;
} {
  const from = new Date(
    Date.parse(nseWallTimeToUtcIso(day.year, day.month - 1, day.day, 0, 0, 0)),
  );
  const toMs =
    Date.parse(
      nseWallTimeToUtcIso(day.year, day.month - 1, day.day, 23, 59, 59),
    ) + 999;
  return { from, to: new Date(toMs) };
}

/** Noon UTC on the civil Y-M-D — IST day is stable under formatNseApiDateFromInstant. */
export function istCivilDayToUtcNoon(day: IstCivilDay): Date {
  return new Date(Date.UTC(day.year, day.month - 1, day.day, 12, 0, 0));
}

/** IST civil day span ending today, going `daysBack` calendar days earlier. */
export function istRangeDaysBack(daysBack: number): {
  from: IstCivilDay;
  to: IstCivilDay;
} {
  const to = istTodayParts();
  const from = shiftIstCivilDay(to, -Math.max(0, daysBack));
  return { from, to };
}

/**
 * IST day window `offset` days ago (0 = today).
 * Returns API strings + UTC bounds.
 */
export function istDayWindow(offsetDaysAgo: number): {
  day: IstCivilDay;
  from: Date;
  to: Date;
  nseApiFrom: string;
  nseApiTo: string;
  bseApiFrom: string;
  bseApiTo: string;
} {
  const day = shiftIstCivilDay(istTodayParts(), -Math.max(0, offsetDaysAgo));
  const { from, to } = istCivilDayUtcBounds(day);
  const api = formatNseApiDate(day);
  const bse = formatBseApiDate(day);
  return {
    day,
    from,
    to,
    nseApiFrom: api,
    nseApiTo: api,
    bseApiFrom: bse,
    bseApiTo: bse,
  };
}

/** Format a Date's IST civil day as NSE DD-MM-YYYY (for range queries). */
export function formatNseApiDateFromInstant(d: Date): string {
  return formatNseApiDate(istTodayParts(d));
}

/** Format a Date's IST civil day as BSE YYYYMMDD. */
export function formatBseApiDateFromInstant(d: Date): string {
  return formatBseApiDate(istTodayParts(d));
}

export function formatIstTime(
  iso: string,
  opts?: Intl.DateTimeFormatOptions,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", {
    timeZone: INDIA_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...opts,
  });
}

export function formatIstMonthYear(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-IN", {
    timeZone: INDIA_TZ,
    month: "short",
    year: "numeric",
  });
}

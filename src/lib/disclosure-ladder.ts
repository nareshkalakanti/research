import { createNseBuybackSession } from "./nse-buybacks";
import { isBuybackSubject } from "./strategy/buyback-parse";
import { isFinancialEarnAnnouncement } from "./strategy/concall-drift-earn";

const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

export type DisclosureLadderTag = "EARNINGS" | "IR" | "UPDATE" | "BUYBACK";

export type DisclosureLadderItem = {
  announced_at: string;
  time_label: string;
  tag: DisclosureLadderTag;
  title: string;
  url: string | null;
  is_trigger: boolean;
  badge: string | null;
};

type NseAnnRow = Record<string, unknown>;
type NseJar = Awaited<ReturnType<typeof createNseBuybackSession>>;

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function nseAnnIndex(market: string | null | undefined): Array<"sme" | "equities"> {
  const mk = (market || "").trim().toUpperCase();
  if (mk === "NSE SME") return ["sme", "equities"];
  return ["equities", "sme"];
}

function parseNseDateTime(raw: unknown): string | null {
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
    const d = new Date(
      Number(m[3]),
      mon,
      Number(m[1]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0),
    );
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isPureNoise(desc: string, attachmentText: string): boolean {
  const blob = `${desc} ${attachmentText}`.toLowerCase();
  return (
    /postal ballot|agm notice|record date only|change in management|resignation of director|appointment of director|related party transaction|credit rating.*without.*result/i.test(
      blob,
    ) &&
    !/financial result|outcome of board|investor presentation|transcript|concall|press release|buyback/i.test(
      blob,
    )
  );
}

function classifyLadderRow(row: NseAnnRow): {
  tag: DisclosureLadderTag;
  title: string;
  badge: string | null;
} | null {
  const desc = safeStr(row.desc);
  const attachmentText = safeStr(row.attchmntText);
  const file = safeStr(row.attchmntFile).toLowerCase();
  const blob = `${desc} ${attachmentText} ${file}`;
  if (isPureNoise(desc, attachmentText)) return null;

  if (isBuybackSubject(desc) || /buy\s*back|buyback|repurchase/i.test(blob)) {
    return {
      tag: "BUYBACK",
      title: desc || attachmentText || "Buyback",
      badge: null,
    };
  }

  if (isFinancialEarnAnnouncement(desc, attachmentText, file)) {
    return {
      tag: "EARNINGS",
      title: desc || attachmentText || "Outcome of Board Meeting",
      badge: "TRIGGER",
    };
  }

  if (
    /transcript|con\.?\s*call|concall|conference call|investor meet|analyst meet|institutional investor/i.test(
      blob,
    )
  ) {
    return {
      tag: "IR",
      title: desc || attachmentText || "Concall / investor meet",
      badge: null,
    };
  }

  if (/press release/i.test(blob)) {
    return {
      tag: "UPDATE",
      title: desc || "Press Release",
      badge: "PRESS REL",
    };
  }

  if (/newspaper publication/i.test(blob)) {
    return {
      tag: "UPDATE",
      title: desc || "Copy of Newspaper Publication",
      badge: null,
    };
  }

  if (/investor presentation|earnings presentation|analyst presentation/i.test(blob)) {
    return {
      tag: "UPDATE",
      title: desc || "Investor Presentation",
      badge: null,
    };
  }

  if (/outcome of board|financial result|integrated filing- financial/i.test(blob)) {
    return {
      tag: "EARNINGS",
      title: desc || "Financial Results",
      badge: null,
    };
  }

  if (/update|clarification|revision|revised|share capital audit|reconciliation/i.test(blob)) {
    return {
      tag: "UPDATE",
      title: desc || attachmentText || "Updates",
      badge: null,
    };
  }

  return null;
}

async function fetchNseAnnouncements(
  symbol: string,
  index: "sme" | "equities",
  from: Date,
  to: Date,
  jar: NseJar,
): Promise<NseAnnRow[]> {
  const dd = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

  const u = new URL(CORP_ANN_URL);
  u.searchParams.set("index", index);
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("from_date", dd(from));
  u.searchParams.set("to_date", dd(to));

  const res = await fetch(u.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: NSE_ANN_REF,
      Cookie: jar.cookie,
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as unknown;
  return Array.isArray(rows) ? (rows as NseAnnRow[]) : [];
}

function parseLadderRows(rows: NseAnnRow[], windowStart: number, windowEnd: number): DisclosureLadderItem[] {
  const out: DisclosureLadderItem[] = [];
  const seenSeq = new Set<string>();

  for (const row of rows) {
    const classified = classifyLadderRow(row);
    if (!classified) continue;

    const announced_at =
      parseNseDateTime(row.an_dt) ||
      parseNseDateTime(row.sort_date) ||
      parseNseDateTime(row.dt);
    if (!announced_at) continue;

    const ts = Date.parse(announced_at);
    if (ts < windowStart || ts > windowEnd) continue;

    const seq = safeStr(row.seq_id);
    if (seq) {
      if (seenSeq.has(seq)) continue;
      seenSeq.add(seq);
    }

    out.push({
      announced_at,
      time_label: formatTimeLabel(announced_at),
      tag: classified.tag,
      title: classified.title,
      url: safeStr(row.attchmntFile).startsWith("http") ? safeStr(row.attchmntFile) : null,
      is_trigger: false,
      badge: classified.badge,
    });
  }

  out.sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at));
  return out;
}

/** NSE filings around an earn/concall event — chronological disclosure ladder. */
export async function fetchDisclosureLadder(
  ticker: string,
  market: string | null | undefined,
  anchorIso: string,
  earnAtIso?: string | null,
): Promise<DisclosureLadderItem[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol || !anchorIso) return [];

  const anchorMs = Date.parse(anchorIso);
  if (Number.isNaN(anchorMs)) return [];

  const windowStart = anchorMs - 18 * 60 * 60 * 1000;
  const windowEnd = anchorMs + 48 * 60 * 60 * 1000;

  const from = new Date(windowStart);
  from.setHours(0, 0, 0, 0);
  const to = new Date(windowEnd);
  to.setHours(23, 59, 59, 999);

  const jar = await createNseBuybackSession();
  const rows: NseAnnRow[] = [];
  const seenSeq = new Set<string>();

  for (const index of nseAnnIndex(market)) {
    try {
      for (const row of await fetchNseAnnouncements(symbol, index, from, to, jar)) {
        const seq = safeStr(row.seq_id);
        if (seq && seenSeq.has(seq)) continue;
        if (seq) seenSeq.add(seq);
        rows.push(row);
      }
      if (rows.length > 0) break;
    } catch {
      /* try next index */
    }
  }

  const ladder = parseLadderRows(rows, windowStart, windowEnd);
  if (!ladder.length) return ladder;

  const triggerTs = earnAtIso ? Date.parse(earnAtIso) : anchorMs;
  let triggerIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < ladder.length; i += 1) {
    const item = ladder[i]!;
    if (item.tag !== "EARNINGS") continue;
    const delta = Math.abs(Date.parse(item.announced_at) - triggerTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      triggerIdx = i;
    }
  }
  if (ladder[triggerIdx]) {
    ladder[triggerIdx] = { ...ladder[triggerIdx]!, is_trigger: true, badge: "TRIGGER" };
  }

  return ladder;
}

export function formatLadderForPrompt(ladder: DisclosureLadderItem[]): string {
  if (!ladder.length) return "No NSE filings in event window.";
  return ladder
    .map(
      (item) =>
        `${formatShortTime(item.announced_at)} [${item.tag}] ${item.title}${item.is_trigger ? " (TRIGGER)" : ""}`,
    )
    .join("\n");
}

export { formatShortTime as ladderShortTime };

/**
 * Parse board tables from screenshots: Zauba (DIN | Name | Role) and
 * exchange CG (Director | Position | DIN), including OCR HTML tables.
 * Client-safe. No issuer lists.
 */
import {
  inferDirectorCategory,
  isPlaceholderDin,
  normDin,
  type BoardSeat,
} from "./nse-governance";

export type ScreenshotBoardExtract = {
  company: string | null;
  ticker: string | null;
  seats: BoardSeat[];
};

const ROLE =
  /Whole[\s-]*time(?:\s+director)?|Additional\s+Director|Managing\s+Director|Independent(?:\s+Director)?|Non[\s-]*Executive(?:\s+Director)?|Director|Chair(?:man|person)?|CEO|MD|KMP/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Vision OCR often returns the Zauba HTML table, not plain rows. */
export function flattenOcrHtml(text: string): string {
  const raw = text || "";
  if (!/<t[rdh]|<table/i.test(raw)) return raw;
  const lines: string[] = [];
  for (const tr of raw.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
      (c) => stripTags(c[1]!),
    );
    const line = cells.filter(Boolean).join(" ");
    if (line) lines.push(line);
  }
  const leftover = stripTags(raw);
  return [...lines, leftover].filter(Boolean).join("\n");
}

const ROLE_HEAD =
  /Non[\s-]*Executive|Whole[\s-]*[Tt]ime|Independent|Executive Director|Managing Director|Nominee|Additional Director/;

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
      (c) => stripTags(c[1]!),
    );
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

function colKind(header: string): "din" | "name" | "role" | "" {
  const t = header.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (t === "din" || t.endsWith(" din")) return "din";
  if (/\bposition\b|\bdesignation\b|\bstatus\b|\brole\b/.test(t)) return "role";
  if (/\bdirector name\b|\bdirector\b|\bname\b/.test(t) && !/\bcompany\b/.test(t)) {
    return "name";
  }
  return "";
}

function seatsFromHtmlTables(
  text: string,
  seats: BoardSeat[],
  seen: Set<string>,
): void {
  if (!/<t[rdh]|<table/i.test(text)) return;
  for (const tableHtml of text.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = tableRows(tableHtml[0]!);
    if (rows.length < 2) continue;
    const kinds = rows[0]!.map(colKind);
    let dinIdx = kinds.indexOf("din");
    let nameIdx = kinds.indexOf("name");
    let roleIdx = kinds.indexOf("role");
    let body = rows.slice(1);
    if (dinIdx < 0 || nameIdx < 0) {
      const guess = guessNameRoleDin(rows[0]!);
      if (!guess) continue;
      dinIdx = guess.dinIdx;
      nameIdx = guess.nameIdx;
      roleIdx = guess.roleIdx;
      body = rows;
    }
    for (const cells of body) {
      addSeat(
        seats,
        seen,
        cells[dinIdx] || "",
        cells[nameIdx] || "",
        (roleIdx >= 0 ? cells[roleIdx] : "") || "Director",
      );
    }
  }
}

/** Director | Position | DIN with no usable header. */
function guessNameRoleDin(
  cells: string[],
): { dinIdx: number; nameIdx: number; roleIdx: number } | null {
  let dinIdx = -1;
  let nameIdx = -1;
  let roleIdx = -1;
  cells.forEach((c, i) => {
    if (digitsToDin(c).length === 8) dinIdx = i;
    else if (ROLE_HEAD.test(c) || ROLE.test(c)) roleIdx = i;
    else if (/^[A-Za-z][A-Za-z .'-]{3,}$/.test(c) && c.length >= 5) nameIdx = i;
  });
  if (dinIdx < 0 || nameIdx < 0) return null;
  return { dinIdx, nameIdx, roleIdx };
}

function splitNameThenRole(rest: string): { name: string; designation: string } {
  const cleaned = rest.replace(/\s+/g, " ").trim();
  const idx = cleaned.search(ROLE_HEAD);
  if (idx > 2) {
    return {
      name: cleaned.slice(0, idx).trim(),
      designation: cleaned.slice(idx).trim(),
    };
  }
  return splitNameAndRole(cleaned);
}

function digitsToDin(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 8) return normDin(d);
  if (d.length === 9 && d.startsWith("0")) return normDin(d.slice(-8));
  if (d.length === 7) return normDin(d);
  return "";
}

function addSeat(
  seats: BoardSeat[],
  seen: Set<string>,
  dinRaw: string,
  nameRaw: string,
  designationRaw: string,
): void {
  const din = digitsToDin(dinRaw);
  if (!din || din.length !== 8 || isPlaceholderDin(din)) return;
  const name = nameRaw.replace(/\s+/g, " ").trim();
  const designation = (designationRaw || "Director").replace(/\s+/g, " ").trim();
  if (!din || din.length !== 8 || name.length < 5) return;
  if (/^(din|director name|director|position|designation|appointment|status|#)$/i.test(name)) return;
  if (seen.has(din)) return;
  seen.add(din);
  seats.push({
    din,
    name,
    designation,
    category: inferDirectorCategory(designation),
    source: "zauba_screenshot",
    as_of: "",
  });
}

function splitNameAndRole(rest: string): { name: string; designation: string } {
  const cleaned = rest
    .replace(/\d{4}-\d{2}-\d{2}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const m = cleaned.match(new RegExp(`^(.*?)\\s+(${ROLE.source})\\s*$`, "i"));
  if (m) {
    return {
      name: m[1]!.trim(),
      designation: m[2]!.trim(),
    };
  }
  return { name: cleaned, designation: "Director" };
}

export function parseListedTickerFromBoardText(text: string): string | null {
  const blob = flattenOcrHtml(text || "");
  const m = blob.match(/\(\s*(?:NSE|BSE)\s*:\s*([A-Z][A-Z0-9-]{0,19})\s*\)/i);
  const t = (m?.[1] || "").toUpperCase();
  return t || null;
}

export function parseCompanyFromDirectorTable(text: string): string | null {
  const raw = (text || "").replace(/\s+/g, " ").trim();
  const around = raw.match(
    /([A-Za-z0-9 .,'&()-]{8,110})\(\s*(?:NSE|BSE)\s*:/i,
  );
  if (around) {
    const bit = around[1]!.replace(/^\s*(yes\.?\s*)+/i, "").trim();
    const lim = bit.match(/([A-Z][A-Za-z0-9 .,'&()-]{4,90}?\bLimited)\s*$/i);
    if (lim) return lim[1]!.replace(/\s+/g, " ").trim();
  }
  const blob = flattenOcrHtml(text || "").replace(/\s+/g, " ").trim();
  const titled = blob.match(
    /(?:Directors|Personnel)\s+(?:&|and)?\s*Key\s*Managerial\s*Personnel\s+of\s+([A-Za-z0-9][A-Za-z0-9 &.'/-]{2,80}?)(?:\s+Current|\s+DIN\b|$)/i,
  );
  if (titled) return titled[1]!.replace(/\s+/g, " ").trim();
  if (parseListedTickerFromBoardText(text)) return null;
  const of = blob.match(
    /\bof\s+([A-Za-z0-9][A-Za-z0-9 &.'/-]{2,80}?)(?:\s+Current|\s+DIN\b|$)/i,
  );
  return of ? of[1]!.replace(/\s+/g, " ").trim() : null;
}

export function parseDirectorSeatsFromTable(text: string): BoardSeat[] {
  const seats: BoardSeat[] = [];
  const seen = new Set<string>();
  seatsFromHtmlTables(text || "", seats, seen);
  if (!seats.length && /<tr/i.test(text || "")) {
    seatsFromHtmlTables(`<table>${text}</table>`, seats, seen);
  }
  const normalized = flattenOcrHtml(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\|/g, " ")
    .replace(/[–—]/g, "-");

  for (const rawLine of normalized.split(/\n+/)) {
    const row = rawLine.replace(/\s+/g, " ").trim();
    if (!row) continue;
    const trailing = row.match(/^(.*?)\s+(\d{8})\s*$/);
    if (trailing && !/^\d{7,9}\s/.test(row)) {
      const rest = trailing[1]!.replace(/^\d{1,3}\s+/, "");
      const { name, designation } = splitNameThenRole(rest);
      addSeat(seats, seen, trailing[2]!, name, designation);
      continue;
    }
    const m = row.match(/^(\d{7,9})\s+(.+)$/);
    if (!m) continue;
    const { name, designation } = splitNameAndRole(m[2]!);
    addSeat(seats, seen, m[1]!, name, designation);
  }

  const packed = new RegExp(
    String.raw`\b(\d{8})\b\s+([A-Za-z][A-Za-z .'-]{2,70}?)\s+(${ROLE.source})\b`,
    "gi",
  );
  let hit: RegExpExecArray | null;
  while ((hit = packed.exec(normalized)) != null) {
    addSeat(seats, seen, hit[1]!, hit[2]!, hit[3]!);
  }

  return seats;
}

export function parseScreenshotBoard(text: string): ScreenshotBoardExtract {
  return {
    company: parseCompanyFromDirectorTable(text),
    ticker: parseListedTickerFromBoardText(text),
    seats: parseDirectorSeatsFromTable(text),
  };
}

/**
 * Parse Zauba-style Current Directors tables (DIN | Name | Designation).
 * Client-safe. No issuer lists.
 */
import { inferDirectorCategory, normDin, type BoardSeat } from "./nse-governance";

export type ScreenshotBoardExtract = {
  company: string | null;
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
  const name = nameRaw.replace(/\s+/g, " ").trim();
  const designation = (designationRaw || "Director").replace(/\s+/g, " ").trim();
  if (!din || din.length !== 8 || name.length < 5) return;
  if (/^(din|director name|designation|appointment)$/i.test(name)) return;
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

export function parseCompanyFromDirectorTable(text: string): string | null {
  const blob = flattenOcrHtml(text || "").replace(/\s+/g, " ").trim();
  const titled = blob.match(
    /(?:Directors|Personnel)\s+(?:&|and)?\s*Key\s*Managerial\s*Personnel\s+of\s+([A-Za-z0-9][A-Za-z0-9 &.'/-]{2,80}?)(?:\s+Current|\s+DIN\b|$)/i,
  );
  if (titled) return titled[1]!.replace(/\s+/g, " ").trim();
  const of = blob.match(
    /\bof\s+([A-Za-z0-9][A-Za-z0-9 &.'/-]{2,80}?)(?:\s+Current|\s+DIN\b|$)/i,
  );
  return of ? of[1]!.replace(/\s+/g, " ").trim() : null;
}

export function parseDirectorSeatsFromTable(text: string): BoardSeat[] {
  const seats: BoardSeat[] = [];
  const seen = new Set<string>();
  const normalized = flattenOcrHtml(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\|/g, " ")
    .replace(/[–—]/g, "-");

  for (const rawLine of normalized.split(/\n+/)) {
    const row = rawLine.replace(/\s+/g, " ").trim();
    if (!row) continue;
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
    seats: parseDirectorSeatsFromTable(text),
  };
}

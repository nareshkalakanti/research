/**
 * Parse Zauba-style Current Directors tables (DIN | Name | Designation).
 * Client-safe. No issuer lists.
 */
import { inferDirectorCategory, normDin, type BoardSeat } from "./nse-governance";

export type ScreenshotBoardExtract = {
  company: string | null;
  seats: BoardSeat[];
};

function digitsToDin(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 8) return normDin(d);
  if (d.length === 9 && d.startsWith("0")) return normDin(d.slice(-8));
  if (d.length === 7) return normDin(d);
  return "";
}

export function parseCompanyFromDirectorTable(text: string): string | null {
  const blob = (text || "").replace(/\s+/g, " ").trim();
  const of = blob.match(
    /(?:personnel|directors|of)\s+of\s+([A-Z0-9][A-Z0-9 &.'/-]{2,80}?)(?:\s*$|\s+Current)/i,
  );
  if (of) return of[1]!.replace(/\s+/g, " ").trim();
  const titled = blob.match(
    /Directors\s*&?\s*Key\s*Managerial\s*Personnel\s+of\s+([A-Z0-9][A-Z0-9 &.'/-]{2,80})/i,
  );
  return titled ? titled[1]!.replace(/\s+/g, " ").trim() : null;
}

export function parseDirectorSeatsFromTable(text: string): BoardSeat[] {
  const seats: BoardSeat[] = [];
  const seen = new Set<string>();
  const lines = (text || "").split(/\n+/);

  for (const line of lines) {
    const row = line.replace(/\s+/g, " ").trim();
    if (!row) continue;
    const m = row.match(
      /^(\d{7,9})\s+([A-Z][A-Z .'-]{3,70}?)\s+(Director|Managing Director|Whole[\s-]?time|Independent|Non[\s-]?Executive|Chair(?:man|person)?|CEO|MD|KMP)\b/i,
    );
    if (!m) continue;
    const din = digitsToDin(m[1]!);
    const name = m[2]!.replace(/\s+/g, " ").trim();
    if (!din || din.length !== 8 || name.length < 5) continue;
    if (seen.has(din)) continue;
    seen.add(din);
    const designation = m[3]!.replace(/\s+/g, " ").trim();
    seats.push({
      din,
      name,
      designation,
      category: inferDirectorCategory(designation),
      source: "zauba_screenshot",
      as_of: "",
    });
  }

  if (seats.length) return seats;

  const re =
    /\b(\d{7,9})\b[^\n]{0,8}([A-Z][A-Z .'-]{4,70}?)(?=\s+(?:Director|Managing|Independent|DIN)\b)/gi;
  let hit: RegExpExecArray | null;
  const blob = text || "";
  while ((hit = re.exec(blob)) != null) {
    const din = digitsToDin(hit[1]!);
    const name = hit[2]!.replace(/\s+/g, " ").trim();
    if (!din || seen.has(din) || name.length < 5) continue;
    seen.add(din);
    seats.push({
      din,
      name,
      designation: "Director",
      category: inferDirectorCategory("Director"),
      source: "zauba_screenshot",
      as_of: "",
    });
  }
  return seats;
}

export function parseScreenshotBoard(text: string): ScreenshotBoardExtract {
  return {
    company: parseCompanyFromDirectorTable(text),
    seats: parseDirectorSeatsFromTable(text),
  };
}

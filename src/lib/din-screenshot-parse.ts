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

function plainBoardText(text: string): string {
  return stripTags(text || "");
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

function followOnDesignation(
  lines: string[],
  dinLineIdx: number,
  fallback: string,
): string {
  for (let j = dinLineIdx + 1; j < lines.length; j++) {
    const line = lines[j]!;
    if (!line) continue;
    if (/^\d{7,9}\b/.test(line) || /\b\d{8}\b/.test(line)) break;
    const labeled = line.match(/^(?:designation|role)\s*:\s*(.+)$/i);
    if (!labeled) {
      if (/^(note|notes)\s*:/i.test(line)) continue;
      break;
    }
    const val = labeled[1]!.trim();
    if (ROLE.test(val) || ROLE_HEAD.test(val)) return val;
    if (/^(designation|role)$/i.test(labeled[1] || "")) continue;
  }
  return fallback;
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
    .replace(/\s+[-–—.]\s*$/, "")
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

const ZAUBA_HOUSE =
  /(?:Directors|Personnel)\s+(?:&|and|&amp;)?\s*Key\s*Managerial\s*Personnel\s+of\s+([\s\S]+?)(?=\s+Current\s+Directors|\s+DIN\b|\s+\d{7,9}\b|$)/i;

const STOP_BANNER =
  /^(din|director name|designation|appointment date|appointment|status|#)$/i;

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function labelsFromBannerLines(text: string): string[] {
  const lines = (text || "")
    .split(/\n+/)
    .map((l) => collapseWs(l))
    .filter(Boolean);
  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const name = collapseWs(buf.join(" "));
    buf = [];
    if (name.length >= 6 && name.length <= 90) out.push(name);
  };
  for (const line of lines) {
    if (/\d{7,9}/.test(line) && !/personnel of/i.test(line)) {
      flush();
      break;
    }
    const of = line.match(/personnel of\s+(.+)/i);
    if (of?.[1]) {
      flush();
      buf = [of[1].trim()];
      continue;
    }
    if (STOP_BANNER.test(line) || /^current directors\b/i.test(line)) {
      flush();
      continue;
    }
    const letters = line.replace(/[^A-Za-z]/g, "");
    if (
      letters.length >= 4 &&
      letters === letters.toUpperCase() &&
      !/^(DIN|DIRECTOR|NAME|DESIGNATION|APPOINTMENT|DATE|CURRENT)$/i.test(line)
    ) {
      buf.push(line);
      continue;
    }
    flush();
  }
  flush();
  return out;
}

export function parseListedTickerFromBoardText(text: string): string | null {
  const blob = flattenOcrHtml(text || "");
  const m = blob.match(/\(\s*(?:NSE|BSE)\s*:\s*([A-Z][A-Z0-9-]{0,19})\s*\)/i);
  const t = (m?.[1] || "").toUpperCase();
  if (t) return t;
  const listed = blob.match(
    /\bLimited\s*\(\s*([A-Z][A-Z0-9-]{1,19})\s*\)/i,
  );
  const sym = (listed?.[1] || "").toUpperCase();
  if (sym && !/^(NSE|BSE|DIN|CEO|CFO|KMP)$/.test(sym)) return sym;
  return null;
}

export function parseCompanyLabelsFromBoardText(text: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = collapseWs(raw);
    if (name.length < 3 || name.length > 90) return;
    if (/^(din|director|current)$/i.test(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(name);
  };
  const nseCo = parseCompanyFromDirectorTable(text);
  if (nseCo) add(nseCo);
  for (const blob of [
    plainBoardText(text),
    collapseWs(flattenOcrHtml(text || "")),
    flattenOcrHtml(text || ""),
  ]) {
    const titled = blob.match(ZAUBA_HOUSE);
    if (titled) add(titled[1]!);
    for (const m of blob.matchAll(
      /Personnel of\s+([\s\S]+?)(?=\s+Current\s+Directors|\s+DIN\b|\s+\d{7,9}\b|<|$)/gi,
    )) {
      add(m[1]!);
    }
  }
  for (const b of labelsFromBannerLines(text)) add(b);
  return labels;
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
  const blob = [plainBoardText(text), flattenOcrHtml(text || "")]
    .map((t) => t.replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" \n ");
  const titled = blob.match(ZAUBA_HOUSE);
  if (titled) {
    const name = titled[1]!.replace(/\s+/g, " ").trim();
    if (name.length >= 3) return name;
  }
  if (parseListedTickerFromBoardText(text)) return null;
  const of = blob.match(
    /\bof\s+([A-Za-z0-9][A-Za-z0-9 &.'()/-]{2,80}?)(?=\s+Current\s+Directors|\s+DIN\b|\s+\d{7,9}\b|$)/i,
  );
  if (of) return of[1]!.replace(/\s+/g, " ").trim();
  return labelsFromBannerLines(text)[0] || null;
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

  const lines = normalized.split(/\n+/).map((rawLine) =>
    rawLine
      .replace(/^\s*[•·●▪◦]\s*/, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

  for (let i = 0; i < lines.length; i++) {
    const row = lines[i]!;
    if (!row) continue;
    const labeledDin = row.match(
      /^(.*?)\s*\(([^)]+)\)\s*(?:\||DIN)\s*:?\s*(?:DIN\s*:?\s*)?(\d{7,9})\s*$/i,
    );
    if (!labeledDin) {
      const alt = row.match(/^(.*?)\s+DIN\s*:\s*(\d{7,9})\s*$/i);
      if (alt) {
        addSeat(seats, seen, alt[2]!, alt[1]!, "Director");
        continue;
      }
    } else {
      addSeat(
        seats,
        seen,
        labeledDin[3]!,
        labeledDin[1]!.replace(/^\d+[.)]\s*/, "").trim(),
        labeledDin[2]!.trim() || "Director",
      );
      continue;
    }
    const trailing = row.match(/^(.*?)\s+(\d{8})\s*$/);
    if (trailing && !/^\d{7,9}\s/.test(row)) {
      const rest = trailing[1]!.replace(/^\d{1,3}\s+/, "");
      const { name, designation } = splitNameThenRole(rest);
      addSeat(
        seats,
        seen,
        trailing[2]!,
        name,
        followOnDesignation(lines, i, designation),
      );
      continue;
    }
    const m = row.match(/^(\d{7,9})\s+-?\s*(.+)$/);
    if (!m) continue;
    const { name, designation } = splitNameAndRole(m[2]!);
    addSeat(
      seats,
      seen,
      m[1]!,
      name,
      followOnDesignation(lines, i, designation),
    );
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

const LISTED_HEAD =
  /^[^\n]*?\b([A-Za-z0-9][A-Za-z0-9 .,'&()-]{3,90}?\bLimited)\s*\(\s*([A-Z][A-Z0-9-]{1,19})\s*\)\s*$/i;

/** One or more listed companies, each with Name (role) | DIN: lines. */
export function parseTickerBoardNotes(text: string): ScreenshotBoardExtract[] {
  const lines = flattenOcrHtml(text || "")
    .replace(/\u00a0/g, " ")
    .split(/\n+/);
  const chunks: Array<{ company: string; ticker: string; body: string[] }> = [];
  let cur: { company: string; ticker: string; body: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/^\s*[•·●▪◦💊⚡🏢\d.)]+\s*/, "").trim();
    if (!line) continue;
    const head = line.match(LISTED_HEAD) || raw.match(LISTED_HEAD);
    if (head) {
      const ticker = head[2]!.toUpperCase();
      if (/^(NSE|BSE|DIN|CEO|CFO|KMP)$/.test(ticker)) continue;
      cur = {
        company: head[1]!.replace(/\s+/g, " ").trim(),
        ticker,
        body: [],
      };
      chunks.push(cur);
      continue;
    }
    if (cur) cur.body.push(raw);
  }
  return chunks
    .map((c) => ({
      company: c.company,
      ticker: c.ticker,
      seats: parseDirectorSeatsFromTable(c.body.join("\n")),
    }))
    .filter((c) => c.seats.length > 0);
}

export type PersonCompanyRole = {
  name: string;
  din: string;
  designation: string;
  company: string;
};

function compactRole(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (/\bcfo\b|chief financial/i.test(t)) return "CFO";
  if (/\bceo\b|chief executive/i.test(t)) return "CEO";
  if (/managing director|\bmd\b/i.test(t)) return "Managing Director";
  if (/company secretary|\bcs\b/i.test(t)) return "Company Secretary";
  if (/chair(?:man|person)?/i.test(t)) return "Chairperson";
  if (/director/i.test(t)) {
    const bits = t.match(
      /((?:non[-\s]?executive|independent|executive|additional|nominee|whole[-\s]?time)\s+)*director/i,
    );
    const rawRole = bits?.[0]?.replace(/\s+/g, " ").trim() || "Director";
    return rawRole.replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return t || "Director";
}

function splitRoleCompany(clause: string): { designation: string; company: string } | null {
  const t = clause.replace(/[,.;]+$/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const ofBoard = t.match(
    /^(.*?director(?:\s+on(?:\s+the)?\s+board)?)\s+(?:of\s+)(.+)$/i,
  );
  if (ofBoard?.[2]) {
    return { designation: compactRole(ofBoard[1]!), company: ofBoard[2].trim() };
  }
  const dash = t.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dash?.[2] && /director|cfo|ceo|officer|secretary|chair|kmp|md\b/i.test(dash[1]!)) {
    return { designation: compactRole(dash[1]!), company: dash[2].trim() };
  }
  const of = t.match(/^(.+?)\s+of\s+(.+)$/i);
  if (of?.[2] && /director|cfo|ceo|officer|secretary|chair|kmp|md\b/i.test(of[1]!)) {
    return { designation: compactRole(of[1]!), company: of[2].trim() };
  }
  return null;
}

/** Bios: "Name (DIN) - director of Company A & CFO - Company B". */
export function parsePersonCompanyRoles(text: string): PersonCompanyRole[] {
  const blob = plainBoardText(text || "").replace(/[–—]/g, "-");
  const out: PersonCompanyRole[] = [];
  const seen = new Set<string>();
  const personRe =
    /([A-Za-z][A-Za-z .'-]{2,80}?)\s*\((\d{8})\)\s*(?:[-,:]\s*)?([\s\S]*?)(?=(?:[A-Za-z][A-Za-z .'-]{2,80}?\s*\(\d{8}\))|$)/g;
  let m: RegExpExecArray | null;
  while ((m = personRe.exec(blob)) != null) {
    const name = m[1]!.replace(/\s+/g, " ").trim();
    const din = m[2]!;
    const rest = (m[3] || "").trim();
    const clauses = rest
      .split(
        /\s*(?:&|;|\n)\s*(?=(?:Chief|CFO|CEO|Director|Managing|Company Secretary|KMP|Chair))/i,
      )
      .map((c) => c.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      const split = splitRoleCompany(clause);
      if (!split || split.company.length < 3) continue;
      const key = `${din}|${split.company.toLowerCase()}|${split.designation.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        din,
        designation: split.designation,
        company: split.company.replace(/\s+/g, " ").trim(),
      });
    }
  }
  return out;
}

export function parseScreenshotBoard(text: string): ScreenshotBoardExtract {
  const labels = parseCompanyLabelsFromBoardText(text);
  return {
    company: labels[0] || parseCompanyFromDirectorTable(text),
    ticker: parseListedTickerFromBoardText(text),
    seats: parseDirectorSeatsFromTable(text),
  };
}

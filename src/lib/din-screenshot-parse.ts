/**
 * Parse board tables from screenshots: Zauba (DIN | Name | Role),
 * research tables (Name | DIN | Designation), and exchange CG
 * (Director | Position | DIN), including OCR HTML tables.
 * Client-safe. No issuer lists.
 */
import { isPlaceholderDirectorName } from "./gov-director-name";
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
  /Executive\s+Chair(?:man|person)?|Chair(?:man|person)|Whole[\s-]*time(?:\s+director)?|Additional\s+Director|Managing\s+Director|Independent(?:\s+Director)?|Non[\s-]*Executive(?:\s*,?\s*Non[\s-]*Independent)?(?:\s+Independent)?(?:\s+Director)?|Executive\s+Director|Director|CEO|CFO|MD|KMP/i;

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
  /Executive\s+Chair(?:man|person)?|Non[\s-]*Executive|Whole[\s-]*[Tt]ime|Independent|Executive\s+Director|Managing\s+Director|Nominee|Additional\s+Director|Chair(?:man|person)/i;

/** Drop citation chips OCR often appends under DIN cells. */
function scrubBoardNoise(text: string): string {
  return (text || "")
    .replace(/\barchives\.nseindia\b/gi, " ")
    .replace(/\bnseindia\.com\b/gi, " ")
    .replace(/\+\s*\d+\b/g, " ")
    .replace(/\b(?:source|citation)s?\s*:\s*/gi, " ");
}

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

function splitNameThenRole(rest: string): {
  name: string;
  designation: string;
  as_of: string | null;
} {
  const as_of = extractAppointmentDate(rest);
  const cleaned = rest
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const idx = cleaned.search(ROLE_HEAD);
  if (idx > 2) {
    return {
      name: cleaned.slice(0, idx).trim(),
      designation: cleaned.slice(idx).trim(),
      as_of,
    };
  }
  return splitNameAndRole(rest);
}

function digitsToDin(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 8) return normDin(d);
  if (d.length === 9 && d.startsWith("0")) return normDin(d.slice(-8));
  if (d.length === 7) return normDin(d);
  return "";
}

/** Role / column labels OCR sometimes puts in the name field. */
function looksLikePersonName(name: string): boolean {
  const t = name.replace(/\s+/g, " ").trim();
  if (t.length < 5) return false;
  if (isPlaceholderDirectorName(t)) return false;
  if (
    /^(din|director name|director|position|designation|appointment|status|no|#)$/i.test(
      t,
    )
  ) {
    return false;
  }
  const folded = t.replace(/[^a-z]+/gi, " ").replace(/\s+/g, " ").trim();
  if (
    /^(managing|whole\s*time|independent|additional|non\s*executive|executive|nominee|director|chairperson|chairman|ceo|cfo|md|kmp)(\s+director)?$/i.test(
      folded,
    )
  ) {
    return false;
  }
  // Entire string is a role phrase (e.g. "Managing Director", "Whole-time Director").
  if (ROLE.test(t) || ROLE_HEAD.test(t)) {
    const withoutRole = folded
      .replace(
        /managing|whole\s*time|independent|additional|non\s*executive|executive|nominee|director|chairperson|chairman|ceo|cfo|md|kmp/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
    if (!withoutRole) return false;
  }
  return true;
}

function addSeat(
  seats: BoardSeat[],
  seen: Set<string>,
  dinRaw: string,
  nameRaw: string,
  designationRaw: string,
  asOfRaw?: string | null,
): void {
  const din = digitsToDin(dinRaw);
  if (!din || din.length !== 8 || isPlaceholderDin(din)) return;
  const name = titleCasePersonName(nameRaw.replace(/\s+/g, " ").trim());
  let designation = (designationRaw || "Director").replace(/\s+/g, " ").trim();
  const asOf =
    extractAppointmentDate(asOfRaw || "") ||
    extractAppointmentDate(designation) ||
    extractAppointmentDate(nameRaw) ||
    "";
  designation = designation
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Director";
  if (!din || din.length !== 8 || !looksLikePersonName(name)) return;
  if (seen.has(din)) return;
  seen.add(din);
  seats.push({
    din,
    name,
    designation,
    category: inferDirectorCategory(designation),
    source: "zauba_screenshot",
    as_of: asOf,
  });
}

function splitNameAndRole(rest: string): {
  name: string;
  designation: string;
  as_of: string | null;
} {
  const as_of = extractAppointmentDate(rest);
  const cleaned = rest
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g, " ")
    .replace(/\s+[-–—.]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const m = cleaned.match(new RegExp(`^(.*?)\\s+(${ROLE.source})\\s*$`, "i"));
  if (m) {
    return {
      name: m[1]!.trim(),
      designation: m[2]!.trim(),
      as_of,
    };
  }
  return { name: cleaned, designation: "Director", as_of };
}

const ZAUBA_HOUSE =
  /(?:Directors|Personnel)\s+(?:&|and|&amp;)?\s*Key\s*Managerial\s*Personnel\s+of\s+([\s\S]+?)(?=\s+Current\s+Directors|\s+DIN\b|\s+\d{7,9}\b|$)/i;

const STOP_BANNER =
  /^(din|director name|designation|appointment date|appointment|status|#)$/i;

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip Zauba OCR junk from company banners (e.g. "NAPEROL INVESTMENTS A"). */
export function cleanCompanyLabel(raw: string): string {
  let name = collapseWs(raw);
  if (!name) return "";
  // Drop banner leftovers glued onto the name.
  name = name
    .replace(/\bCurrent\s+Directors?\b[\s\S]*$/i, " ")
    .replace(/\bDIN\b[\s\S]*$/i, " ")
    .replace(/\bDirector\s+Name\b[\s\S]*$/i, " ")
    .replace(/\bAppointment\s+Date\b[\s\S]*$/i, " ");
  name = collapseWs(name);
  // Trailing single OCR glyph / letter after a multi-word company.
  name = name.replace(/\s+[A-Z0-9]\s*$/i, "").trim();
  // Trailing punctuation / pipes from OCR.
  name = name.replace(/[\s|·•,;:]+$/g, "").trim();
  return collapseWs(name);
}

/** Prefer cleaner banners: no trailing OCR glyph, longer stable name. */
function companyLabelScore(name: string): number {
  const n = cleanCompanyLabel(name);
  if (n.length < 3) return -1;
  let s = n.length;
  if (/\b(limited|ltd|investments|industries|corporation|company)\b/i.test(n)) {
    s += 20;
  }
  if (/\s+[A-Z0-9]$/i.test(name.trim())) s -= 30; // raw still had junk
  if (/^[A-Z0-9 .,&'-]+$/.test(n) && n.split(/\s+/).length >= 2) s += 8;
  return s;
}

function titleCasePersonName(name: string): string {
  const t = collapseWs(name);
  if (!t) return t;
  // Keep ALL-CAPS OCR readable without destroying initials (R.K. / MD).
  if (t !== t.toUpperCase() || t.length < 5) return t;
  return t
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, p, c) => `${p}${c.toUpperCase()}`);
}

function extractAppointmentDate(raw: string): string | null {
  const m = raw.match(/\b((?:19|20)\d{2}-\d{2}-\d{2})\b/);
  return m?.[1] ?? null;
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
  const fromSymbol = blob.match(
    /\(\s*(?:NSE|BSE)\s+symbol\s*:\s*([A-Z][A-Z0-9.-]{0,19})\s*\)/i,
  );
  const symExplicit = (fromSymbol?.[1] || "").toUpperCase().replace(/\./g, "");
  if (
    symExplicit &&
    !/^(NSE|BSE|SME|DIN|CEO|CFO|KMP|LTD)$/.test(symExplicit)
  ) {
    return symExplicit;
  }
  const m = blob.match(/\(\s*(?:NSE|BSE)\s*:\s*([A-Z][A-Z0-9-]{0,19})\s*\)/i);
  const t = (m?.[1] || "").toUpperCase();
  if (t && !/^(NSE|BSE|SME|DIN|CEO|CFO|KMP|LTD)$/.test(t)) return t;
  const listed = blob.match(
    /\bLimited\s*\(\s*([A-Z][A-Z0-9-]{1,19})\s*\)/i,
  );
  const sym = (listed?.[1] || "").toUpperCase();
  // (NSE SME) / (BSE) are venues, not tickers.
  if (sym && !/^(NSE|BSE|SME|DIN|CEO|CFO|KMP|LTD)$/.test(sym)) return sym;
  return null;
}

/** `(NSE symbol: TICKER)` / `(BSE: TICKER)` / `(NSE SME)` after a company name. */
const VENUE_PAREN =
  /\(\s*(?:NSE|BSE)(?:\s+SME|\s*symbol\s*:\s*[A-Z0-9.-]+|\s*:\s*[A-Z0-9.-]+)?\s*\)/i;

/** Research / chat: "For COMPANY (NSE symbol: TICKER), the current directors' DINs are:" */
const FOR_DIRECTORS_HEAD =
  new RegExp(
    String.raw`\bFor\s+([A-Za-z0-9][A-Za-z0-9 .,'&()-]{2,90}?)(?:\s*${VENUE_PAREN.source})?\s*,?\s*the\s+current\s+directors['’]?\s*DINs?\s+are\b`,
    "i",
  );

const VENUE_AFTER_NAME = new RegExp(
  String.raw`([A-Za-z0-9 .,'&()-]{4,110}?)\s*${VENUE_PAREN.source}`,
  "i",
);

export function parseCompanyLabelsFromBoardText(text: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = cleanCompanyLabel(raw);
    if (name.length < 3 || name.length > 90) return;
    if (/^(din|director|current|for)$/i.test(name)) return;
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
    // Prefer the "Current Directors … of COMPANY" banner — usually cleaner OCR.
    for (const m of blob.matchAll(
      /Current\s+Directors(?:\s*&\s*Key\s*Managerial\s*Personnel)?\s+of\s+([A-Za-z0-9][A-Za-z0-9 .,'&()-]{2,90}?)(?=\s+DIN\b|\s+Director\s+Name\b|\s+\d{7,9}\b|<|$)/gi,
    )) {
      add(m[1]!);
    }
    for (const m of blob.matchAll(new RegExp(FOR_DIRECTORS_HEAD.source, "gi"))) {
      add(m[1]!);
    }
  }
  for (const b of labelsFromBannerLines(text)) add(b);
  return labels.sort((a, b) => companyLabelScore(b) - companyLabelScore(a));
}

export function parseCompanyFromDirectorTable(text: string): string | null {
  const raw = scrubBoardNoise(text || "").replace(/\s+/g, " ").trim();
  const forHead = raw.match(FOR_DIRECTORS_HEAD);
  if (forHead) {
    const name = cleanCompanyLabel(forHead[1]!);
    if (name.length >= 3) return name;
  }
  const around =
    raw.match(VENUE_AFTER_NAME) ||
    raw.match(/([A-Za-z0-9 .,'&()-]{8,110})\(\s*(?:NSE|BSE)\s*:/i);
  if (around) {
    const bit = around[1]!
      .replace(/^\s*(yes\.?\s*|for\s+)/i, "")
      .trim();
    const lim = bit.match(
      /([A-Z][A-Za-z0-9 .,'&()-]{4,90}?\b(?:Limited|Ltd\.?))\s*$/i,
    );
    if (lim) return lim[1]!.replace(/\s+/g, " ").trim();
    const cleaned = cleanCompanyLabel(bit);
    if (cleaned.length >= 3) return cleaned;
  }
  const blob = [plainBoardText(text), flattenOcrHtml(text || "")]
    .map((t) => scrubBoardNoise(t).replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" \n ");
  const titled = blob.match(ZAUBA_HOUSE);
  if (titled) {
    const name = cleanCompanyLabel(titled[1]!);
    if (name.length >= 3) return name;
  }
  if (parseListedTickerFromBoardText(text)) return null;
  const of = blob.match(
    /\bof\s+([A-Za-z0-9][A-Za-z0-9 &.'()/-]{2,80}?)(?=\s+Current\s+Directors|\s+DIN\b|\s+\d{7,9}\b|$)/i,
  );
  if (of) {
    const name = cleanCompanyLabel(of[1]!);
    if (name.length >= 3) return name;
  }
  const banner = labelsFromBannerLines(text)[0];
  return banner ? cleanCompanyLabel(banner) || null : null;
}

export function parseDirectorSeatsFromTable(text: string): BoardSeat[] {
  const seats: BoardSeat[] = [];
  const seen = new Set<string>();
  seatsFromHtmlTables(scrubBoardNoise(text || ""), seats, seen);
  if (!seats.length && /<tr/i.test(text || "")) {
    seatsFromHtmlTables(`<table>${scrubBoardNoise(text || "")}</table>`, seats, seen);
  }
  const normalized = scrubBoardNoise(flattenOcrHtml(text || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\|/g, "\t")
    .replace(/[–—]/g, "-");

  const lines = normalized.split(/\n+/).map((rawLine) =>
    rawLine
      .replace(/^\s*[•·●▪◦]\s*/, "")
      .replace(/[ \t]+/g, (m) => (m.includes("\t") ? "\t" : " "))
      .replace(/[ ]{2,}/g, "\t")
      .trim(),
  );

  for (let i = 0; i < lines.length; i++) {
    const row = lines[i]!;
    if (!row) continue;
    if (/^director\s+role\s+din$/i.test(row.replace(/\t+/g, " "))) continue;
    if (/^name\s+(?:role|designation|position)\s+din$/i.test(row.replace(/\t+/g, " "))) {
      continue;
    }
    // Zauba / Tesseract: DIN Name Designation [Appointment Date]
    const dinFirstDated = row.match(
      new RegExp(
        String.raw`^(\d{7,9})\s+([A-Za-z][A-Za-z .'-]{2,70}?)\s+(${ROLE.source})\s*((?:19|20)\d{2}-\d{2}-\d{2})?\s*$`,
        "i",
      ),
    );
    if (dinFirstDated && looksLikePersonName(dinFirstDated[2]!)) {
      addSeat(
        seats,
        seen,
        dinFirstDated[1]!,
        dinFirstDated[2]!,
        dinFirstDated[3]!,
        dinFirstDated[4] || null,
      );
      continue;
    }
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
    // Research / "Directors and DINs": Name | DIN | Designation
    const nameDinRole = row.match(
      new RegExp(
        String.raw`^(?:\d{1,3}[.)]\s*)?([A-Za-z][A-Za-z .'-]{2,70}?)\s+(\d{7,9})\s+(${ROLE.source})\s*$`,
        "i",
      ),
    );
    if (nameDinRole) {
      addSeat(seats, seen, nameDinRole[2]!, nameDinRole[1]!, nameDinRole[3]!);
      continue;
    }
    // Tab / multi-space: Name | Role | DIN  (research chat tables)
    const tabbed = row.split(/\t+/).map((c) => c.trim()).filter(Boolean);
    if (tabbed.length >= 2) {
      const dinAt = tabbed.findIndex((c) => digitsToDin(c).length === 8);
      if (dinAt > 0) {
        const before = tabbed.slice(0, dinAt);
        const after = tabbed.slice(dinAt + 1);
        const nameCell =
          before.find(
            (c) => looksLikePersonName(c) && !ROLE_HEAD.test(c) && !ROLE.test(c),
          ) || before[0] || "";
        const roleCell =
          before.find((c) => c !== nameCell && (ROLE.test(c) || ROLE_HEAD.test(c))) ||
          after.find((c) => ROLE.test(c) || ROLE_HEAD.test(c)) ||
          before.filter((c) => c !== nameCell).join(" ") ||
          after[0] ||
          "Director";
        if (looksLikePersonName(nameCell)) {
          addSeat(seats, seen, tabbed[dinAt]!, nameCell, roleCell);
          continue;
        }
      }
    }
    // Spaced Name Role DIN (role starts at ROLE_HEAD, DIN at end)
    const nameRoleDin = row.match(
      new RegExp(
        String.raw`^(?:\d{1,3}[.)]\s*)?([A-Za-z][A-Za-z .'-]{2,70}?)\s+((?:${ROLE_HEAD.source}).+?)\s+(\d{7,9})\s*$`,
        "i",
      ),
    );
    if (
      nameRoleDin &&
      looksLikePersonName(nameRoleDin[1]!) &&
      !/^\d{7,9}\s/.test(row)
    ) {
      addSeat(seats, seen, nameRoleDin[3]!, nameRoleDin[1]!, nameRoleDin[2]!);
      continue;
    }
    const trailing = row.match(/^(.*?)\s+(\d{8})\s*$/);
    if (trailing && !/^\d{7,9}\s/.test(row)) {
      const rest = trailing[1]!.replace(/^\d{1,3}\s+/, "");
      const { name, designation, as_of } = splitNameThenRole(rest);
      addSeat(
        seats,
        seen,
        trailing[2]!,
        name,
        followOnDesignation(lines, i, designation),
        as_of,
      );
      continue;
    }
    const m = row.match(/^(\d{7,9})\s+-?\s*(.+)$/);
    if (!m) continue;
    const after = m[2]!.trim();
    // DIN | Role | Name (OCR sometimes puts designation before the person)
    const roleThenName = after.match(
      new RegExp(
        String.raw`^(${ROLE.source})\s+([A-Za-z][A-Za-z .'-]{2,70})$`,
        "i",
      ),
    );
    if (roleThenName && looksLikePersonName(roleThenName[2]!)) {
      addSeat(seats, seen, m[1]!, roleThenName[2]!, roleThenName[1]!);
      continue;
    }
    const { name, designation, as_of } = splitNameAndRole(after);
    addSeat(
      seats,
      seen,
      m[1]!,
      name,
      followOnDesignation(lines, i, designation),
      as_of,
    );
  }

  // Zauba packed: DIN Name Role
  const packed = new RegExp(
    String.raw`\b(\d{8})\b\s+([A-Za-z][A-Za-z .'-]{2,70}?)\s+(${ROLE.source})\b`,
    "gi",
  );
  let hit: RegExpExecArray | null;
  while ((hit = packed.exec(normalized)) != null) {
    addSeat(seats, seen, hit[1]!, hit[2]!, hit[3]!);
  }

  // Research packed: Name DIN Role (when OCR collapses the table to one blob)
  const nameFirst = new RegExp(
    String.raw`\b([A-Za-z][A-Za-z .'-]{2,70}?)\s+(\d{8})\s+(${ROLE.source})\b`,
    "gi",
  );
  while ((hit = nameFirst.exec(normalized)) != null) {
    addSeat(seats, seen, hit[2]!, hit[1]!, hit[3]!);
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

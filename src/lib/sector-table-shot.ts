/**
 * Fast screenshot import for stock tables with a per-row Industry column
 * (Name | Market Capitalization | Industry | Close Price).
 *
 * Reads the table by *layout*: Tesseract word boxes → header columns → rows
 * by y → cells by x. No vision model, so a full screenshot takes ~1s.
 * Number columns only anchor rows; listings are matched by name.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { resolveListingQuery } from "./sector-rotation-resolve";
import {
  listRotationSectors,
  mergeRotationSectorByLabel,
  type RotationSector,
} from "./sector-rotation";
import { tidyIndustry } from "./sector-screenshot-parse";
import { runConcurrent } from "./scrape-pool";

const execFileAsync = promisify(execFile);

export type TableShotRow = {
  name: string;
  industry: string;
};

type Word = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  cx: number;
  cy: number;
};

const NUM_RE = /^-?[\d,]+(?:\.\d+)?$/;
/** "₹45,210" often OCRs as "%45,210" / "€45,210" — drop the glyph first. */
const isNumberCell = (text: string) =>
  NUM_RE.test(text.replace(/^[^\d-]{1,2}(?=\d)/, ""));
const UNIT_RE = /^(?:₹|cr|crs?\.?|rs\.?)$/i;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Image → Tesseract word boxes (upscaled when small; sparse-text mode). */
async function ocrWords(imageDataUrl: string): Promise<Word[]> {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(imageDataUrl);
  if (!m) throw new Error("screenshot image required");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "table-shot-"));
  const input = path.join(dir, "img.png");
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(Buffer.from(m[1]!, "base64"));
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    // Small screenshots OCR far better upscaled.
    const scale = w > 0 && w < 1800 ? Math.min(3, 2400 / w) : 1;
    await img
      .resize(scale > 1 ? { width: Math.round(w * scale) } : undefined)
      .grayscale()
      .png()
      .toFile(input);
    const { stdout } = await execFileAsync(
      "tesseract",
      [input, "stdout", "-l", "eng", "--psm", "11", "tsv"],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const words: Word[] = [];
    for (const line of String(stdout).split("\n").slice(1)) {
      const c = line.split("\t");
      if (c.length < 12 || c[0] !== "5") continue;
      const text = (c[11] || "").trim();
      const conf = Number(c[10]);
      if (!text || !(conf >= 0)) continue;
      const left = Number(c[6]);
      const top = Number(c[7]);
      const width = Number(c[8]);
      const height = Number(c[9]);
      words.push({
        text,
        left,
        top,
        width,
        height,
        conf,
        cx: left + width / 2,
        cy: top + height / 2,
      });
    }
    return words;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Word boxes → table rows. Null when the Name + Industry header layout
 * isn't there (caller falls back to the vision import).
 */
export function rowsFromWords(words: Word[]): TableShotRow[] | null {
  const find = (re: RegExp) => words.filter((w) => re.test(w.text));
  const industryHdr = find(/^industry$/i).sort((a, b) => a.top - b.top)[0];
  if (!industryHdr) return null;
  const band = industryHdr.height * 2.5;
  const inHeader = (w: Word) => Math.abs(w.cy - industryHdr.cy) <= band;
  const nameHdr = find(/^(?:name|company|stock)$/i).filter(inHeader)[0];
  if (!nameHdr) return null;
  const mcapHdr = words.filter(
    (w) => inHeader(w) && /^(?:market|capitalization|capitalisation|m\.?cap|mcap)$/i.test(w.text),
  );
  const priceHdr = words.filter(
    (w) => inHeader(w) && /^(?:close|price|ltp|cmp)$/i.test(w.text),
  );
  const headerBottom = Math.max(
    ...[industryHdr, nameHdr, ...mcapHdr, ...priceHdr].map((w) => w.top + w.height),
  );
  const mcapX = mcapHdr.length ? median(mcapHdr.map((w) => w.cx)) : null;
  const priceX = priceHdr.length ? median(priceHdr.map((w) => w.cx)) : null;
  const priceLeft = priceHdr.length ? Math.min(...priceHdr.map((w) => w.left)) : Infinity;
  const h = industryHdr.height;
  const industryLeft = industryHdr.left - h * 1.5;
  const nameLeft = nameHdr.left - h * 1.5;
  const nameRight = Math.min(
    industryLeft,
    mcapHdr.length ? Math.min(...mcapHdr.map((w) => w.left)) - h * 2 : Infinity,
  );

  const body = words.filter((w) => w.top > headerBottom + 2);
  const textH = median(body.filter((w) => /[A-Za-z]{2,}/.test(w.text)).map((w) => w.height)) || h;

  type Cell = "name" | "industry" | "mcap" | "price";
  const cells: Array<{ w: Word; col: Cell }> = [];
  for (const w of body) {
    if (UNIT_RE.test(w.text)) continue;
    // Numbers inside the Name column are part of names ("20 Microns Ltd").
    if (isNumberCell(w.text)) {
      if (w.left + w.width <= nameHdr.left) continue; // rank column (left of Name)
      if (w.cx < nameRight) {
        cells.push({ w, col: "name" });
        continue;
      }
      if (mcapX != null && priceX != null) {
        cells.push({ w, col: Math.abs(w.cx - mcapX) <= Math.abs(w.cx - priceX) ? "mcap" : "price" });
      } else if (mcapX != null) cells.push({ w, col: "mcap" });
      else if (priceX != null) cells.push({ w, col: "price" });
      continue;
    }
    // Logos OCR as big single glyphs — keep text-height words only.
    if (w.height > textH * 1.6 || w.conf < 35) continue;
    if (w.cx >= industryLeft && w.left < priceLeft - h) cells.push({ w, col: "industry" });
    else if (w.cx >= nameLeft && w.cx < nameRight) cells.push({ w, col: "name" });
  }

  // Row anchors: one number per row (mcap, else price); else name lines.
  const anchorCol: Cell = cells.some((c) => c.col === "mcap")
    ? "mcap"
    : cells.some((c) => c.col === "price")
      ? "price"
      : "name";
  let anchors = cells.filter((c) => c.col === anchorCol).map((c) => c.w.cy).sort((a, b) => a - b);
  if (anchorCol === "name") {
    const merged: number[] = [];
    for (const y of anchors) {
      if (!merged.length || y - merged[merged.length - 1]! > textH * 0.8) merged.push(y);
    }
    anchors = merged;
  }
  if (anchors.length < 1) return null;
  const pitch =
    anchors.length > 1 ? median(anchors.slice(1).map((y, i) => y - anchors[i]!)) : textH * 4;

  const rows = anchors.map(() => ({
    name: [] as Word[],
    industry: [] as Word[],
    mcap: [] as Word[],
    price: [] as Word[],
  }));
  for (const c of cells) {
    let best = -1;
    let bestD = Infinity;
    anchors.forEach((y, i) => {
      const d = Math.abs(c.w.cy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && bestD <= pitch * 0.5) rows[best]![c.col].push(c.w);
  }
  const join = (ws: Word[]) =>
    ws
      .sort((a, b) => (Math.abs(a.cy - b.cy) > textH * 0.7 ? a.cy - b.cy : a.left - b.left))
      .map((w) => w.text)
      .join(" ")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/\s+/g, " ")
      .trim();
  const out: TableShotRow[] = [];
  for (const r of rows) {
    const name = join(r.name);
    if (!/[A-Za-z]{2,}/.test(name)) continue;
    out.push({ name, industry: join(r.industry) });
  }
  return out.length ? out : null;
}

export async function readTableScreenshot(
  imageDataUrl: string,
): Promise<TableShotRow[] | null> {
  return rowsFromWords(await ocrWords(imageDataUrl));
}

/** Small edit distance for snapping OCR'd industry labels to saved sectors. */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** "Private Bamks" → existing "Private Banks" (never across real labels). */
export function snapIndustryLabel(raw: string, existing: string[]): string {
  const label = tidyIndustry(raw) || raw.trim();
  const low = label.toLowerCase();
  const exact = existing.find((e) => e.toLowerCase() === low);
  if (exact) return exact;
  if (label.length < 7) return label;
  let best = "";
  let bestD = Infinity;
  for (const e of existing) {
    const d = editDistance(low, e.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return bestD <= Math.max(1, Math.floor(label.length / 10)) ? best : label;
}

export type TableShotEvent =
  | { t: "ocr" }
  | { t: "parsed"; industry: string; names: string[] }
  | { t: "hit"; query: string; ticker: string; name: string }
  | { t: "dup"; query: string; ticker: string }
  | { t: "miss"; query: string }
  | { t: "save"; label: string; n: number }
  | {
      t: "count";
      extracted: number;
      resolved: number;
      unresolved: number;
      before: number;
      after: number;
    };

export type TableShotImport = {
  industry: string;
  names: string[];
  unresolved: string[];
  sector: RotationSector;
  sectors: RotationSector[];
  /** Listings matched from this screenshot (not the baskets' older members). */
  matched: Array<{ ticker: string; name: string; market: string }>;
};

/**
 * Layout import: null when the screenshot isn't a Name + Industry table
 * (caller falls back to the vision path).
 */
export async function importTableScreenshot(
  imageDataUrl: string,
  onEvent?: (ev: TableShotEvent) => void,
): Promise<TableShotImport | null> {
  onEvent?.({ t: "ocr" });
  let rows: TableShotRow[] | null = null;
  try {
    rows = await readTableScreenshot(imageDataUrl);
  } catch {
    return null; // tesseract / sharp unavailable → vision fallback
  }
  if (!rows || rows.length < 2) return null;
  // Rows missing an Industry cell take the table's common label (if any).
  const counts = new Map<string, number>();
  for (const r of rows) if (r.industry) counts.set(r.industry, (counts.get(r.industry) ?? 0) + 1);
  const labeled = rows.filter((r) => r.industry).length;
  if (labeled * 2 < rows.length) return null;
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  for (const r of rows) if (!r.industry && counts.size === 1) r.industry = mode;

  const existing = listRotationSectors().map((s) => s.label);
  for (const r of rows) if (r.industry) r.industry = snapIndustryLabel(r.industry, existing);
  const distinct = new Set(rows.map((r) => r.industry.toLowerCase()).filter(Boolean));
  onEvent?.({
    t: "parsed",
    industry:
      distinct.size > 1 ? `${distinct.size} industries · ${rows.length} rows` : rows[0]!.industry,
    names: rows.map((r) => r.name),
  });

  const hits = await runConcurrent(rows, 6, (r) => resolveListingQuery(r.name));
  const unresolved: string[] = [];
  const have = new Set<string>();
  const byIndustry = new Map<
    string,
    { label: string; members: Array<{ ticker: string; name: string; market: string }> }
  >();
  rows.forEach((row, i) => {
    const hit = hits[i];
    if (!hit) {
      unresolved.push(row.name);
      onEvent?.({ t: "miss", query: row.name });
      return;
    }
    if (!row.industry) {
      unresolved.push(`${row.name} (no industry)`);
      onEvent?.({ t: "miss", query: `${row.name} — no industry cell` });
      return;
    }
    const ticker = hit.ticker.toUpperCase();
    if (have.has(ticker)) {
      onEvent?.({ t: "dup", query: row.name, ticker });
      return;
    }
    have.add(ticker);
    onEvent?.({ t: "hit", query: row.name, ticker, name: hit.name });
    const k = row.industry.toLowerCase();
    const bag = byIndustry.get(k) ?? { label: row.industry, members: [] };
    bag.members.push({ ticker, name: hit.name, market: hit.market });
    byIndustry.set(k, bag);
  });
  if (!byIndustry.size) {
    throw new Error(
      `None of the names resolved: ${unresolved.slice(0, 6).join(", ")}`,
    );
  }
  const sectors: RotationSector[] = [];
  for (const bag of byIndustry.values()) {
    const before =
      listRotationSectors().find((s) => s.label.toLowerCase() === bag.label.toLowerCase())
        ?.members.length ?? 0;
    const sector = mergeRotationSectorByLabel(bag.label, bag.members);
    sectors.push(sector);
    onEvent?.({
      t: "count",
      extracted: bag.members.length,
      resolved: bag.members.length,
      unresolved: 0,
      before,
      after: sector.members.length,
    });
    onEvent?.({ t: "save", label: sector.label, n: sector.members.length });
  }
  sectors.sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
  return {
    industry: sectors.length > 1 ? `${sectors.length} industries` : sectors[0]!.label,
    names: rows.map((r) => r.name),
    unresolved,
    sector: sectors[0]!,
    sectors,
    matched: [...byIndustry.values()].flatMap((b) => b.members),
  };
}

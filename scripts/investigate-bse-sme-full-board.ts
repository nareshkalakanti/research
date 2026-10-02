/**
 * Read-only BSE SME full-board AR experiment (15–20 issuers).
 * No writes to governance.db / board_seats / directors.
 *   npx tsx scripts/investigate-bse-sme-full-board.ts
 */
import Database from "better-sqlite3";
import path from "path";
import { BSE_HEADERS } from "../src/lib/bse-sme";
import { isPlaceholderDin, normDin } from "../src/lib/nse-governance";
import { formatBseApiDateFromInstant } from "../src/lib/nse-time";

const DATA = path.join(process.cwd(), "data");
const ANN =
  "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const AR = "https://api.bseindia.com/BseIndiaAPI/api/AnnualReport/w";

const WORD_NUM: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

type SampleCo = {
  ticker: string;
  name: string;
  market_cap: number;
  scrip_code: string;
  tercile: number;
};

type AnnRow = {
  NEWSSUB?: string;
  HEADLINE?: string;
  NEWS_DT?: string;
  ATTACHMENTNAME?: string;
  CATEGORYNAME?: string;
  SUBCATNAME?: string;
};

type Seat = { name: string; din: string | null; how: string };

function pickSample(): SampleCo[] {
  const gov = new Database(path.join(DATA, "governance.db"), { readonly: true });
  try {
    gov.exec(
      `ATTACH DATABASE '${path.join(DATA, "company_about.db")}' AS about`,
    );
    return gov
      .prepare(
        `
        WITH base AS (
          SELECT c.ticker, c.name, m.market_cap, b.scrip_code,
            NTILE(3) OVER (ORDER BY m.market_cap DESC) AS tercile
          FROM companies c
          JOIN company_metrics m
            ON m.ticker = c.ticker AND m.market_cap > 0
          JOIN about.company_bse_scrip b
            ON UPPER(b.ticker) = UPPER(c.ticker)
           AND TRIM(b.scrip_code) != ''
          WHERE c.market = 'BSE SME'
        ),
        numbered AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY tercile ORDER BY market_cap DESC, ticker
            ) AS rn,
            COUNT(*) OVER (PARTITION BY tercile) AS n
          FROM base
        )
        SELECT ticker, name, market_cap, scrip_code, tercile
        FROM numbered
        WHERE rn IN (
          1,
          MAX(1, n / 5),
          MAX(1, (2 * n) / 5),
          MAX(1, (3 * n) / 5),
          MAX(1, (4 * n) / 5),
          n
        )
        ORDER BY tercile, market_cap DESC
        `,
      )
      .all() as SampleCo[];
  } finally {
    gov.close();
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: BSE_HEADERS,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAnns(scrip: string): Promise<AnnRow[]> {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 11);
  const params = new URLSearchParams({
    pageno: "1",
    strCat: "-1",
    strPrevDate: formatBseApiDateFromInstant(from),
    strScrip: scrip,
    strSearch: "P",
    strToDate: formatBseApiDateFromInstant(to),
    strType: "C",
    subcategory: "",
  });
  const json = (await getJson(`${ANN}?${params}`)) as { Table?: AnnRow[] };
  return json.Table ?? [];
}

async function fetchAnnualReports(scrip: string): Promise<
  Array<{ year: string; file_name: string; dt_tm: string }>
> {
  const json = (await getJson(`${AR}?scripcode=${encodeURIComponent(scrip)}`)) as {
    Table?: Array<{ year?: string; file_name?: string; dt_tm?: string }>;
  };
  return (json.Table ?? [])
    .map((r) => ({
      year: String(r.year || ""),
      file_name: String(r.file_name || "").trim(),
      dt_tm: String(r.dt_tm || ""),
    }))
    .filter((r) => r.file_name);
}

function bsePdfUrls(fileName: string): string[] {
  const name = fileName.replace(/\.pdf\.pdf$/i, ".pdf");
  return [
    `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${name}`,
    `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${name}`,
    `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${encodeURIComponent(name)}`,
  ];
}

async function downloadPdf(fileName: string): Promise<{
  url: string;
  buf: Buffer;
} | null> {
  for (const url of bsePdfUrls(fileName)) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": BSE_HEADERS["User-Agent"],
          Referer: "https://www.bseindia.com/",
          Accept: "application/pdf,*/*",
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 800 && buf.subarray(0, 5).toString("utf8") === "%PDF-") {
        return { url, buf };
      }
    } catch {
      /* next */
    }
  }
  return null;
}

async function pdfText(buf: Buffer): Promise<string> {
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : String(chunk);
    if (/private use area|undefined function:|invalid function|fontRes not available/i.test(s)) {
      return true;
    }
    return errWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stderr.write;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
      b: Buffer,
    ) => Promise<{ text?: string }>;
    const parsed = await pdfParse(buf);
    return (parsed.text || "").replace(/[ \t]+/g, " ").trim();
  } finally {
    process.stderr.write = errWrite;
  }
}

function expectedBoardSize(text: string): number | null {
  const re =
    /board(?:\s+of\s+directors)?\s+(?:of(?:\s+the)?\s+company\s+)?(?:is |are |was |were )?(?:comprises?|consists?|composed|constituted|made up)\s+(?:of\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+directors?/i;
  const m = re.exec(text);
  if (!m) {
    const m2 =
      /(?:there are|the company has)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:directors|members on the board)/i.exec(
        text,
      );
    if (!m2) return null;
    const w = m2[1]!.toLowerCase();
    return WORD_NUM[w] ?? Number(m2[1]);
  }
  const w = m[1]!.toLowerCase();
  return WORD_NUM[w] ?? Number(m[1]);
}

function boardSection(text: string): { slice: string; how: string } {
  const startRe =
    /(?:^|\n)\s*(?:\d{1,2}\.\s*)?(?:the\s+)?(?:board of directors|composition of(?:\s+the)?\s+board|details of(?:\s+the)?\s+directors|current directors|directors and key managerial personnel)\b/i;
  const start = startRe.exec(text);
  if (start && start.index != null) {
    const from = start.index;
    const rest = text.slice(from);
    const stopRe =
      /\n\s*(?:committees of the board|board committees|audit committee|nomination and remuneration|stakeholders['’]? relationship|management discussion|independent auditor|auditor['’]?s report|corporate governance report|director['’]?s report|annexure\s*[-–]?\s*[A-Z])/i;
    const stop = stopRe.exec(rest.slice(80));
    const end = stop && stop.index != null ? 80 + stop.index : Math.min(rest.length, 12_000);
    return { slice: rest.slice(0, end), how: "heading" };
  }
  const firstDin = /(?:\(\s*DIN\s*[:.]?\s*\d{8}\s*\)|(?<!U)DIN\s*[:.]?\s*\d{8})/i.exec(
    text,
  );
  if (firstDin && firstDin.index != null) {
    const from = Math.max(0, firstDin.index - 400);
    return { slice: text.slice(from, from + 8_000), how: "din_cluster" };
  }
  return { slice: "", how: "none" };
}

function extractSeats(slice: string): { seats: Seat[]; dupDins: string[]; falseDins: string[] } {
  const seats: Seat[] = [];
  const seen = new Set<string>();
  const dupDins: string[] = [];
  const falseDins: string[] = [];
  const paren =
    /(?:(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Shri|Smt)\.?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.]+){0,5})\s*\(\s*DIN\s*[:.]?\s*(\d{7,8})\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = paren.exec(slice)) !== null) {
    const din = normDin(m[2]);
    const name = m[1]!.replace(/\s+/g, " ").trim();
    if (din.length !== 8 || isPlaceholderDin(din)) {
      falseDins.push(din || m[2]!);
      continue;
    }
    const around = slice.slice(Math.max(0, m.index - 6), m.index + 24);
    if (/UDIN/i.test(around)) {
      falseDins.push(din);
      continue;
    }
    if (seen.has(din)) {
      dupDins.push(din);
      continue;
    }
    seen.add(din);
    seats.push({ name, din, how: "paren" });
  }
  const line = /(?<!U)DIN\s*(?:No\.?|Number|#)?\s*[:.\-]?\s*(\d{7,8})\b/gi;
  while ((m = line.exec(slice)) !== null) {
    const din = normDin(m[1]);
    if (din.length !== 8 || isPlaceholderDin(din)) {
      falseDins.push(din || m[1]!);
      continue;
    }
    if (/UDIN/i.test(slice.slice(Math.max(0, m.index - 4), m.index + 16))) {
      falseDins.push(din);
      continue;
    }
    if (seen.has(din)) {
      dupDins.push(din);
      continue;
    }
    const before = slice.slice(Math.max(0, m.index - 140), m.index);
    const nameHit = before.match(
      /(?:(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Shri|Smt)\.?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.]+){1,5})\s*$/,
    );
    seen.add(din);
    seats.push({
      name: nameHit?.[1]?.replace(/\s+/g, " ").trim() || "(name not adjacent)",
      din,
      how: "din_line",
    });
  }
  return { seats, dupDins: [...new Set(dupDins)], falseDins: [...new Set(falseDins)] };
}

function isDirectorAnn(row: AnnRow): boolean {
  const blob = `${row.NEWSSUB || ""} ${row.HEADLINE || ""} ${row.CATEGORYNAME || ""} ${row.SUBCATNAME || ""}`;
  return /change in management|appointment of (?:an?\s+)?(?:additional\s+)?(?:independent\s+)?director|resignation of|cessation|change in directors|\bkmp\b|key managerial/i.test(
    blob,
  );
}

async function main() {
  const sample = pickSample();
  console.log(`Full-board experiment: ${sample.length} BSE SME issuers (no DB writes)\n`);

  const rows: Array<Record<string, unknown>> = [];
  for (const co of sample) {
    const rec: Record<string, unknown> = {
      ticker: co.ticker,
      name: co.name,
      mcap: Math.round(co.market_cap),
      tercile: co.tercile,
    };
    try {
      const [anns, ars] = await Promise.all([
        fetchAnns(co.scrip_code),
        fetchAnnualReports(co.scrip_code),
      ]);
      const latest = ars[0] || null;
      rec.ar_found = Boolean(latest);
      rec.ar_year = latest?.year || null;
      rec.ar_date = latest?.dt_tm?.slice(0, 10) || null;
      if (!latest) {
        rec.format = "no_ar";
        rec.failure = "no annual report on BSE API";
        rows.push(rec);
        console.log(`${co.ticker} NO AR`);
        continue;
      }
      const pdf = await downloadPdf(latest.file_name);
      if (!pdf) {
        rec.format = "download_fail";
        rec.failure = "AR listed but PDF not downloadable";
        rows.push(rec);
        console.log(`${co.ticker} PDF FAIL`);
        continue;
      }
      rec.pdf_kb = Math.round(pdf.buf.length / 1024);
      const text = await pdfText(pdf.buf);
      rec.text_chars = text.length;
      rec.format =
        text.length < 400 && pdf.buf.length > 80_000
          ? "scanned_or_image"
          : text.length < 2000
            ? "sparse_text"
            : "text_pdf";
      if (text.length < 80) {
        rec.failure = "pdf-parse produced almost no text (likely scanned)";
        rec.section_how = "none";
        rows.push(rec);
        console.log(`${co.ticker} SCANNED/EMPTY`);
        continue;
      }
      const expected = expectedBoardSize(text);
      rec.expected_board = expected;
      const { slice, how } = boardSection(text);
      rec.section_how = how;
      rec.section_chars = slice.length;
      const { seats, dupDins, falseDins } = extractSeats(slice);
      rec.extracted = seats.length;
      rec.with_din = seats.filter((s) => s.din).length;
      rec.din_pct =
        seats.length > 0
          ? Math.round((100 * seats.filter((s) => s.din).length) / seats.length)
          : 0;
      rec.completeness =
        expected && expected > 0
          ? Math.round((100 * seats.length) / expected)
          : null;
      rec.dup_dins = dupDins;
      rec.false_dins = falseDins;
      rec.sample_names = seats.slice(0, 8).map((s) => `${s.name} ${s.din}`);
      const arMs = latest.dt_tm ? Date.parse(latest.dt_tm) : NaN;
      const post = anns.filter((a) => {
        if (!isDirectorAnn(a) || !a.NEWS_DT) return false;
        const t = Date.parse(a.NEWS_DT);
        return Number.isFinite(arMs) && Number.isFinite(t) && t > arMs;
      });
      rec.post_ar_director_filings = post.length;
      rec.post_ar_titles = post.slice(0, 3).map((p) => p.NEWSSUB);
      rec.failure = "";
      const completeEnough =
        expected != null
          ? seats.length >= Math.ceil(0.8 * expected) &&
            seats.filter((s) => s.din).length >= Math.ceil(0.8 * expected)
          : seats.length >= 5 && rec.din_pct === 100;
      rec.go_bit = completeEnough;
    } catch (e) {
      rec.failure = e instanceof Error ? e.message : String(e);
      rec.format = "error";
    }
    rows.push(rec);
    console.log(
      `${String(co.ticker).padEnd(12)} T${co.tercile} ${String(rec.format).padEnd(16)} exp=${rec.expected_board ?? "-"} got=${rec.extracted ?? "-"} din%=${rec.din_pct ?? "-"} ${rec.section_how || ""} ${rec.failure || ""}`,
    );
  }

  const n = rows.length;
  const withAr = rows.filter((r) => r.ar_found).length;
  const scanned = rows.filter((r) => r.format === "scanned_or_image").length;
  const withSection = rows.filter(
    (r) => r.section_how === "heading" || r.section_how === "din_cluster",
  ).length;
  const knownExp = rows.filter((r) => r.expected_board != null);
  const complete = rows.filter((r) => r.go_bit === true);
  const anyDin = rows.filter((r) => Number(r.with_din || 0) >= 1).length;
  const postAr = rows.filter((r) => Number(r.post_ar_director_filings || 0) > 0).length;
  const dups = rows.filter((r) => Array.isArray(r.dup_dins) && r.dup_dins.length).length;
  const falses = rows.filter((r) => Array.isArray(r.false_dins) && r.false_dins.length).length;

  console.log("\n=== ROWS ===");
  console.log(JSON.stringify(rows, null, 2));
  console.log("\n=== AGG ===");
  console.log({
    sampled: n,
    with_ar: withAr,
    scanned_or_image: scanned,
    board_section_located: withSection,
    expected_size_stated: knownExp.length,
    any_din: anyDin,
    go_complete: complete.length,
    post_ar_appointments: postAr,
    duplicate_din_issuers: dups,
    false_din_issuers: falses,
    mean_extracted:
      rows.reduce((s, r) => s + Number(r.extracted || 0), 0) / Math.max(1, n),
    mean_completeness_when_known:
      knownExp.length > 0
        ? Math.round(
            knownExp.reduce((s, r) => s + Number(r.completeness || 0), 0) /
              knownExp.length,
          )
        : null,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

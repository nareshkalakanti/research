/**
 * Read-only BSE SME board/DIN sample. Does not write governance.db.
 *   npx tsx scripts/investigate-bse-sme-board-sample.ts
 */
import Database from "better-sqlite3";
import path from "path";
import { BSE_HEADERS } from "../src/lib/bse-sme";
import { extractCorporateFromPdfUrl } from "../src/lib/corporate-data-extract";
import { isPlaceholderDin, normDin } from "../src/lib/nse-governance";
import { formatBseApiDateFromInstant } from "../src/lib/nse-time";

const DATA = path.join(process.cwd(), "data");
const ANN =
  "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const AR = "https://api.bseindia.com/BseIndiaAPI/api/AnnualReport/w";

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

function pickSample(): SampleCo[] {
  const gov = new Database(path.join(DATA, "governance.db"), { readonly: true });
  try {
    gov.exec(`ATTACH DATABASE '${path.join(DATA, "company_about.db")}' AS about`);
    const rows = gov
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
        WHERE rn = 1 OR rn = MAX(1, n / 2)
        ORDER BY tercile, market_cap DESC
        `,
      )
      .all() as SampleCo[];
    return rows;
  } finally {
    gov.close();
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: BSE_HEADERS,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as unknown;
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
  const encoded = encodeURIComponent(name);
  return [
    `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${name}`,
    `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${name}`,
    `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${encoded}`,
  ];
}

function isDirectorAnn(row: AnnRow): boolean {
  const blob = `${row.NEWSSUB || ""} ${row.HEADLINE || ""} ${row.CATEGORYNAME || ""} ${row.SUBCATNAME || ""}`;
  return /change in management|appointment of (?:an?\s+)?(?:additional\s+)?(?:independent\s+)?director|resignation of|cessation|change in directors|\bkmp\b|key managerial|corporate governance report/i.test(
    blob,
  );
}

function pdfLooksAlive(buf: Buffer): boolean {
  return buf.length > 500 && buf.subarray(0, 5).toString("utf8") === "%PDF-";
}

async function firstWorkingPdf(fileName: string): Promise<string | null> {
  for (const url of bsePdfUrls(fileName)) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": BSE_HEADERS["User-Agent"],
          Referer: "https://www.bseindia.com/",
          Accept: "application/pdf,*/*",
        },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (pdfLooksAlive(buf)) return url;
    } catch {
      /* try next */
    }
  }
  return null;
}

function dinStats(directors: Array<{ din: string | null; name: string }>) {
  const valid = directors.filter((d) => {
    const din = normDin(d.din);
    return din.length === 8 && !isPlaceholderDin(din);
  });
  return {
    directors: directors.length,
    dins: valid.length,
    names_only: directors.filter((d) => !normDin(d.din) || normDin(d.din).length !== 8)
      .length,
  };
}

async function main() {
  const sample = pickSample();
  console.log(
    `Sample ${sample.length} BSE SME (scrip-mapped, mcap terciles, no DB writes)\n`,
  );

  const rows: Array<Record<string, unknown>> = [];

  for (const co of sample) {
    const rec: Record<string, unknown> = {
      ticker: co.ticker,
      name: co.name,
      mcap: co.market_cap,
      tercile: co.tercile,
      scrip: co.scrip_code,
      annual_report_found: false,
      board_section_found: false,
      directors_extracted: 0,
      dins_found: 0,
      current_or_pit: "n/a",
      quality: "",
      doc_used: "",
      failure: "",
    };
    try {
      const [anns, ars] = await Promise.all([
        fetchAnns(co.scrip_code),
        fetchAnnualReports(co.scrip_code),
      ]);
      rec.ann_count = anns.length;
      rec.ar_years = ars.map((r) => r.year);
      const latestAr = ars[0] || null;
      const dirAnns = anns.filter(
        (r) => r.ATTACHMENTNAME && isDirectorAnn(r),
      );
      rec.director_ann_count = dirAnns.length;

      const candidates: Array<{
        kind: "annual_report" | "appointment";
        file: string;
        label: string;
      }> = [];
      if (latestAr) {
        candidates.push({
          kind: "annual_report",
          file: latestAr.file_name,
          label: `AR ${latestAr.year}`,
        });
      }
      if (dirAnns[0]?.ATTACHMENTNAME) {
        candidates.push({
          kind: "appointment",
          file: dirAnns[0].ATTACHMENTNAME,
          label: String(dirAnns[0].NEWSSUB || "director filing").slice(0, 80),
        });
      }

      rec.annual_report_found = Boolean(latestAr);

      let bestDins = 0;
      let bestDirs = 0;
      let used = "";
      let quality = "no_doc";
      let pit = "n/a";
      let fail = candidates.length ? "" : "no annual report and no director filing PDF";

      for (const cand of candidates) {
        const url = await firstWorkingPdf(cand.file);
        if (!url) {
          fail = fail || `could not download ${cand.kind} PDF`;
          continue;
        }
        const extracted = await extractCorporateFromPdfUrl(url, {
          skipOcr: true,
        });
        const dirs = extracted.extracted.directors || [];
        const stats = dinStats(dirs);
        const boardish =
          stats.directors > 0 ||
          /board of directors|composition of (?:the )?board/i.test(
            extracted.extracted.notes || "",
          );
        if (boardish) rec.board_section_found = true;
        if (stats.dins > bestDins || (stats.dins === bestDins && stats.directors > bestDirs)) {
          bestDins = stats.dins;
          bestDirs = stats.directors;
          used = `${cand.label} | ${extracted.status} | ${extracted.engine}`;
          pit = cand.kind === "annual_report" ? "point-in-time (annual report)" : "event filing (not full board)";
          if (!extracted.ok) {
            quality = extracted.status || "extract_failed";
            fail = extracted.error || extracted.status;
          } else if (stats.dins >= 3 && stats.dins >= Math.ceil(stats.directors * 0.7)) {
            quality = "most_directors_have_din";
            fail = "";
          } else if (stats.dins >= 1) {
            quality = "partial_din";
            fail = stats.names_only ? "some names without DIN" : "";
          } else if (stats.directors >= 1) {
            quality = "names_only";
            fail = "directors extracted without 8-digit DIN";
          } else {
            quality = "no_directors";
            fail = extracted.error || "extract ok but empty directors";
          }
        }
      }

      rec.directors_extracted = bestDirs;
      rec.dins_found = bestDins;
      rec.doc_used = used;
      rec.current_or_pit = pit;
      rec.quality = quality;
      rec.failure = fail;
    } catch (e) {
      rec.failure = e instanceof Error ? e.message : String(e);
      rec.quality = "fetch_failed";
    }
    rows.push(rec);
    console.log(
      `${co.ticker.padEnd(12)} mcap=${Math.round(co.market_cap)} AR=${rec.annual_report_found} dirs=${rec.directors_extracted} din=${rec.dins_found} ${rec.quality} ${rec.failure}`,
    );
  }

  const n = rows.length;
  const withAr = rows.filter((r) => r.annual_report_found).length;
  const withBoard = rows.filter((r) => r.board_section_found).length;
  const withDin = rows.filter((r) => Number(r.dins_found) >= 1).length;
  const mostDin = rows.filter((r) => r.quality === "most_directors_have_din").length;
  const namesOnly = rows.filter((r) => r.quality === "names_only").length;
  const failed = rows.filter(
    (r) =>
      r.quality === "fetch_failed" ||
      r.quality === "no_doc" ||
      r.quality === "extract_failed" ||
      r.quality === "no_directors" ||
      r.quality === "not_pdf" ||
      r.quality === "no_text" ||
      r.quality === "download_failed",
  ).length;

  console.log("\n=== ROWS ===");
  console.log(JSON.stringify(rows, null, 2));
  console.log("\n=== AGG ===", {
    sampled: n,
    with_annual_report: withAr,
    with_board_section: withBoard,
    with_any_din: withDin,
    most_directors_have_din: mostDin,
    names_only: namesOnly,
    failed,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

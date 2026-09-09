/**
 * Rasterize PDF pages to PNG data URLs (Poppler pdftoppm).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function findPdftoppm(): Promise<string | null> {
  const candidates = [
    process.env.PDFTOPPM_PATH?.trim(),
    "/opt/homebrew/bin/pdftoppm",
    "/usr/local/bin/pdftoppm",
  ].filter(Boolean) as string[];
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ["-v"], { timeout: 5_000 });
      return bin;
    } catch {
      /* try next */
    }
  }
  try {
    const { stdout } = await execFileAsync("which", ["pdftoppm"], {
      timeout: 3_000,
    });
    const p = stdout.trim();
    if (!p) return null;
    await execFileAsync(p, ["-v"], { timeout: 5_000 });
    return p;
  } catch {
    return null;
  }
}

export type PdfPageImage = {
  page: number;
  dataUrl: string;
};

/**
 * Render first `maxPages` of a PDF to PNG data URLs via pdftoppm.
 */
export async function rasterizePdfPages(
  pdf: Buffer,
  opts?: { maxPages?: number; dpi?: number },
): Promise<PdfPageImage[]> {
  const maxPages = Math.min(8, Math.max(1, opts?.maxPages ?? 4));
  const dpi = Math.min(200, Math.max(72, opts?.dpi ?? 144));
  const bin = await findPdftoppm();
  if (!bin) {
    throw new Error(
      "pdftoppm not found (brew install poppler) — needed for Qianfan page OCR",
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corp-pdf-"));
  const pdfPath = path.join(dir, "in.pdf");
  const prefix = path.join(dir, "page");
  try {
    fs.writeFileSync(pdfPath, pdf);
    await execFileAsync(
      bin,
      [
        "-png",
        "-r",
        String(dpi),
        "-f",
        "1",
        "-l",
        String(maxPages),
        pdfPath,
        prefix,
      ],
      { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
    );

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    const out: PdfPageImage[] = [];
    for (const file of files) {
      const m = file.match(/page-?(\d+)\.png$/i);
      const page = m ? Number(m[1]) : out.length + 1;
      const buf = fs.readFileSync(path.join(dir, file));
      out.push({
        page,
        dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
      });
    }
    if (!out.length) {
      throw new Error("pdftoppm produced no page images");
    }
    return out;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

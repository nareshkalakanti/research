/**
 * Rasterize PDF pages to compact JPEG data URLs (Poppler pdftoppm).
 * Vision OCR models often default to a small num_ctx — keep pages lean.
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
 * Downscale a page image for vision OCR (macOS sips; otherwise leave as-is).
 * Cuts token count so requests fit default 4k–8k contexts.
 */
export async function shrinkImageDataUrlForOcr(
  dataUrl: string,
  maxEdge = 1280,
): Promise<string> {
  const m = /^data:(image\/(?:png|jpeg|jpg));base64,(.+)$/i.exec(dataUrl);
  if (!m) return dataUrl;
  const mime = m[1]!.toLowerCase().includes("png") ? "png" : "jpeg";
  const raw = Buffer.from(m[2]!, "base64");
  // Already small enough (~<350KB jpeg-ish) — skip
  if (raw.length < 280_000 && mime === "jpeg") return dataUrl;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-img-"));
  const input = path.join(dir, `in.${mime === "png" ? "png" : "jpg"}`);
  const output = path.join(dir, "out.jpg");
  try {
    fs.writeFileSync(input, raw);
    // Prefer sips (macOS); fall back to pdftoppm-sized jpeg already
    try {
      await execFileAsync(
        "sips",
        [
          "-Z",
          String(maxEdge),
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "70",
          input,
          "--out",
          output,
        ],
        { timeout: 20_000 },
      );
      const out = fs.readFileSync(output);
      if (out.length > 0) {
        return `data:image/jpeg;base64,${out.toString("base64")}`;
      }
    } catch {
      /* keep original */
    }
    return dataUrl;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Render first `maxPages` of a PDF to image data URLs via pdftoppm.
 * Default JPEG @ 110 DPI keeps vision-OCR prompts under small contexts.
 */
export async function rasterizePdfPages(
  pdf: Buffer,
  opts?: {
    maxPages?: number;
    dpi?: number;
    /** jpeg (default, smaller) or png */
    format?: "jpeg" | "png";
  },
): Promise<PdfPageImage[]> {
  const maxPages = Math.min(60, Math.max(1, opts?.maxPages ?? 4));
  const dpi = Math.min(200, Math.max(72, opts?.dpi ?? 110));
  const format = opts?.format === "png" ? "png" : "jpeg";
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
    const args =
      format === "png"
        ? [
            "-png",
            "-r",
            String(dpi),
            "-f",
            "1",
            "-l",
            String(maxPages),
            pdfPath,
            prefix,
          ]
        : [
            "-jpeg",
            "-jpegopt",
            "quality=72",
            "-r",
            String(dpi),
            "-f",
            "1",
            "-l",
            String(maxPages),
            pdfPath,
            prefix,
          ];
    await execFileAsync(bin, args, {
      timeout: Math.min(300_000, 15_000 + maxPages * 4_000),
      maxBuffer: 80 * 1024 * 1024,
    });

    const ext = format === "png" ? ".png" : ".jpg";
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("page") && f.toLowerCase().endsWith(ext))
      .sort();
    // Some poppler builds emit .jpeg
    const filesAlt =
      files.length > 0
        ? files
        : fs
            .readdirSync(dir)
            .filter(
              (f) =>
                f.startsWith("page") &&
                (f.endsWith(".jpg") ||
                  f.endsWith(".jpeg") ||
                  f.endsWith(".png")),
            )
            .sort();
    const out: PdfPageImage[] = [];
    for (const file of filesAlt) {
      const m = file.match(/page-?(\d+)\./i);
      const page = m ? Number(m[1]) : out.length + 1;
      const buf = fs.readFileSync(path.join(dir, file));
      const isPng = file.toLowerCase().endsWith(".png");
      let dataUrl = `data:image/${isPng ? "png" : "jpeg"};base64,${buf.toString("base64")}`;
      dataUrl = await shrinkImageDataUrlForOcr(dataUrl, 1280);
      out.push({ page, dataUrl });
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

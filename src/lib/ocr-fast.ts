/**
 * Fast local OCR (Tesseract) before vision models.
 * Screenshots / table images often finish in <1s; vision is the fallback.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type LocalOcrOpts = {
  /** Tesseract page segmentation. 6 = assume uniform block of text. */
  psm?: number;
  timeoutMs?: number;
};

/** True when local OCR looks like real page text (not empty / glyph noise). */
export function localOcrLooksUseful(text: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length < 48) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters < 28) return false;
  if (letters / Math.max(t.length, 1) < 0.28) return false;
  const words = t.split(/\s+/).filter((w) => /[A-Za-z]{3,}/.test(w));
  return words.length >= 6;
}

/**
 * Run system Tesseract on a data-URL image.
 * Returns null when tesseract is missing or yields nothing.
 */
export async function tesseractFromDataUrl(
  imageDataUrl: string,
  opts?: LocalOcrOpts,
): Promise<string | null> {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/i.exec(
    imageDataUrl,
  );
  if (!m) return null;
  const mime = m[1]!.toLowerCase();
  const ext = mime.includes("png")
    ? "png"
    : mime.includes("webp")
      ? "webp"
      : mime.includes("gif")
        ? "gif"
        : "jpg";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-fast-"));
  const input = path.join(dir, `img.${ext}`);
  try {
    fs.writeFileSync(input, Buffer.from(m[2]!, "base64"));
    const psm = String(Math.min(13, Math.max(3, opts?.psm ?? 6)));
    const { stdout } = await execFileAsync(
      "tesseract",
      [input, "stdout", "-l", "eng", "--psm", psm],
      {
        timeout: opts?.timeoutMs ?? 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const text = String(stdout || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text || null;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

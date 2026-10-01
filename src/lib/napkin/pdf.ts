/**
 * Download a filing PDF and extract text with page numbers. No Qwen.
 */

import { downloadBuybackPdf } from "@/lib/buyback-screen";
import type { NapkinPdfPage } from "./types";

export type { NapkinPdfPage };

export type NapkinPdfExtract = {
  title: string;
  url: string;
  pages: NapkinPdfPage[];
  full_text: string;
};

const store = new Map<string, { at: number; doc: NapkinPdfExtract }>();
const TTL_MS = 30 * 60 * 1000;

function allowedPdfUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return (
      h.endsWith("nseindia.com") ||
      h.endsWith("bseindia.com") ||
      h.endsWith(".amazonaws.com") ||
      h.endsWith(".cloudfront.net")
    );
  } catch {
    return false;
  }
}

function titleFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "filing.pdf");
  } catch {
    return "filing.pdf";
  }
}

function clean(s: string): string {
  return s.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function pagesFromPdf(buf: Buffer): Promise<NapkinPdfPage[]> {
  const pages: NapkinPdfPage[] = [];
  // pdf-parse main entry runs debug on import — lib path only.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
    opts?: {
      pagerender?: (pageData: {
        pageNumber?: number;
        getTextContent: () => Promise<{
          items: Array<{ str?: string; transform?: number[] }>;
        }>;
      }) => Promise<string>;
    },
  ) => Promise<{ text: string; numpages: number }>;

  await pdfParse(buf, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      let lastY: number | undefined;
      let text = "";
      for (const item of content.items) {
        const str = item.str || "";
        const y = item.transform?.[5];
        if (lastY == null || y === lastY) text += str;
        else text += `\n${str}`;
        lastY = y;
      }
      const n = pageData.pageNumber || pages.length + 1;
      pages.push({ page_number: n, text: clean(text) });
      return text;
    },
  });

  if (!pages.length) {
    const data = await pdfParse(buf);
    pages.push({
      page_number: 1,
      text: clean(data.text || ""),
    });
  }
  return pages;
}

export function getCachedExtract(url: string): NapkinPdfExtract | null {
  const hit = store.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    store.delete(url);
    return null;
  }
  return hit.doc;
}

export async function extractPdf(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<NapkinPdfExtract> {
  const u = url.trim();
  if (!allowedPdfUrl(u)) {
    throw new Error("That PDF host is not allowed");
  }
  const cached = getCachedExtract(u);
  if (cached) return cached;

  const buf = await downloadBuybackPdf(u, { timeoutMs: opts?.timeoutMs ?? 90_000 });
  if (!buf) throw new Error("Could not download the PDF");

  const pages = await pagesFromPdf(buf);
  const full_text = pages
    .map((p) => `--- Page ${p.page_number} ---\n${p.text}`)
    .join("\n\n")
    .trim();
  const doc: NapkinPdfExtract = {
    title: titleFromUrl(u),
    url: u,
    pages,
    full_text,
  };
  store.set(u, { at: Date.now(), doc });
  return doc;
}

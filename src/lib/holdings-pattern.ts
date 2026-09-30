/**
 * Pattern of personal holdings from stored sector fields (plus optional LLM copy).
 * No issuer lists.
 */
import fs from "fs";
import path from "path";
import { loadHoldings } from "./holdings";
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";

export type HoldingsPatternCluster = {
  label: string;
  count: number;
};

export type HoldingsPattern = {
  count: number;
  clusters: HoldingsPatternCluster[];
  lines: string[];
};

function loadPrompt(): string {
  try {
    const p = path.join(process.cwd(), "prompts", "holdings-pattern.system.txt");
    const t = fs.readFileSync(p, "utf8").trim();
    if (t) return t;
  } catch {
    /* fall through */
  }
  return 'Return JSON {"lines":[]} using only sector labels from the tally.';
}

function tallyKey(raw: string | null | undefined): string | null {
  const s = (raw || "").replace(/\s+/g, " ").trim();
  return s.length >= 2 ? s : null;
}

export function holdingsPatternFromRows(
  rows: Array<{ sector: string | null; sub_sector: string | null }>,
): HoldingsPatternCluster[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const label = tallyKey(r.sub_sector) || tallyKey(r.sector);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function linesFromClusters(
  clusters: HoldingsPatternCluster[],
  total: number,
): string[] {
  const top = clusters.slice(0, 6);
  if (!top.length) {
    return total ? [`${total} listed names (no sector on file)`] : [];
  }
  return top.map((c) => `${c.count} · ${c.label}`);
}

export async function loadHoldingsPattern(): Promise<HoldingsPattern> {
  const rows = loadHoldings();
  const clusters = holdingsPatternFromRows(rows);
  const fallback = linesFromClusters(clusters, rows.length);
  const tally = {
    count: rows.length,
    clusters: clusters.slice(0, 12),
  };
  let lines = fallback;
  try {
    const cfg = loadLlmConfig();
    const status = await checkLlmStatus(cfg);
    if (status.available && clusters.length) {
      const parsed = await completeJson(
        cfg,
        loadPrompt(),
        `Tally:\n${JSON.stringify(tally).slice(0, 8000)}`,
        {
          temperature: 0.05,
          maxTokens: 400,
          jsonSchema: {
            type: "object",
            properties: {
              lines: { type: "array", items: { type: "string" } },
            },
            required: ["lines"],
          },
        },
      );
      const got = Array.isArray(parsed.lines)
        ? parsed.lines.map((x) => String(x || "").trim()).filter(Boolean)
        : [];
      const allowed = new Set(
        clusters.flatMap((c) =>
          c.label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1),
        ),
      );
      const kept = got.filter((line) => {
        const words = line
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2 && !/^\d+$/.test(w));
        if (!words.length) return true;
        return words.every(
          (w) =>
            allowed.has(w) ||
            ["listed", "names", "names", "book", "holdings"].includes(w),
        );
      });
      if (kept.length) lines = kept.slice(0, 4);
    }
  } catch {
    /* tally lines still usable */
  }
  return { count: rows.length, clusters, lines };
}

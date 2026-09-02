import { loadAgentConfig } from "./agents/config";
import {
  buildDailyDriftPath,
  formatDailyPathForPrompt,
  type DailyDriftPoint,
} from "./concall-drift-path";
import {
  fetchDisclosureLadder,
  formatLadderForPrompt,
  ladderShortTime,
  type DisclosureLadderItem,
} from "./disclosure-ladder";
import { loadAllCompanies } from "./db";
import { buildEventMaterialCorpus } from "./investor-material-corpus";
import { ensureInvestorMaterialsForDrift } from "./investor-materials";
import { checkLlmStatus, completeJson } from "./llm-client";
import { fetchDailyBars } from "./ohlc";
import { loadPrompt } from "./prompts";

export type ConcallDriftContext = {
  earn_at: string;
  concall_at: string | null;
  quarter_fy: string | null;
  baseline_close: number | null;
  drift_pct: number | null;
  earn_subject: string | null;
  market?: string | null;
};

export type MarketBias = "long" | "short" | "neutral";

export type FilingSummary = {
  time: string;
  summary: string;
};

export type ConcallDriftReview = {
  headline: string;
  move_summary: string;
  reaction_summary: string;
  triggers: string[];
  concall_highlights: string[];
  risks: string[];
  daily_path: DailyDriftPoint[];
  sources: string;
  has_transcript: boolean;
  bias: MarketBias;
  bias_label: string;
  bias_summary: string;
  bias_callout: string | null;
  pinned_summary: string | null;
  filing_summaries: FilingSummary[];
  disclosure_ladder: DisclosureLadderItem[];
};

const DRIFT_FALLBACK = `Explain post-earn drift for an Indian stock using daily price path and Calls-tab materials. Return ONLY valid JSON with headline, move_summary, reaction_summary, triggers, concall_highlights, risks.`;

function driftSystemPrompt(): string {
  return loadPrompt("concall-drift", DRIFT_FALLBACK);
}

type CacheEntry = { at: number; hash: string; review: ConcallDriftReview | null };
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 60 * 60 * 1000;

const CHAR_LIMITS = [8000, 4000, 0] as const;

function fmtInr(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function isUsableReview(raw: Record<string, unknown>): boolean {
  const headline = String(raw.headline || "").trim();
  const summary = String(raw.move_summary || "").trim();
  if (headline.length > 8 && headline.toLowerCase() !== "post-earn move") return true;
  if (summary.length > 40 && !/insufficient source/i.test(summary)) return true;
  const triggers = Array.isArray(raw.triggers) ? raw.triggers : [];
  return triggers.some((x) => String(x || "").trim().length > 8);
}

function inferBias(driftPct: number | null | undefined): {
  bias: MarketBias;
  bias_label: string;
  bias_summary: string;
} {
  if (driftPct == null || Number.isNaN(driftPct)) {
    return {
      bias: "neutral",
      bias_label: "NEUTRAL",
      bias_summary: "Insufficient price data for a directional read",
    };
  }
  if (driftPct >= 2) {
    return {
      bias: "long",
      bias_label: "LONG bias",
      bias_summary: "Positive reaction — market rewarded the print",
    };
  }
  if (driftPct <= -2) {
    return {
      bias: "short",
      bias_label: "SHORT bias",
      bias_summary: "Negative reaction — priced as a miss / sell-the-news",
    };
  }
  return {
    bias: "neutral",
    bias_label: "NEUTRAL",
    bias_summary: "Muted reaction — no clear directional read",
  };
}

function normalizeBias(
  raw: Record<string, unknown>,
  driftPct: number | null | undefined,
): {
  bias: MarketBias;
  bias_label: string;
  bias_summary: string;
  bias_callout: string | null;
} {
  const fallback = inferBias(driftPct);
  const s = String(raw.bias || "")
    .trim()
    .toLowerCase();
  let bias: MarketBias = fallback.bias;
  if (s === "long" || s.startsWith("bull")) bias = "long";
  else if (s === "short" || s.startsWith("bear")) bias = "short";
  else if (s === "neutral") bias = "neutral";

  const label =
    bias === "long" ? "LONG bias" : bias === "short" ? "SHORT bias" : "NEUTRAL";
  const bias_summary =
    String(raw.bias_summary || "").trim().slice(0, 140) || fallback.bias_summary;
  const calloutRaw = String(raw.bias_callout || "").trim();
  const bias_callout = calloutRaw.length > 12 ? calloutRaw.slice(0, 320) : null;

  return { bias, bias_label: label, bias_summary, bias_callout };
}

function normalizeFilingSummaries(
  raw: unknown,
  ladder: DisclosureLadderItem[],
): FilingSummary[] {
  const rows = Array.isArray(raw) ? raw : [];
  if (ladder.length) {
    return ladder.map((item, i) => {
      const row = rows[i];
      const time =
        row && typeof row === "object"
          ? String((row as Record<string, unknown>).time || ladderShortTime(item.announced_at))
          : ladderShortTime(item.announced_at);
      const summary =
        row && typeof row === "object"
          ? String((row as Record<string, unknown>).summary || "").trim()
          : "";
      return {
        time: time.slice(0, 8),
        summary:
          summary ||
          `${item.title} filed; no readable text extracted from document.`,
      };
    });
  }
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      time: String((row as Record<string, unknown>).time || "—").slice(0, 8),
      summary: String((row as Record<string, unknown>).summary || "").slice(0, 400),
    }))
    .filter((r) => r.summary);
}

function buildPrompt(
  ticker: string,
  name: string,
  price: number | null,
  ctx: ConcallDriftContext,
  materialsBlock: ReturnType<typeof buildEventMaterialCorpus>,
  dailyPath: DailyDriftPoint[],
  charLimitPerMaterial: number,
  ladder: DisclosureLadderItem[],
): { prompt: string; sources: string; has_transcript: boolean } {
  const anchor = ctx.concall_at || ctx.earn_at;
  const drift =
    ctx.drift_pct != null
      ? `${ctx.drift_pct >= 0 ? "+" : ""}${ctx.drift_pct.toFixed(1)}%`
      : "unknown";
  const lines = [
    `Company: ${name} (${ticker})`,
    `Quarter: ${ctx.quarter_fy || "—"}`,
    `Earn filing (exact): ${ctx.earn_at.slice(0, 19)} · ${ctx.earn_subject || "—"}`,
    `Concall (exact): ${ctx.concall_at?.slice(0, 19) || "not paired / no NSE concall filing"}`,
    `Tracking anchor: ${anchor.slice(0, 19)} — daily sessions on/after this date`,
    `Pre-earn close (baseline): ₹${fmtInr(ctx.baseline_close)}`,
    `CMP: ₹${fmtInr(price)}`,
    `Total drift since baseline: ${drift}`,
    "",
    "=== DISCLOSURE LADDER (NSE filings in event window — chronological) ===",
    formatLadderForPrompt(ladder),
    "",
    "=== DAILY PRICE AFTER EVENT (vs baseline) ===",
    formatDailyPathForPrompt(dailyPath),
  ];

  let sources = ctx.earn_subject || "NSE earn filing";
  let hasTranscript = materialsBlock.hasConcallOrTranscript;

  if (charLimitPerMaterial > 0 && materialsBlock.hasUsableText) {
    const corpus = buildEventMaterialCorpus(ticker, anchor, {
      charLimitPerMaterial,
    });
    sources = corpus.sources || sources;
    hasTranscript = corpus.hasUsableText;
    lines.push("", "=== INVESTOR MATERIALS (Calls tab — concall / PPT / PDF) ===", corpus.promptBlock);
  } else if (charLimitPerMaterial > 0) {
    lines.push(
      "",
      "No investor materials in Calls tab for this event — download concall/PPT on Calls tab.",
      "Explain cautiously from earn filing context only.",
    );
  } else {
    lines.push("", "Investor materials omitted (retry with shorter context).");
  }

  return { prompt: lines.join("\n"), sources, has_transcript: hasTranscript };
}

function normalizeReview(
  raw: Record<string, unknown>,
  sources: string,
  hasTranscript: boolean,
  dailyPath: DailyDriftPoint[],
  ladder: DisclosureLadderItem[],
  driftPct: number | null | undefined,
): ConcallDriftReview {
  const asStrings = (v: unknown, max: number): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, max);
  };

  const biasFields = normalizeBias(raw, driftPct);
  const pinned = String(raw.pinned_summary || "").trim().slice(0, 400) || null;

  return {
    headline: String(raw.headline || "Post-earn move").slice(0, 140),
    move_summary: String(raw.move_summary || "").slice(0, 1200) || "Insufficient source text.",
    reaction_summary:
      String(raw.reaction_summary || "").slice(0, 600) ||
      "Daily path not yet clear from available sessions.",
    triggers: asStrings(raw.triggers, 5),
    concall_highlights: asStrings(raw.concall_highlights, 5),
    risks: asStrings(raw.risks, 3),
    daily_path: dailyPath,
    sources,
    has_transcript: hasTranscript,
    bias: biasFields.bias,
    bias_label: biasFields.bias_label,
    bias_summary: biasFields.bias_summary,
    bias_callout: biasFields.bias_callout,
    pinned_summary: pinned,
    filing_summaries: normalizeFilingSummaries(raw.filing_summaries, ladder),
    disclosure_ladder: ladder,
  };
}

function cacheKey(ticker: string, ctx: ConcallDriftContext): string {
  return [
    ticker.toUpperCase(),
    ctx.earn_at.slice(0, 10),
    ctx.concall_at?.slice(0, 10) || "",
    ctx.drift_pct?.toFixed(1) || "",
  ].join("|");
}

export async function generateConcallDriftReview(
  ticker: string,
  ctx: ConcallDriftContext,
  price: number | null | undefined,
): Promise<{
  review: ConcallDriftReview | null;
  error?: string;
  hint?: string;
}> {
  const key = ticker.toUpperCase();
  if (!key) return { review: null, error: "ticker required" };

  const company = loadAllCompanies().find((c) => c.ticker.toUpperCase() === key);
  const cmp = price ?? company?.price ?? null;
  const anchor = ctx.concall_at || ctx.earn_at;

  try {
    await ensureInvestorMaterialsForDrift(key, anchor);
  } catch {
    /* best-effort — proceed with whatever is on file */
  }

  const materialsPreview = buildEventMaterialCorpus(key, anchor);
  const market = ctx.market ?? company?.market ?? null;

  let dailyPath: DailyDriftPoint[] = [];
  try {
    const bars = await fetchDailyBars(key, market, 1);
    dailyPath = buildDailyDriftPath(bars, anchor, ctx.baseline_close);
  } catch {
    /* best-effort */
  }

  let ladder: DisclosureLadderItem[] = [];
  try {
    ladder = await fetchDisclosureLadder(key, market, anchor, ctx.earn_at);
  } catch {
    /* best-effort */
  }

  const hash = [
    materialsPreview.materials.map((m) => m.updated_at).join("|"),
    ctx.earn_at,
    ctx.drift_pct ?? "",
    dailyPath.length,
    ladder.map((l) => l.announced_at).join("|"),
  ].join("|");

  const ck = cacheKey(key, ctx);
  const hit = cache.get(ck);
  if (hit && hit.hash === hash && Date.now() - hit.at < CACHE_MS) {
    return { review: hit.review };
  }

  const cfg = loadAgentConfig();
  const llm = await checkLlmStatus(cfg);
  if (!llm.available) {
    return {
      review: null,
      error: "LLM unavailable",
      hint: llm.hint,
    };
  }

  let lastError = "Review failed";
  for (const charLimit of CHAR_LIMITS) {
    const attemptBuilt = buildPrompt(
      key,
      company?.name || key,
      cmp,
      ctx,
      materialsPreview,
      dailyPath,
      charLimit,
      ladder,
    );
    try {
      const parsed = await Promise.race([
        completeJson(cfg, driftSystemPrompt(), attemptBuilt.prompt.slice(0, 28_000), {
          numPredict: 2200,
          temperature: 0.15,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("concall drift review timeout")), 90_000),
        ),
      ]);
      if (!isUsableReview(parsed)) {
        lastError = "LLM returned empty analysis — retrying with shorter context";
        continue;
      }
      const review = normalizeReview(
        parsed,
        attemptBuilt.sources,
        attemptBuilt.has_transcript,
        dailyPath,
        ladder,
        ctx.drift_pct,
      );
      cache.set(ck, { at: Date.now(), hash, review });
      return { review };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Review failed";
    }
  }

  cache.set(ck, { at: Date.now(), hash, review: null });
  return { review: null, error: lastError, hint: llm.hint };
}

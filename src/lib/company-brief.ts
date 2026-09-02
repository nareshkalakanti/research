import { loadLlmConfig, type LlmConfig } from "./llm-config";
import {
  computePeerUniqueness,
  peerContextBlock,
  type PeerUniqueness,
} from "./company-uniqueness";
import { buildCompanyDossierText, loadAllCompanies } from "./db";
import { formatInvestorMaterialsBriefBlock } from "./investor-material-corpus";
import { checkLlmStatus, completeJson, type LlmStatus } from "./llm-client";
import { loadPrompt } from "./prompts";
import { loadQuarterDossier } from "./quarter-dossier";
import { classifyQuarterTrend, type QtrTrendSignal } from "./quarter-trend";
import { capTier, formatMcap, type CapTier } from "./types";
import type { QuarterPanel } from "./quarter-panel";

export type MatchedThemeTag = {
  id: string;
  tag: string;
  name: string;
};

export type CompanyBriefContext = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  sub_sector: string | null;
  themes: MatchedThemeTag[];
  headquarters: string | null;
  mcap_cr: number | null;
  mcap_label: string | null;
  cap_band: CapTier;
  cap_name: string;
  peers: PeerUniqueness;
};

export type QtrSignal = QtrTrendSignal;

export type OfferingItem = {
  name: string;
  line: string;
};

export type CompanyBrief = {
  sector: string;
  sub_sector: string;
  themes: string[];
  headline: string;
  capabilities: string;
  growth_triggers: string;
  capex: string;
  niche: string;
  model: string;
  angle: string;
  uniqueness: string;
  /** @deprecated Use offerings — kept for cached briefs */
  products: string[];
  offerings: OfferingItem[];
  customers: string;
  qtr_signal: QtrSignal | null;
  qtr_reason: string;
  watch: string;
};

const CAP_NAMES: Record<CapTier, string> = {
  NC: "Unclassified",
  TI: "Tiny cap",
  MIC: "Micro cap",
  SC: "Small cap",
  MC: "Mid cap",
  LC: "Large cap",
};

const BRIEF_FALLBACK = `You explain Indian listed companies for equity researchers.
Return ONLY valid JSON (no markdown):
{
  "sector": "listing sector from dossier or best fit",
  "sub_sector": "sub-sector or industry",
  "theme": "one short investment theme (2-5 words)",
  "headline": "≤12 words — core business in plain English",
  "capabilities": "ONE sentence — the single most differentiating technical asset for THIS company",
  "growth_triggers": "2-4 short catalyst clauses separated by · — from dossier and investor materials",
  "capex": "One line from investor materials or unclear from sources",
  "niche": "1-2 sentences on niche, specialization, or edge",
  "model": "business model in ≤12 words",
  "offerings": [
    "Product name — one line what it is and who uses it",
    "Another line — one line explanation"
  ],
  "customers": "who buys / end markets in one sentence",
  "qtr_signal": "exactly one of: Growing, Inconsistent, Declining",
  "qtr_reason": "One short sentence on 5-quarter pattern",
  "watch": "one risk or thing to verify"
}
Use only facts from dossier, peer context, quarterly data, and investor materials. Read Investor materials before capex and growth_triggers. Return valid JSON only — no markdown fences.`;

function briefSystemPrompt(): string {
  return loadPrompt("business-brief", BRIEF_FALLBACK);
}

type CacheEntry = { at: number; brief: CompanyBrief; corpusHash: string };
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 60 * 60 * 1000;

function corpusHash(text: string): string {
  return `v18:${text.length}:${text.slice(0, 120)}`;
}

const BRIEF_USER_CHAR_LIMIT = 30_000;
const BRIEF_JSON_OPTS = { numPredict: 1800, temperature: 0.12 } as const;

async function completeBriefJson(
  cfg: LlmConfig,
  corpus: string,
): Promise<Record<string, unknown>> {
  const user = `Company dossier:\n${corpus.slice(0, BRIEF_USER_CHAR_LIMIT)}`;
  const system = briefSystemPrompt();
  try {
    return await completeJson(cfg, system, user, BRIEF_JSON_OPTS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!/json|incomplete/i.test(msg)) throw err;
    return completeJson(cfg, system, user, {
      ...BRIEF_JSON_OPTS,
      numPredict: 2400,
      skipStatusCheck: true,
    });
  }
}

function normalizeQtrSignal(raw: unknown): QtrSignal | null {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s.startsWith("grow")) return "Growing";
  if (s.startsWith("inconsist") || s.startsWith("mixed") || s.startsWith("lumpy")) {
    return "Inconsistent";
  }
  if (s.startsWith("declin") || s.startsWith("bad") || s.startsWith("weak")) {
    return "Declining";
  }
  return null;
}

function buildContext(
  row: {
    ticker: string;
    name: string;
    market: string;
    sector: string | null;
    sub_sector: string | null;
    headquarters: string | null;
    mcap_cr: number | null;
    about: string | null;
    scraped_about: string | null;
    search_text: string;
    theme_search_text: string;
  },
  peers: PeerUniqueness,
  matchedThemes: MatchedThemeTag[],
): CompanyBriefContext {
  const band = capTier(row.mcap_cr);
  return {
    ticker: row.ticker,
    name: row.name,
    market: row.market,
    sector: row.sector,
    sub_sector: row.sub_sector,
    themes: matchedThemes,
    headquarters: row.headquarters,
    mcap_cr: row.mcap_cr,
    mcap_label: row.mcap_cr != null ? formatMcap(row.mcap_cr) : null,
    cap_band: band,
    cap_name: CAP_NAMES[band],
    peers,
  };
}

function buildCorpus(row: {
  name: string;
  ticker: string;
  market: string;
  sector: string | null;
  sub_sector: string | null;
  headquarters: string | null;
  mcap_cr: number | null;
  theme_search_text: string;
  scraped_about_clean: string | null;
  dossier_text?: string;
}): string {
  return row.dossier_text?.trim() || buildCompanyDossierText(row);
}

function splitOfferingLabel(text: string): { name: string; line: string } {
  const t = text.trim();
  if (!t) return { name: "", line: "" };
  const dash = t.match(/^(.+?)\s*[—–-]\s+(.+)$/);
  if (dash) {
    return { name: dash[1]!.trim(), line: dash[2]!.trim() };
  }
  const colon = t.match(/^([^:]{2,48}):\s+(.+)$/);
  if (colon) {
    return { name: colon[1]!.trim(), line: colon[2]!.trim() };
  }
  return { name: t, line: "" };
}

function normalizeOfferings(
  offeringsRaw: unknown,
  productsRaw: unknown,
): OfferingItem[] {
  const out: OfferingItem[] = [];
  const seen = new Set<string>();

  const add = (name: string, line: string) => {
    const n = name.trim().slice(0, 80);
    const l = line.trim().slice(0, 160);
    if (!n) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, line: l });
  };

  if (Array.isArray(offeringsRaw)) {
    for (const item of offeringsRaw) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const o = item as Record<string, unknown>;
        const name = String(o.name || o.product || o.label || "").trim();
        const line = String(o.line || o.description || o.detail || "").trim();
        if (name) add(name, line);
        continue;
      }
      if (typeof item === "string") {
        const { name, line } = splitOfferingLabel(item);
        if (name) add(name, line);
      }
    }
  }

  if (!out.length) {
    for (const name of normalizeProducts(productsRaw)) {
      const { name: n, line } = splitOfferingLabel(name);
      add(n, line);
    }
  }

  return out.slice(0, 6);
}

function normalizeProducts(raw: unknown): string[] {
  const items: string[] = [];
  if (Array.isArray(raw)) {
    for (const p of raw) items.push(String(p).trim());
  } else if (typeof raw === "string") {
    items.push(raw.trim());
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item) continue;
    const parts = item
      .split(/[,;|\n/]+|(?:\s+·\s+)/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of parts.length > 1 ? parts : [item]) {
      const key = p.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(p.slice(0, 80));
    }
  }
  return out.slice(0, 8);
}

function normalizeBrief(
  raw: Record<string, unknown>,
  row: {
    sector: string | null;
    sub_sector: string | null;
  },
  matchedThemes: MatchedThemeTag[],
): CompanyBrief {
  const offerings = normalizeOfferings(raw.offerings, raw.products);
  const products = offerings.length
    ? offerings.map((o) => o.name)
    : normalizeProducts(raw.products);
  const llmTheme = String(raw.theme || "").trim().slice(0, 80);
  const themeTags = matchedThemes.length
    ? matchedThemes.map((t) => t.tag)
    : llmTheme
      ? [llmTheme]
      : [];
  return {
    sector: (row.sector?.trim() || String(raw.sector || "").trim()).slice(0, 80),
    sub_sector: (row.sub_sector?.trim() || String(raw.sub_sector || "").trim()).slice(
      0,
      80,
    ),
    themes: themeTags,
    headline: String(raw.headline || "Business summary unavailable").slice(0, 120),
    capabilities: String(raw.capabilities || "").slice(0, 420),
    growth_triggers: String(raw.growth_triggers || "").slice(0, 420),
    capex: String(raw.capex || "").slice(0, 280),
    niche: String(raw.niche || "").slice(0, 400),
    model: String(raw.model || "").slice(0, 120),
    angle: String(raw.angle || "").slice(0, 280),
    uniqueness: String(raw.uniqueness || "").slice(0, 320),
    products,
    offerings,
    customers: String(raw.customers || "").slice(0, 240),
    qtr_signal: normalizeQtrSignal(raw.qtr_signal),
    qtr_reason: String(raw.qtr_reason || raw.quarters || "").slice(0, 320),
    watch: String(raw.watch || "").slice(0, 240),
  };
}

export async function getLlmStatus(): Promise<LlmStatus> {
  return checkLlmStatus(loadLlmConfig());
}

export async function generateCompanyBrief(
  ticker: string,
  market?: string | null,
  price?: number | null,
  quarterBlock?: string | null,
  quarterPanel?: QuarterPanel | null,
): Promise<{
  llm: LlmStatus;
  context: CompanyBriefContext | null;
  brief: CompanyBrief | null;
  cached: boolean;
  error?: string;
}> {
  const cfg = loadLlmConfig();
  const llm = await checkLlmStatus(cfg);
  const row = loadAllCompanies().find(
    (c) =>
      c.ticker.toUpperCase() === ticker.toUpperCase() &&
      (!market || c.market === market),
  );
  if (!row) {
    return {
      llm,
      context: null,
      brief: null,
      cached: false,
      error: "Company not found",
    };
  }

  const matchedThemes: MatchedThemeTag[] = [];
  const context = buildContext(
    row,
    computePeerUniqueness(row, loadAllCompanies()),
    matchedThemes,
  );
  const investorBlock = formatInvestorMaterialsBriefBlock(row.ticker);
  const qtrTrend = quarterPanel ? classifyQuarterTrend(quarterPanel) : null;
  const themeBlock = matchedThemes.length
    ? [
        "",
        "Matched investment themes (keyword + sector gate):",
        matchedThemes.map((t) => `${t.tag} (${t.name})`).join(" · "),
      ].join("\n")
    : null;
  const qtrText =
    quarterBlock !== undefined
      ? quarterBlock
      : await loadQuarterDossier(row.ticker, row.market, price);
  const corpus = [
    buildCorpus(row),
    "",
    "Peer context (listed Indian market):",
    peerContextBlock(context.peers),
    qtrText ? ["", "Quarterly data (same as QTR tab):", qtrText].join("\n") : null,
    qtrTrend
      ? [
          "",
          "Computed QTR trend (from 5-quarter panel):",
          `${qtrTrend.signal} — ${qtrTrend.reason}`,
        ].join("\n")
      : null,
    investorBlock ? ["", investorBlock].join("\n") : null,
    themeBlock,
  ]
    .filter(Boolean)
    .join("\n");
  if (corpus.replace(/\s/g, "").length < 40) {
    return {
      llm,
      context,
      brief: null,
      cached: false,
      error: "Not enough company text — add About or scrape the website first",
    };
  }

  const cacheKey = `${row.market}:${row.ticker}`.toUpperCase();
  const hash = corpusHash(corpus);
  const hit = cache.get(cacheKey);
  if (hit && hit.corpusHash === hash && Date.now() - hit.at < CACHE_MS) {
    return { llm, context, brief: hit.brief, cached: true };
  }

  if (!llm.available) {
    return {
      llm,
      context,
      brief: null,
      cached: false,
      error: llm.detail,
    };
  }

  try {
    const parsed = await completeBriefJson(cfg, corpus);
    const brief = normalizeBrief(parsed, row, matchedThemes);
    if (qtrTrend) {
      brief.qtr_signal = qtrTrend.signal;
      if (!brief.qtr_reason.trim()) brief.qtr_reason = qtrTrend.reason;
    }
    cache.set(cacheKey, { at: Date.now(), brief, corpusHash: hash });
    return { llm, context, brief, cached: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM request failed";
    return { llm, context, brief: null, cached: false, error: message };
  }
}

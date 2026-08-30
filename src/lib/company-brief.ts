import { loadAgentConfig } from "./agents/config";
import {
  computePeerUniqueness,
  peerContextBlock,
  type PeerUniqueness,
} from "./company-uniqueness";
import { buildGovernanceBrief, type GovBriefSignal } from "./governance-brief";
import { buildCompanyDossierText, loadAllCompanies } from "./db";
import { formatInvestorMaterialsBriefBlock } from "./investor-materials";
import { generateInvestorCallReview } from "./investor-call-review";
import { checkLlmStatus, completeJson, type LlmStatus } from "./llm-client";
import { loadQuarterDossier } from "./quarter-dossier";
import { classifyQuarterTrend, type QtrTrendSignal } from "./quarter-trend";
import { capTier, formatMcap, type CapTier } from "./types";
import type { QuarterPanel } from "./quarter-panel";

export type CompanyBriefContext = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  sub_sector: string | null;
  headquarters: string | null;
  mcap_cr: number | null;
  mcap_label: string | null;
  cap_band: CapTier;
  cap_name: string;
  peers: PeerUniqueness;
};

export type QtrSignal = QtrTrendSignal;
export type GovSignal = GovBriefSignal;

export type CallReviewDirection = "positive" | "negative" | "neutral";

export type CallReviewRow = {
  category: string;
  what_said: string;
  direction: CallReviewDirection;
  thesis_impact: string;
};

export type CompanyBrief = {
  headline: string;
  capabilities: string;
  growth_triggers: string;
  capex: string;
  niche: string;
  model: string;
  angle: string;
  uniqueness: string;
  products: string[];
  customers: string;
  qtr_signal: QtrSignal | null;
  qtr_reason: string;
  gov_signal: GovSignal | null;
  gov_reason: string;
  watch: string;
  call_review_headline?: string;
  call_review_sources?: string;
  call_review_rows?: CallReviewRow[];
};

const CAP_NAMES: Record<CapTier, string> = {
  NC: "Unclassified",
  TI: "Tiny cap",
  MIC: "Micro cap",
  SC: "Small cap",
  MC: "Mid cap",
  LC: "Large cap",
};

const BRIEF_SYSTEM = `You explain Indian listed companies for equity researchers.
Return ONLY valid JSON (no markdown):
{
  "headline": "≤12 words — core business in plain English",
  "capabilities": "ONE sentence — the single most differentiating technical asset for THIS company (platform, integration, scale, IP, route-to-market). Examples: backward-integrated API/peptide SPPS, sole-source contrast intermediates, REPM magnet stack, offshore E&P block, EMS SMT capacity, sterile injectables at ANDA scale — pick what fits the dossier.",
  "growth_triggers": "2-4 short catalyst clauses separated by · — from dossier only: plant/block commissioning, PLI/policy tailwind, export mix, order book, segment mix, tariff/China+1, tender wins, capacity utilization. Do not invent dates or ₹.",
  "capex": "One line. Prefer verbatim 'CAPEX: …' from Investor materials when present. If concall/PPT were reviewed but no ₹ capex/guidance is stated, say so with period (e.g. 'No capex guidance in Aug 2022 concall/PPT'). Say 'concall transcript unavailable' only when dossier explicitly notes transcript/PDF not fetched. Use 'FY26/FY27 CAPEX: ₹X cr (project)' when amount is in dossier. Do not invent ₹. Say 'unclear from sources' only when no investor materials and no capacity/capex mention anywhere.",
  "niche": "1-2 sentences on niche, specialization, or edge",
  "model": "business model in ≤12 words (e.g. asset-light B2B services, integrated manufacturer)",
  "products": ["3-5 short items — one product per array element, no commas inside"],
  "customers": "who buys / end markets in one sentence",
  "qtr_signal": "exactly one of: Growing, Inconsistent, Declining — use Computed QTR trend if provided; else infer from quarterly data",
  "qtr_reason": "One short sentence explaining the 5-quarter sales/NP pattern; cite sequential up-counts or QoQ % from Key metrics",
  "gov_signal": "exactly one of: Stable, Churn, Red flag — use Governance block if provided",
  "gov_reason": "One short sentence on board changes in last 12 months",
  "watch": "one risk, dependency, or thing to verify"
}
Use only facts from company dossier, peer context, quarterly data, and governance block. If unknown, say "unclear from sources". Be specific to this company, not generic sector boilerplate.`;

type CacheEntry = { at: number; brief: CompanyBrief; corpusHash: string };
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 60 * 60 * 1000;

function corpusHash(text: string): string {
  return `v13:${text.length}:${text.slice(0, 120)}`;
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

function normalizeGovSignal(raw: unknown): GovSignal | null {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s.startsWith("stable")) return "Stable";
  if (s.startsWith("churn")) return "Churn";
  if (s.startsWith("red")) return "Red flag";
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
  },
  peers: PeerUniqueness,
): CompanyBriefContext {
  const band = capTier(row.mcap_cr);
  return {
    ticker: row.ticker,
    name: row.name,
    market: row.market,
    sector: row.sector,
    sub_sector: row.sub_sector,
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

function normalizeBrief(raw: Record<string, unknown>): CompanyBrief {
  const products = normalizeProducts(raw.products);
  return {
    headline: String(raw.headline || "Business summary unavailable").slice(0, 120),
    capabilities: String(raw.capabilities || "").slice(0, 420),
    growth_triggers: String(raw.growth_triggers || "").slice(0, 420),
    capex: String(raw.capex || "").slice(0, 280),
    niche: String(raw.niche || "").slice(0, 400),
    model: String(raw.model || "").slice(0, 120),
    angle: String(raw.angle || "").slice(0, 280),
    uniqueness: String(raw.uniqueness || "").slice(0, 320),
    products,
    customers: String(raw.customers || "").slice(0, 240),
    qtr_signal: normalizeQtrSignal(raw.qtr_signal),
    qtr_reason: String(raw.qtr_reason || raw.quarters || "").slice(0, 320),
    gov_signal: normalizeGovSignal(raw.gov_signal),
    gov_reason: String(raw.gov_reason || "").slice(0, 320),
    watch: String(raw.watch || "").slice(0, 240),
  };
}

export async function getLlmStatus(): Promise<LlmStatus> {
  return checkLlmStatus(loadAgentConfig());
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
  const cfg = loadAgentConfig();
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

  const context = buildContext(row, computePeerUniqueness(row, loadAllCompanies()));
  const govBrief = buildGovernanceBrief(row.ticker);
  const investorBlock = formatInvestorMaterialsBriefBlock(row.ticker);
  const qtrTrend = quarterPanel ? classifyQuarterTrend(quarterPanel) : null;
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
    [
      "",
      "Governance (board_seat_events, last 12 months):",
      `${govBrief.signal ?? "Stable"} — ${govBrief.reason}`,
    ].join("\n"),
    investorBlock ? ["", investorBlock].join("\n") : null,
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
    const [parsed, callReview] = await Promise.all([
      completeJson(cfg, BRIEF_SYSTEM, `Company dossier:\n${corpus}`),
      generateInvestorCallReview(row.ticker).catch(() => null),
    ]);
    const brief = normalizeBrief(parsed);
    if (qtrTrend) {
      brief.qtr_signal = qtrTrend.signal;
      if (!brief.qtr_reason.trim()) brief.qtr_reason = qtrTrend.reason;
    }
    if (govBrief.signal) {
      brief.gov_signal = govBrief.signal;
      if (!brief.gov_reason.trim()) brief.gov_reason = govBrief.reason;
    }
    if (callReview) {
      brief.call_review_headline = callReview.headline;
      brief.call_review_sources = callReview.sources;
      brief.call_review_rows = callReview.rows;
      const capexRow = callReview.rows.find((r) =>
        /capex & balance sheet/i.test(r.category),
      );
      if (
        capexRow &&
        capexRow.what_said !== "Not disclosed" &&
        (!brief.capex.trim() || /unclear from sources/i.test(brief.capex))
      ) {
        brief.capex = capexRow.what_said.slice(0, 280);
      }
    }
    cache.set(cacheKey, { at: Date.now(), brief, corpusHash: hash });
    return { llm, context, brief, cached: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM request failed";
    return { llm, context, brief: null, cached: false, error: message };
  }
}

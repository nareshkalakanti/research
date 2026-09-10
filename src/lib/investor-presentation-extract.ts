/**
 * Investor Presentation (SEBI Reg. 30 deck) → structured JSON extract.
 * Schema + system prompt: prompts/investor-presentation-extract.system.txt
 * Fixture: data/investor-presentation-expected-krn.json
 */
import fs from "fs";
import path from "path";
import { applyInvestorPresentationLexical } from "./investor-presentation-lexical";
import { parseOrderSizeToCr } from "./orderbook-screen";

export type InvestorPresentationExtract = Record<string, unknown>;

const EXPECTED_PATH = path.join(
  process.cwd(),
  "data",
  "investor-presentation-expected-krn.json",
);

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
  ) => Promise<{ text?: string }>;
  const parsed = await pdfParse(buf);
  return (parsed.text || "").replace(/[ \t\u00a0]+/g, " ").trim();
}

function emptyExtract(): InvestorPresentationExtract {
  return {
    metadata: {},
    business_overview: {},
    leadership: {},
    chairman_commentary: {},
    q1_fy27_financials: {},
    revenue_mix: {},
    multi_year_consolidated_financials: {},
    balance_sheet_consolidated: {},
    shareholding_and_share_price: {},
    risk_disclosures: {},
    sentiment_assessment: {},
  };
}

/** Fill / overwrite table facts from the text layer (pdf-parse glues cells). */
export function enrichInvestorPresentationLexical(
  text: string,
  extract: InvestorPresentationExtract,
): InvestorPresentationExtract {
  return applyInvestorPresentationLexical(text, extract);
}

export type InvestorPresentationResult = {
  ok: boolean;
  extract: InvestorPresentationExtract;
  engine: string;
  text_chars: number;
  error?: string;
};

export async function extractInvestorPresentationPdf(opts: {
  pdfBuffer: Buffer;
}): Promise<InvestorPresentationResult> {
  let text = "";
  let engine = "pdf-parse";
  try {
    text = await extractPdfText(opts.pdfBuffer);
  } catch (e) {
    return {
      ok: false,
      extract: emptyExtract(),
      engine,
      text_chars: 0,
      error: e instanceof Error ? e.message : "pdf-parse failed",
    };
  }
  if (!text) {
    return {
      ok: false,
      extract: emptyExtract(),
      engine,
      text_chars: 0,
      error: "No text in PDF",
    };
  }

  // Lexical-only for decks: table parsers are the source of truth for P&L.
  // Skipping LLM avoids multi-minute hangs that left the Extract panel empty.
  const extract = enrichInvestorPresentationLexical(text, emptyExtract());
  return {
    ok: true,
    extract,
    engine: `${engine}+lexical`,
    text_chars: text.length,
  };
}

export function loadKrnInvestorExpected(): InvestorPresentationExtract {
  return JSON.parse(
    fs.readFileSync(EXPECTED_PATH, "utf8"),
  ) as InvestorPresentationExtract;
}

/** Compare extract vs expected fixture; returns path-level mismatches. */
export function validateInvestorPresentationExtract(
  actual: InvestorPresentationExtract,
  expected: InvestorPresentationExtract,
): { ok: boolean; matched: number; checked: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let matched = 0;
  let checked = 0;

  const push = (pathKey: string, a: unknown, e: unknown) => {
    checked += 1;
    if (JSON.stringify(a) === JSON.stringify(e)) {
      matched += 1;
      return;
    }
    if (typeof a === "number" && typeof e === "number") {
      if (Math.abs(a - e) < 0.05) {
        matched += 1;
        return;
      }
    }
    if (typeof a === "string" && typeof e === "string") {
      const norm = (s: string) =>
        s
          .toLowerCase()
          .replace(/\blimited\b/g, "ltd")
          .replace(/&/g, " and ")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      if (
        norm(a) === norm(e) ||
        norm(a).includes(norm(e)) ||
        norm(e).includes(norm(a))
      ) {
        matched += 1;
        return;
      }
    }
    mismatches.push(
      `${pathKey}: got ${JSON.stringify(a)} expected ${JSON.stringify(e)}`,
    );
  };

  const metaA = asObj(actual.metadata) || {};
  const metaE = asObj(expected.metadata) || {};
  for (const k of [
    "company_name",
    "nse_symbol",
    "bse_code",
    "isin",
    "cin",
    "document_type",
    "quarter",
    "fiscal_year",
    "filing_date",
  ]) {
    push(`metadata.${k}`, metaA[k], metaE[k]);
  }

  const qA =
    asObj(actual.q1_fy27_financials) ||
    asObj(
      actual[
        Object.keys(actual).find((k) => /^q\d_fy\d{2}_financials$/i.test(k)) ||
          ""
      ],
    ) ||
    {};
  const qE = asObj(expected.q1_fy27_financials) || {};
  for (const side of ["standalone", "consolidated"] as const) {
    const sideA = asObj(qA[side]) || {};
    const sideE = asObj(qE[side]) || {};
    for (const metric of [
      "revenue_from_operations",
      "ebitda",
      "net_profit",
      "eps",
    ]) {
      const rowA = asObj(sideA[metric]) || {};
      const rowE = asObj(sideE[metric]) || {};
      for (const f of ["q1_fy27", "q1_fy26", "yoy_growth_pct"]) {
        if (f in rowE) {
          push(`q1_fy27_financials.${side}.${metric}.${f}`, rowA[f], rowE[f]);
        }
      }
    }
  }

  const shareA = asObj(actual.shareholding_and_share_price) || {};
  const shareE = asObj(expected.shareholding_and_share_price) || {};
  for (const k of [
    "share_price_inr",
    "market_cap_inr_cr",
    "shares_outstanding",
    "52_week_high_inr",
    "52_week_low_inr",
    "share_performance_return_pct",
  ]) {
    push(`shareholding_and_share_price.${k}`, shareA[k], shareE[k]);
  }
  const patE =
    asObj(shareE.shareholding_pattern_as_of_2026_06_30) ||
    asObj(
      shareE[
        Object.keys(shareE).find((k) =>
          k.startsWith("shareholding_pattern_as_of_"),
        ) || ""
      ],
    ) ||
    {};
  const patA =
    asObj(shareA.shareholding_pattern_as_of_2026_06_30) ||
    asObj(
      shareA[
        Object.keys(shareA).find((k) =>
          k.startsWith("shareholding_pattern_as_of_"),
        ) || ""
      ],
    ) ||
    {};
  for (const k of [
    "promoter_and_promoter_group_pct",
    "institutions_pct",
    "non_institutions_pct",
  ]) {
    push(`shareholding_pattern.${k}`, patA[k], patE[k]);
  }

  const bsA = asObj(actual.balance_sheet_consolidated) || {};
  const bsE = asObj(expected.balance_sheet_consolidated) || {};
  for (const fy of ["FY24", "FY25", "FY26"]) {
    const rowA = asObj(bsA[fy]) || {};
    const rowE = asObj(bsE[fy]) || {};
    push(
      `balance_sheet_consolidated.${fy}.total_assets`,
      rowA.total_assets,
      rowE.total_assets,
    );
    push(
      `balance_sheet_consolidated.${fy}.total_equity_and_liabilities`,
      rowA.total_equity_and_liabilities,
      rowE.total_equity_and_liabilities,
    );
  }

  const multiA = asObj(actual.multi_year_consolidated_financials) || {};
  const multiE = asObj(expected.multi_year_consolidated_financials) || {};
  const cashA = Array.isArray(multiA.cash_flow) ? multiA.cash_flow : [];
  const cashE = Array.isArray(multiE.cash_flow) ? multiE.cash_flow : [];
  const fy26E = cashE.find(
    (r) => asObj(r)?.fiscal_year === "FY26",
  ) as Record<string, unknown> | undefined;
  const fy26A = cashA.find(
    (r) => asObj(r)?.fiscal_year === "FY26",
  ) as Record<string, unknown> | undefined;
  push(
    "multi_year.cash_flow.FY26.operating",
    fy26A?.operating,
    fy26E?.operating,
  );

  return {
    ok: mismatches.length === 0,
    matched,
    checked,
    mismatches,
  };
}

/** True when PDF text is an investor deck / Reg-30 presentation, not an earnings call transcript. */
export function looksLikeInvestorPresentation(text: string): boolean {
  const head = text.slice(0, 12_000);
  const transcriptCue =
    /Moderator\s*:|Ladies and gentlemen|earnings conference call|Good (?:morning|afternoon|evening).{0,80}welcome to the/i.test(
      head,
    ) ||
    /Analyst\s*\/\s*Investor Conference/i.test(head) ||
    /special purpose conference call/i.test(head) ||
    /Machine-generated transcript/i.test(head) ||
    /Transcript Notes\s*·/i.test(head) ||
    /Key Takeaways\s*•/i.test(head);
  if (transcriptCue) return false;
  // Strong single cues — Valorem / Reg.30 / KRN-style decks
  if (
    /Investor Presentation\s*\|\s*Q\d/i.test(text) ||
    /Q\d[-–\s]*FY\d{2}\s+Earnings Presentation/i.test(text) ||
    (/Earnings Presentation/i.test(text) &&
      /(?:Key Financial|Quarterly Financial Performance|Capital Market Data)/i.test(
        text,
      )) ||
    /Regulation\s*30[^\n]{0,120}(?:Investor\s+)?Presentation/i.test(text) ||
    /Presentation for the Investor Conference Call/i.test(text) ||
    /enclosed the presentation for the Investor Conference Call/i.test(text) ||
    (/QoQ Sales\s*\(INR Cr\)/i.test(text) &&
      /QoQ EBITDA\s*\(INR Cr\)/i.test(text))
  ) {
    return true;
  }
  const deckHits = [
    /Investor Presentation\s*\|\s*Q\d/i,
    /Subject:[^\n]{0,80}Investors?['']?\s*Presentation/i,
    /Subject:[^\n]{0,100}Presentation for the Investor/i,
    /Safe Harbour Statement/i,
    /Investors?['']?\s*Presentation/i,
    /Shareholding Pattern\s*&\s*Share Price/i,
    /Earnings Presentation/i,
    /forward[- ]looking statements/i,
    /QoQ Sales\s*\(INR Cr\)/i,
    /Consolidated Financial Performance Q\d/i,
  ].filter((re) => re.test(text)).length;
  return deckHits >= 2;
}

function asNumLocal(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Mn / Lacs / Cr → ₹ Cr via shared orderbook unit parser. */
function toInrCr(value: number | null, unit: string): number | null {
  if (value == null) return null;
  const u = unit.trim();
  let labeled: string;
  if (/\bmn\b|million/i.test(u)) labeled = `INR ${value} Mn`;
  else if (/\blac|lakh/i.test(u)) labeled = `INR ${value} Lacs`;
  else if (/\bbn\b|billion/i.test(u)) labeled = `INR ${value} Billion`;
  else if (/\bcr|crore/i.test(u)) labeled = `INR ${value} Cr`;
  else if (/^inr$/i.test(u) || u === "₹") return value; // EPS etc.
  else labeled = `INR ${value} Cr`;
  return parseOrderSizeToCr(labeled) ?? (/cr|crore/i.test(u) ? value : null);
}

function formatInrCr(value: number | null, unit: string): string | null {
  const cr = toInrCr(value, unit);
  if (cr == null) return null;
  const pretty = Number.isInteger(cr)
    ? String(cr)
    : String(Math.round(cr * 100) / 100);
  return `₹${pretty} Cr`;
}

function deckMetric(row: unknown): Record<string, unknown> | null {
  const o = asObj(row);
  if (!o) return null;
  const cur = asNumLocal(o.q1_fy27) ?? asNumLocal(o.current_qtr);
  if (cur == null) return null;
  const rawUnit = typeof o.unit === "string" ? o.unit : "INR cr";
  const isEps = /^inr$/i.test(rawUnit.trim()) || rawUnit.trim() === "₹";
  const yoy = asNumLocal(o.q1_fy26) ?? asNumLocal(o.yoy_qtr);
  const out: Record<string, unknown> = {
    current_qtr: isEps ? cur : (toInrCr(cur, rawUnit) ?? cur),
    yoy_qtr: isEps ? yoy : yoy != null ? (toInrCr(yoy, rawUnit) ?? yoy) : null,
    pct_change: asNumLocal(o.yoy_growth_pct) ?? asNumLocal(o.pct_change),
    unit: isEps ? "INR" : "INR cr",
  };
  if (o.change_bps != null) out.change_bps = o.change_bps;
  if (typeof o.note === "string") out.note = o.note;
  return out;
}

function mapTone(raw: unknown): string {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (/bullish|optimistic|strongly/.test(s)) return "bullish";
  if (/cautious|defensive|bearish/.test(s)) return "cautious";
  if (s) return "neutral";
  return "bullish";
}

/** Map investor-deck extract into the Concall PASS-list / UI schema. */
export function mapInvestorPresentationToConcallExtract(
  inv: InvestorPresentationExtract,
): Record<string, unknown> {
  const metaIn = asObj(inv.metadata) || {};
  const qKey =
    Object.keys(inv).find((k) => /^q\d_fy\d{2}_financials$/i.test(k)) ||
    "q1_fy27_financials";
  const qFin = asObj(inv[qKey]) || {};
  const cons = asObj(qFin.consolidated) || {};
  const stand = asObj(qFin.standalone) || {};
  const source = Object.keys(cons).length ? cons : stand;

  const revenue = deckMetric(source.revenue_from_operations);
  const ebitda = deckMetric(source.ebitda);
  const ebitdaMargin = deckMetric(source.ebitda_margin_pct);
  const netProfit = deckMetric(source.net_profit);
  const eps = deckMetric(source.eps);
  if (eps && (!eps.unit || eps.unit === "INR cr")) eps.unit = "INR";

  const sent = asObj(inv.sentiment_assessment) || {};
  const share = asObj(inv.shareholding_and_share_price) || {};
  const multi = asObj(inv.multi_year_consolidated_financials) || {};
  const cash = Array.isArray(multi.cash_flow) ? multi.cash_flow : [];
  const fy26Cash = cash.find((r) => asObj(r)?.fiscal_year === "FY26");
  const ocf = asNumLocal(asObj(fy26Cash)?.operating);

  const revYoy = asNumLocal(revenue?.pct_change);
  const ebitdaYoy = asNumLocal(ebitda?.pct_change);
  const marginBps = asNumLocal(ebitdaMargin?.change_bps);
  const patYoy = asNumLocal(netProfit?.pct_change);
  const highlights: Array<{ text: string; polarity: string }> = [];

  const opNotes = Array.isArray(qFin.operational_highlights)
    ? (qFin.operational_highlights as unknown[])
        .map((x) => String(x || "").replace(/\s+/g, " ").trim())
        .filter((t) => t.length >= 40)
    : [];

  if (revYoy != null) {
    highlights.push({
      text: `Revenue ${revYoy >= 0 ? "+" : ""}${revYoy.toFixed(1)}% YoY`,
      polarity: revYoy >= 0 ? "positive" : "negative",
    });
  } else if (asNumLocal(revenue?.current_qtr) != null) {
    const cur = asNumLocal(revenue?.current_qtr)!;
    const unit = String(revenue?.unit || "INR cr");
    const amt = formatInrCr(cur, unit) || `₹${cur} Cr`;
    highlights.push({
      text: `Revenue ${amt} (${String(metaIn.quarter || "Q")} ${String(metaIn.fiscal_year || "")})`.trim(),
      polarity: "neutral",
    });
  }
  if (ebitdaYoy != null) {
    highlights.push({
      text: `EBITDA ${ebitdaYoy >= 0 ? "+" : ""}${ebitdaYoy.toFixed(1)}% YoY`,
      polarity: ebitdaYoy >= 0 ? "positive" : "negative",
    });
  } else if (asNumLocal(ebitda?.current_qtr) != null && highlights.length < 3) {
    const cur = asNumLocal(ebitda?.current_qtr)!;
    const unit = String(ebitda?.unit || "INR cr");
    const amt = formatInrCr(cur, unit) || `₹${cur} Cr`;
    const m = asNumLocal(ebitdaMargin?.current_qtr);
    highlights.push({
      text: m != null ? `EBITDA ${amt} · margin ${m}%` : `EBITDA ${amt}`,
      polarity: "neutral",
    });
  }
  // Prefer an operational note over a 3rd YoY line when the deck provides one
  if (opNotes.length && highlights.length >= 2) {
    const note = opNotes[0];
    const clipped = note.length > 140 ? `${note.slice(0, 137)}…` : note;
    highlights.push({
      text: clipped,
      polarity: /lower|pressure|disrupted|decline|war|weak|cost/i.test(note)
        ? "negative"
        : /maintaining|growth|expansion|improve|value added/i.test(note)
          ? "positive"
          : "neutral",
    });
  } else {
    if (marginBps != null && highlights.length < 3) {
      highlights.push({
        text: `EBITDA margin ${marginBps >= 0 ? "+" : ""}${Math.round(marginBps)}bps`,
        polarity: marginBps >= 0 ? "positive" : "negative",
      });
    }
    if (patYoy != null && highlights.length < 3) {
      highlights.push({
        text: `PAT ${patYoy >= 0 ? "+" : ""}${patYoy.toFixed(1)}% YoY`,
        polarity: patYoy >= 0 ? "positive" : "negative",
      });
    } else if (
      asNumLocal(netProfit?.current_qtr) != null &&
      highlights.length < 3
    ) {
      const cur = asNumLocal(netProfit?.current_qtr)!;
      const unit = String(netProfit?.unit || "INR cr");
      const amt = formatInrCr(cur, unit) || `₹${cur} Cr`;
      highlights.push({
        text: `PAT ${amt}`,
        polarity: "neutral",
      });
    }
    for (const note of opNotes) {
      if (highlights.length >= 3) break;
      const clipped = note.length > 140 ? `${note.slice(0, 137)}…` : note;
      highlights.push({
        text: clipped,
        polarity: /lower|pressure|disrupted|decline|war|weak|cost/i.test(note)
          ? "negative"
          : "neutral",
      });
    }
  }
  if (ocf != null && ocf < 0 && highlights.length < 3) {
    highlights.push({
      text: `FY26 operating cash flow ₹${ocf.toFixed(0)} Cr`,
      polarity: "negative",
    });
  }
  while (highlights.length > 3) highlights.pop();

  let resultQuality = "Average";
  if (revYoy != null && revYoy >= 40) resultQuality = "Excellent";
  else if (revYoy != null && revYoy >= 15) resultQuality = "Strong";
  else if (revYoy != null && revYoy < 0) resultQuality = "Average";

  const toneRaw = sent.overall_tone;
  let tone = mapTone(toneRaw);
  if (
    (revYoy != null && revYoy < 0) ||
    (ebitdaYoy != null && ebitdaYoy < 0) ||
    opNotes.some((n) => /disrupted|pressure|lower sales|war/i.test(n))
  ) {
    tone = "cautious";
  }
  const mgmtSentiment =
    tone === "bullish" ? "bullish" : tone === "cautious" ? "cautious" : "neutral";

  const filing =
    typeof metaIn.filing_date === "string" ? metaIn.filing_date : null;

  return {
    metadata: {
      company_name: metaIn.company_name ?? null,
      nse_symbol: metaIn.nse_symbol ?? null,
      bse_code: metaIn.bse_code ?? null,
      call_date: filing,
      quarter: metaIn.quarter ?? null,
      fiscal_year: metaIn.fiscal_year ?? null,
      speakers: [],
      document_type: "Investor Presentation",
      isin: metaIn.isin ?? null,
      cin: metaIn.cin ?? null,
    },
    reported_financials: {
      ...(revenue ? { revenue } : {}),
      ...(ebitda ? { ebitda } : {}),
      ...(ebitdaMargin ? { ebitda_margin_pct: ebitdaMargin } : {}),
      ...(netProfit ? { net_profit: netProfit } : {}),
      ...(eps ? { eps } : {}),
    },
    forward_guidance: {
      revenue_guidance_range: null,
      margin_guidance: null,
      explicit_caveats: [],
      capex_guidance: [],
    },
    segment_data: [],
    corporate_actions: [],
    risk_governance_flags: {
      pledged_shares: null,
      debt_disclosed: [],
      related_party_transactions: [],
      deflected_or_vague_topics: Array.isArray(sent.watch_points)
        ? sent.watch_points.slice(0, 6)
        : [],
    },
    management_tone: {
      overall_tone: tone,
      justification:
        typeof sent.justification === "string" ? sent.justification : null,
      confidence_markers: {
        specific_commitments: [],
        hedged_language: [],
      },
      guidance_walkback: null,
      net_sentiment_score: asNumLocal(sent.net_sentiment_score),
      sentiment_rationale:
        typeof sent.sentiment_rationale === "string"
          ? sent.sentiment_rationale
          : null,
    },
    card: {
      result_quality: resultQuality,
      mgmt_sentiment: mgmtSentiment,
      highlights,
      sector: null,
      industry: null,
    },
    key_catalysts: (() => {
      const cats: Array<{ event: string; timeline: string }> = [];
      if (revYoy != null) {
        cats.push({
          event: `Consolidated revenue ${revYoy >= 0 ? "+" : ""}${revYoy.toFixed(1)}% YoY`,
          timeline: "Q1 FY27",
        });
      }
      if (ebitdaYoy != null) {
        cats.push({
          event: `Consolidated EBITDA ${ebitdaYoy >= 0 ? "+" : ""}${ebitdaYoy.toFixed(1)}% YoY`,
          timeline: "Q1 FY27",
        });
      }
      if (ocf != null && ocf < 0) {
        cats.push({
          event: `FY26 operating cash flow ₹${ocf.toFixed(1)} Cr (negative)`,
          timeline: "FY26",
        });
      }
      return cats;
    })(),
    shareholding_and_share_price: share,
    investor_presentation: inv,
  };
}

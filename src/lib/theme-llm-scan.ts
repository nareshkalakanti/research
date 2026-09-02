/**
 * Theme Scanner: LLM expands a natural-language search, we retrieve from
 * stocks + About (Yahoo / LLM / cleaned scrape), then the LLM keeps real matches.
 */
import { loadLlmConfig } from "./llm-config";
import { hasUsableAboutText, type CompanyRow } from "./db";
import { generateLlmAbout, saveLlmAbout } from "./llm-about";
import { checkLlmStatus, completeJson } from "./llm-client";
import { textHasTerm } from "./pattern";
import { loadPrompt } from "./prompts";
import { runConcurrent } from "./scrape-pool";
import {
  loadThemeSectorFilters,
  sectorGatePasses,
  type ThemeSectorFilter,
} from "./theme-match";

export type ThemeLlmHit = {
  ticker: string;
  why: string;
  score: number;
  terms: string[];
  source: "name" | "corpus" | "both";
};

export type ThemeLlmScanResult = {
  query: string;
  intent: string;
  include: string[];
  exclude: string[];
  scanPattern: string;
  hits: ThemeLlmHit[];
  engine: "llm" | "corpus";
  detail: string;
  judged: number;
  retrieved: number;
};

type Expansion = {
  intent: string;
  include: string[];
  exclude: string[];
  names: string[];
  tickers: string[];
};

type ScanCompany = Pick<
  CompanyRow,
  | "ticker"
  | "name"
  | "market"
  | "sector"
  | "sub_sector"
  | "about"
  | "scraped_about"
  | "scraped_about_clean"
  | "llm_about"
  | "search_text"
  | "theme_search_text"
  | "dossier_text"
  | "mcap_cr"
>;

type Scored = {
  company: ScanCompany;
  score: number;
  terms: string[];
  source: ThemeLlmHit["source"];
};

const CACHE_MS = 45 * 60 * 1000;
const CACHE_VER = "v13";
const MAX_CANDIDATES = 60;
const MAX_HITS = 50;
const JUDGE_BATCH = 22;

const ASK_STOP = new Set([
  "companies",
  "company",
  "shifting",
  "shifted",
  "shift",
  "moving",
  "move",
  "model",
  "into",
  "the",
  "and",
  "for",
  "of",
  "to",
  "a",
  "an",
  "in",
  "with",
  "from",
  "listed",
  "india",
  "indian",
]);

const GENERIC_TERMS = new Set([
  "api",
  "pharma",
  "pharmaceutical",
  "pharmaceuticals",
  "nuclear",
  "india",
  "indian",
  "listed",
  "company",
  "companies",
  "business",
  "services",
  "manufacturing",
]);

const cache = new Map<string, { at: number; result: ThemeLlmScanResult }>();

const EXPAND_FALLBACK = `Return ONLY JSON: {"intent":"","asks":[],"include":[],"exclude":[],"names":[],"tickers":[]}`;
const JUDGE_FALLBACK = `Return ONLY JSON: {"hits":[{"ticker":"","score":0,"why":""}]}`;

export function invalidateThemeLlmScanCache(): void {
  cache.clear();
}

export function normalizeThemeAsk(q: string): string {
  return q.trim().replace(/\s+/g, " ").slice(0, 180);
}

function cacheKey(
  ask: string,
  universeKey: string,
  includeKey = "",
): string {
  return `${CACHE_VER}::${universeKey}::${normalizeThemeAsk(ask).toLowerCase()}::${includeKey}`;
}

function corpusHasTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return textHasTerm(text, t.toLowerCase());
}

function uniqueTerms(items: string[], max: number, maxLen = 48): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const s = raw.trim().replace(/\s+/g, " ").slice(0, maxLen);
    if (s.length < 2) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function askTokens(ask: string): string[] {
  return ask
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !ASK_STOP.has(w.toLowerCase()));
}

function termWeight(term: string): number {
  const t = term.trim().toLowerCase();
  if (!t) return 0;
  if (GENERIC_TERMS.has(t)) return 5;
  if (t.split(/\s+/).length >= 2) return 22;
  if (t.length <= 3) return 8;
  return 14;
}

function isSpecificTerm(term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < 4) return false;
  return !GENERIC_TERMS.has(t);
}

function sectorFilterForAsk(ask: string): ThemeSectorFilter | undefined {
  const q = ask.trim().toLowerCase();
  const filters = loadThemeSectorFilters();
  if (/\b(cdmo|crdmo|crams|injectable|formulation)\b/.test(q)) {
    return filters.gov_pharma_api_cdmo_pli;
  }
  if (/\b(api|pharma)\b/.test(q) && !/\b(software|it services)\b/.test(q)) {
    return filters.gov_pharma_api_cdmo_pli;
  }
  return undefined;
}

function askSectorPasses(c: ScanCompany, ask: string): boolean {
  const filter = sectorFilterForAsk(ask);
  if (!filter) return true;
  const sector = c.sector?.trim();
  const sub = c.sub_sector?.trim();
  if (!sector && !sub) return true;
  return sectorGatePasses(c, filter);
}

function stringList(raw: unknown, max: number, maxLen = 48): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = String(item ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, maxLen);
    if (s.length < 2) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function foldName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(limited|ltd|pvt|private|plc|inc|corp|corporation|company|co|the|india|indian|industries|industrial)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scrapeSignal(c: ScanCompany): string {
  const clean = (c.scraped_about_clean ?? "").trim();
  if (clean.length >= 80) return clean;
  return "";
}

function corpusFor(c: ScanCompany): string {
  return [
    c.name,
    c.ticker,
    c.sector,
    c.sub_sector,
    c.theme_search_text,
    c.llm_about,
    c.about,
    scrapeSignal(c),
    c.scraped_about_clean,
  ]
    .filter(Boolean)
    .join("\n");
}

function snippetFor(c: ScanCompany, terms: string[]): string {
  const blocks = [
    c.llm_about,
    c.about,
    c.scraped_about_clean,
    scrapeSignal(c),
    c.theme_search_text,
  ]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 40);
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const withHit =
    blocks.find((b) =>
      lowerTerms.some((t) => b.toLowerCase().includes(t)),
    ) ||
    blocks[0] ||
    c.dossier_text ||
    "";
  const lower = withHit.toLowerCase();
  let start = 0;
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase());
    if (i >= 0) {
      start = Math.max(0, i - 60);
      break;
    }
  }
  return withHit.slice(start, start + 160).replace(/\s+/g, " ").trim();
}

function fallbackExpansion(ask: string): Expansion {
  return {
    intent: ask,
    include: uniqueTerms(askTokens(ask), 16),
    exclude: [],
    names: [],
    tickers: [],
  };
}

async function expandQuery(ask: string): Promise<Expansion> {
  const cfg = loadLlmConfig();
  const raw = await completeJson(
    cfg,
    loadPrompt("theme-scan-expand", EXPAND_FALLBACK),
    `User typed: ${ask}

Our About pages rarely use the user's exact phrase. Rewrite into:
- short include tokens that WOULD appear on messy India About/IR pages
- 10–20 listed names/tickers as retrieval hints (we still match against the database)
- exclude false friends

If this is a commodity or a business-model shift, include both operating jargon and adjacent product/customer tokens.`,
    { numPredict: 1100, maxTokens: 1100, temperature: 0.15 },
  );
  const shortAsks = stringList(raw.asks, 8, 64).filter(
    (s) => s.split(/\s+/).length <= 6,
  );
  const include = uniqueTerms(
    [...askTokens(ask), ...shortAsks, ...stringList(raw.include, 18)],
    24,
  );
  const names = stringList(raw.names, 24, 64);
  const tickers = stringList(raw.tickers, 24, 20)
    .map((t) => t.toUpperCase().replace(/[^A-Z0-9-]/g, ""))
    .filter((t) => t.length >= 2 && t.length <= 20);
  return {
    intent: String(raw.intent || ask)
      .trim()
      .slice(0, 140) || ask,
    include: include.length ? include : uniqueTerms(askTokens(ask), 16),
    exclude: stringList(raw.exclude, 10),
    names,
    tickers,
  };
}

function isPharmaListing(c: ScanCompany): boolean {
  return /pharma|healthcare|biotech|life\s*science|drug/i.test(
    `${c.sector ?? ""} ${c.sub_sector ?? ""} ${c.name}`,
  );
}

function nameHintPlausible(c: ScanCompany, ask: string): boolean {
  const q = ask.toLowerCase();
  if (/\b(cdmo|crdmo|crams|injectable|formulation|api|pharma)\b/.test(q)) {
    return isPharmaListing(c);
  }
  if (/\b(uranium|thorium|nuclear|npcil)\b/.test(q)) {
    return !/healthcare|pharma|hospital|diagnostic|insurance|jewel/i.test(
      `${c.sector ?? ""} ${c.sub_sector ?? ""} ${c.name}`,
    );
  }
  return true;
}

function nameHitsCompany(
  c: ScanCompany,
  names: string[],
  tickers: string[],
  ask: string,
): boolean {
  const t = c.ticker.toUpperCase();
  if (tickers.some((x) => x.toUpperCase() === t)) return true;
  const folded = foldName(c.name);
  if (!folded) return false;
  const foldedWords = new Set(folded.split(" ").filter(Boolean));
  for (const name of names) {
    const n = foldName(name);
    if (n.length < 4) continue;
    if (folded === n) return true;
    const first = n.split(" ")[0] ?? "";
    const multi = n.split(" ").length >= 2;
    if (first.length >= 4 && foldedWords.has(first)) {
      if (multi) return true;
      if (nameHintPlausible(c, ask)) return true;
      continue;
    }
    if (n.length >= 5 && (folded.includes(n) || n.includes(folded))) {
      if (nameHintPlausible(c, ask) || multi) return true;
    }
  }
  return false;
}

function hitTerms(text: string, terms: string[]): string[] {
  const out: string[] = [];
  for (const term of terms) {
    if (corpusHasTerm(text, term)) out.push(term);
  }
  return out;
}

function includeHitsCompany(c: ScanCompany, include: string[], ask: string): string[] {
  const themeSansName = (c.theme_search_text ?? "").replace(
    new RegExp(
      (c.name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") || "$^",
      "gi",
    ),
    " ",
  );
  const body = [
    c.sector,
    c.sub_sector,
    c.llm_about,
    c.about,
    c.scraped_about_clean,
    scrapeSignal(c),
    themeSansName,
  ]
    .filter(Boolean)
    .join("\n");
  const askSet = new Set(askTokens(ask).map((t) => t.toLowerCase()));
  const foldedName = new Set(foldName(c.name).split(" ").filter(Boolean));
  const out: string[] = [];
  for (const term of include) {
    const inBody = corpusHasTerm(body, term);
    const inName = corpusHasTerm(`${c.name} ${c.ticker}`, term);
    if (!inBody && !inName) continue;
    const t = term.trim().toLowerCase();
    const onlyBrand =
      !inBody &&
      inName &&
      foldedName.has(t) &&
      t.split(/\s+/).length < 2 &&
      t.length < 8 &&
      !askSet.has(t);
    if (onlyBrand) continue;
    out.push(term);
  }
  return out;
}

async function fillThinCandidateAbouts(cands: Scored[]): Promise<void> {
  const thin = cands
    .filter(
      (s) =>
        !hasUsableAboutText(s.company.about) &&
        !hasUsableAboutText(s.company.llm_about) &&
        !hasUsableAboutText(s.company.scraped_about_clean),
    )
    .slice(0, 8);
  if (!thin.length) return;
  await runConcurrent(thin, 2, async (s) => {
    try {
      const result = await generateLlmAbout({
        ticker: s.company.ticker,
        name: s.company.name,
        market: s.company.market,
        sector: s.company.sector,
        sub_sector: s.company.sub_sector,
        about: s.company.about,
        llmPreChecked: true,
      });
      if (!result.about) return;
      saveLlmAbout(s.company.ticker, result.about);
      s.company.llm_about = result.about;
      if (!s.company.about) s.company.about = result.about;
    } catch (err) {
      console.warn(
        "[theme-llm-scan] llm about",
        s.company.ticker,
        err instanceof Error ? err.message : err,
      );
    }
  });
}

function retrieveCandidates(
  universe: ScanCompany[],
  exp: Expansion,
  ask: string,
  opts?: { userTokens?: boolean },
): Scored[] {
  const include = exp.include.filter((t) => t.split(/\s+/).length <= 4);
  const exclude = exp.exclude;
  const scored: Scored[] = [];
  const userTokens = Boolean(opts?.userTokens);

  for (const c of universe) {
    if (!userTokens && !askSectorPasses(c, ask)) continue;
    const named = nameHitsCompany(c, exp.names, exp.tickers, ask);
    if (!userTokens && !named && !nameHintPlausible(c, ask)) continue;
    const text = corpusFor(c);
    const terms = includeHitsCompany(c, include, ask);
    const nameTerms = hitTerms(
      `${c.sector ?? ""} ${c.sub_sector ?? ""}`,
      include,
    );
    const bad = hitTerms(text, exclude);
    if (!named && !terms.length) continue;
    if (
      named &&
      !terms.length &&
      !nameHintPlausible(c, exp.intent || ask)
    ) {
      continue;
    }

    let score = 0;
    if (named) score += 120;
    for (const term of nameTerms) score += termWeight(term) * 2;
    for (const term of terms) score += termWeight(term);
    if (c.scraped_about_clean && hitTerms(c.scraped_about_clean, include).length) {
      score += 16;
    }
    score -= bad.length * 40;
    if (score <= 0 && !named) continue;

    scored.push({
      company: c,
      score,
      terms: [...new Set([...nameTerms, ...terms])].slice(0, 6),
      source: named && terms.length ? "both" : named ? "name" : "corpus",
    });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.company.ticker.localeCompare(b.company.ticker),
  );
  return scored.slice(0, MAX_CANDIDATES);
}

function cardLine(c: ScanCompany, terms: string[], source: ThemeLlmHit["source"]): string {
  const mcap =
    c.mcap_cr != null && Number.isFinite(c.mcap_cr)
      ? ` · ₹${Math.round(c.mcap_cr)} Cr`
      : "";
  const sector = [c.sector, c.sub_sector].filter(Boolean).join(" / ") || "unclassified";
  const snip = snippetFor(c, terms);
  const via = source === "name" ? "named" : source === "both" ? "named+corpus" : "corpus";
  return `${c.ticker} | ${c.name} | ${sector}${mcap} | ${via}\n${snip || "No about text"}`;
}

function corpusHits(candidates: Scored[], intent: string): ThemeLlmHit[] {
  return candidates.slice(0, MAX_HITS).map((c) => ({
    ticker: c.company.ticker.toUpperCase(),
    why: c.terms.length
      ? `Corpus match: ${c.terms.slice(0, 3).join(", ")}`
      : intent,
    score: Math.min(9, Math.max(6, Math.round(c.score / 20))),
    terms: c.terms,
    source: c.source,
  }));
}

async function judgeBatch(
  ask: string,
  exp: Expansion,
  batch: Scored[],
): Promise<{ keeps: ThemeLlmHit[]; dropped: Set<string> }> {
  const byTicker = new Map(
    batch.map((c) => [c.company.ticker.toUpperCase(), c]),
  );
  const cards = batch
    .map((c) => cardLine(c.company, c.terms, c.source))
    .join("\n\n");
  const cfg = loadLlmConfig();
  const raw = await completeJson(
    cfg,
    loadPrompt("theme-scan-judge", JUDGE_FALLBACK),
    `Search: ${ask}\nIntent: ${exp.intent}\nInclude: ${exp.include.join(", ")}\nExclude: ${exp.exclude.join(", ") || "none"}\n\nCandidates:\n${cards}`,
    {
      numPredict: 1000,
      maxTokens: 1000,
      temperature: 0.08,
      skipStatusCheck: true,
    },
  );
  const rows = Array.isArray(raw.hits) ? raw.hits : [];
  const keeps: ThemeLlmHit[] = [];
  const dropped = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const ticker = String(rec.ticker || "")
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "");
    const cand = byTicker.get(ticker);
    if (!cand || seen.has(ticker)) continue;
    seen.add(ticker);
    const score = Number(rec.score);
    if (!Number.isFinite(score) || score < 6) {
      dropped.add(ticker);
      continue;
    }
    keeps.push({
      ticker,
      why: String(rec.why || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 140) ||
        (cand.terms.length
          ? `Matches ${cand.terms.slice(0, 3).join(", ")}`
          : exp.intent),
      score: Math.max(6, Math.min(10, Math.round(score))),
      terms: cand.terms,
      source: cand.source,
    });
  }
  return { keeps, dropped };
}

async function judgeCandidates(
  ask: string,
  exp: Expansion,
  candidates: Scored[],
): Promise<{ keeps: ThemeLlmHit[]; dropped: Set<string> }> {
  const slice = candidates.slice(0, 44);
  const keeps: ThemeLlmHit[] = [];
  const dropped = new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < slice.length; i += JUDGE_BATCH) {
    const batch = slice.slice(i, i + JUDGE_BATCH);
    const part = await judgeBatch(ask, exp, batch);
    for (const t of part.dropped) dropped.add(t);
    for (const h of part.keeps) {
      if (seen.has(h.ticker)) continue;
      seen.add(h.ticker);
      keeps.push(h);
    }
  }
  keeps.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  return { keeps, dropped };
}

function fillOmittedHits(
  keeps: ThemeLlmHit[],
  dropped: Set<string>,
  candidates: Scored[],
  ask: string,
  exp: Expansion,
): ThemeLlmHit[] {
  const byTicker = new Map(keeps.map((h) => [h.ticker, h]));
  const candByTicker = new Map(
    candidates.map((c) => [c.company.ticker.toUpperCase(), c]),
  );
  const strong = new Set(
    uniqueTerms([...exp.include, ...askTokens(ask)], 20)
      .filter(isSpecificTerm)
      .map((s) => s.toLowerCase()),
  );
  for (const t of [...byTicker.keys()]) {
    const cand = candByTicker.get(t);
    if (!cand || !askSectorPasses(cand.company, ask)) {
      byTicker.delete(t);
      continue;
    }
    if (cand.terms.length) continue;
    if (!nameHintPlausible(cand.company, ask)) byTicker.delete(t);
  }
  for (const c of candidates) {
    if (!askSectorPasses(c.company, ask)) continue;
    const t = c.company.ticker.toUpperCase();
    if (byTicker.has(t) || dropped.has(t)) continue;
    const queryHit = c.terms.some((term) => strong.has(term.toLowerCase()));
    if (!queryHit) continue;
    if (c.source === "name" && !nameHintPlausible(c.company, ask)) continue;
    byTicker.set(t, {
      ticker: t,
      why: c.terms.length
        ? `Matches ${c.terms.slice(0, 3).join(", ")}`
        : exp.intent,
      score: c.source === "name" || c.source === "both" ? 7 : 6,
      terms: c.terms,
      source: c.source,
    });
  }
  return [...byTicker.values()]
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker))
    .slice(0, MAX_HITS);
}

export async function runThemeLlmScan(
  askRaw: string,
  universe: ScanCompany[],
  opts?: { universeKey?: string; refresh?: boolean; include?: string[] },
): Promise<ThemeLlmScanResult> {
  const ask = normalizeThemeAsk(askRaw);
  if (ask.length < 2) {
    throw new Error("Type a search (products, niche, or end market)");
  }
  const includeOverride = uniqueTerms(opts?.include ?? [], 24);
  const includeKey = includeOverride.map((t) => t.toLowerCase()).join("|");
  const key = cacheKey(
    ask,
    opts?.universeKey || String(universe.length),
    includeKey,
  );
  if (!opts?.refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  }

  const userTokens = includeOverride.length > 0;
  let expansion: Expansion;
  let statusDetail = "";

  if (userTokens) {
    expansion = {
      intent: ask,
      include: includeOverride,
      exclude: [],
      names: [],
      tickers: [],
    };
    statusDetail = "Your tokens";
  } else {
    const cfg = loadLlmConfig();
    const status = await checkLlmStatus(cfg);
    if (!status.available) {
      throw new Error(status.hint || status.detail || "LLM unavailable");
    }
    statusDetail = status.detail;
    try {
      expansion = await expandQuery(ask);
    } catch (err) {
      expansion = fallbackExpansion(ask);
      console.warn("[theme-llm-scan] expand failed, using query terms:", err);
    }
  }

  let candidates = retrieveCandidates(universe, expansion, ask, { userTokens });
  if (!candidates.length && userTokens) {
    candidates = retrieveCandidates(universe, fallbackExpansion(ask), ask, {
      userTokens: true,
    });
    if (candidates.length) {
      statusDetail = `${statusDetail} · search terms`;
    }
  }
  if (!userTokens && candidates.length) {
    await fillThinCandidateAbouts(candidates);
  }
  let hits: ThemeLlmHit[] = [];
  let engine: ThemeLlmScanResult["engine"] = userTokens ? "corpus" : "llm";
  let detail = statusDetail;

  if (!candidates.length) {
    hits = [];
    detail = "No companies in the stocks/scrape corpus matched this search";
  } else if (userTokens) {
    hits = corpusHits(candidates, expansion.intent);
    detail = `${statusDetail} · corpus match`;
  } else {
    try {
      const judged = await judgeCandidates(ask, expansion, candidates);
      hits = fillOmittedHits(
        judged.keeps,
        judged.dropped,
        candidates,
        ask,
        expansion,
      );
      if (!hits.length) {
        hits = corpusHits(candidates, expansion.intent);
        engine = "corpus";
        detail = "LLM returned no keeps — showing corpus matches";
      } else if (hits.length > judged.keeps.length) {
        detail = `${statusDetail} · filled ${hits.length - judged.keeps.length} corpus matches the model skipped`;
      }
    } catch (err) {
      hits = corpusHits(candidates, expansion.intent);
      engine = "corpus";
      detail =
        err instanceof Error
          ? `LLM rank unavailable (${err.message.slice(0, 80)}) — corpus matches`
          : "LLM rank unavailable — corpus matches";
    }
  }

  const result: ThemeLlmScanResult = {
    query: ask,
    intent: expansion.intent,
    include: expansion.include,
    exclude: expansion.exclude,
    scanPattern: [expansion.intent, ...expansion.include]
      .filter(Boolean)
      .join(" · "),
    hits,
    engine,
    detail,
    judged: candidates.length,
    retrieved: candidates.length,
  };
  cache.set(key, { at: Date.now(), result });
  return result;
}

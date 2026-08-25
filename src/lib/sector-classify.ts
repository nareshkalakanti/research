import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { loadAgentConfig } from "./agents/config";
import { pickAboutText } from "./db";

const CLASS_PATH = path.join(process.cwd(), "data", "classifications.db");

export type SectorPair = {
  sector: string;
  sub_sector: string;
  count: number;
};

export type SectorClassifyInput = {
  ticker: string;
  name: string;
  market: string;
  about?: string | null;
  scraped_about?: string | null;
  yf_about?: string | null;
};

export type SectorClassifyResult = {
  sector: string;
  sub_sector: string;
  source: "llm" | "heuristic";
  confidence: "high" | "medium" | "low";
};

let taxonomyCache: SectorPair[] | null = null;

export function loadSectorTaxonomy(): SectorPair[] {
  if (taxonomyCache) return taxonomyCache;
  if (!fs.existsSync(CLASS_PATH)) {
    taxonomyCache = [];
    return taxonomyCache;
  }
  const db = new Database(CLASS_PATH, { readonly: true });
  try {
    taxonomyCache = db
      .prepare(
        `SELECT TRIM(sector) AS sector, TRIM(sub_sector) AS sub_sector, COUNT(*) AS count
         FROM classifications
         WHERE TRIM(COALESCE(sector, '')) != ''
           AND TRIM(COALESCE(sub_sector, '')) != ''
         GROUP BY sector, sub_sector
         ORDER BY count DESC`,
      )
      .all() as SectorPair[];
    return taxonomyCache;
  } finally {
    db.close();
  }
}

export function classificationCorpus(c: SectorClassifyInput): string {
  const picked = pickAboutText({
    about: c.about ?? null,
    yf_about: c.yf_about ?? null,
    scraped_about: c.scraped_about ?? null,
  });
  const manual = (c.about ?? "").trim();
  const scraped = (c.scraped_about ?? "").trim();

  // Prefer long Yahoo/manual about; ignore short generic scrape blurbs that disagree.
  if (manual.length >= 120) {
    return [c.name, manual].filter(Boolean).join("\n\n").slice(0, 4000);
  }
  if (picked && picked.length >= 80) {
    const parts = [c.name, picked];
    if (
      scraped &&
      scraped.length >= 80 &&
      scraped.length > picked.length * 0.35
    ) {
      parts.push(scraped);
    }
    return parts.join("\n\n").slice(0, 4000);
  }
  return [c.name, picked, scraped].filter(Boolean).join("\n\n").slice(0, 4000);
}

const KEYWORD_BOOSTS: Array<{
  re: RegExp;
  sector: string;
  sub_sector?: string;
  score: number;
}> = [
  {
    re: /\b(led|lighting|luminair|luminaire|strip light|linear light|oem.*light)\b/i,
    sector: "Consumer Durables",
    sub_sector: "Home Electronics & Appliances",
    score: 14,
  },
  {
    re: /\b(manufactur.*light|lighting solution|flexible led|architectural light)\b/i,
    sector: "Consumer Durables",
    sub_sector: "Home Electronics & Appliances",
    score: 16,
  },
  {
    re: /\b(led|lighting|electrical component|switchgear|wire|cable)\b/i,
    sector: "Engineering & Capital Goods",
    sub_sector: "Electrical Components & Equipments",
    score: 8,
  },
  {
    re: /\b(pharma|pharmaceutical|formulation|api\b|drug|medicine)\b/i,
    sector: "Pharmaceuticals & Healthcare",
    sub_sector: "Pharmaceuticals",
    score: 10,
  },
  {
    re: /\b(hospital|healthcare|diagnostic|clinic)\b/i,
    sector: "Pharmaceuticals & Healthcare",
    sub_sector: "Hospitals & Diagnostic Centres",
    score: 10,
  },
  {
    re: /\b(software|it services|digital transformation|technology consulting)\b/i,
    sector: "IT & Technology",
    sub_sector: "IT Services & Consulting",
    score: 10,
  },
  {
    re: /\b(bank|nbfc|lending|finance|insurance)\b/i,
    sector: "Banking & Finance",
    score: 6,
  },
  {
    re: /\b(steel|iron|metal|alumin|copper|mining)\b/i,
    sector: "Metals & Mining",
    score: 6,
  },
  {
    re: /\b(textile|garment|fabric|apparel)\b/i,
    sector: "Textiles & Apparel",
    score: 8,
  },
  {
    re: /\b(real estate|construction|epc|infrastructure project)\b/i,
    sector: "Real Estate & Construction",
    sub_sector: "Construction & Engineering",
    score: 8,
  },
];

function findPair(
  taxonomy: SectorPair[],
  sector: string,
  sub_sector?: string,
): SectorPair | null {
  const s = sector.trim().toLowerCase();
  const sub = sub_sector?.trim().toLowerCase();
  const hit = taxonomy.find(
    (p) =>
      p.sector.toLowerCase() === s &&
      (!sub || p.sub_sector.toLowerCase() === sub),
  );
  if (hit) return hit;
  return taxonomy.find((p) => p.sector.toLowerCase() === s) ?? null;
}

export function heuristicClassifySector(
  corpus: string,
  taxonomy: SectorPair[] = loadSectorTaxonomy(),
): SectorClassifyResult | null {
  if (!corpus.trim() || !taxonomy.length) return null;
  const lower = corpus.toLowerCase();

  const scores = new Map<string, number>();
  for (const p of taxonomy) {
    const key = `${p.sector}\0${p.sub_sector}`;
    let score = 0;
    for (const word of p.sub_sector.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 4 && lower.includes(word)) score += 4;
    }
    for (const word of p.sector.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 4 && lower.includes(word)) score += 2;
    }
    if (score > 0) scores.set(key, score);
  }

  for (const boost of KEYWORD_BOOSTS) {
    if (!boost.re.test(corpus)) continue;
    const pair =
      findPair(taxonomy, boost.sector, boost.sub_sector) ??
      findPair(taxonomy, boost.sector);
    if (!pair) continue;
    const key = `${pair.sector}\0${pair.sub_sector}`;
    scores.set(key, (scores.get(key) ?? 0) + boost.score);
  }

  let bestKey = "";
  let best = 0;
  for (const [key, score] of scores) {
    if (score > best) {
      best = score;
      bestKey = key;
    }
  }
  if (!bestKey || best < 5) return null;

  const [sector, sub_sector] = bestKey.split("\0");
  return {
    sector: sector!,
    sub_sector: sub_sector!,
    source: "heuristic",
    confidence: best >= 12 ? "high" : best >= 8 ? "medium" : "low",
  };
}

async function callOpenAiClassify(
  corpus: string,
  taxonomy: SectorPair[],
): Promise<SectorClassifyResult | null> {
  const cfg = loadAgentConfig();
  if (!cfg.openaiApiKey) return null;

  const options = taxonomy.slice(0, 120).map((p) => ({
    sector: p.sector,
    sub_sector: p.sub_sector,
  }));

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.llmModel.includes("gpt") ? cfg.llmModel : "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Classify Indian listed companies into sector and sub_sector. Return ONLY JSON: {\"sector\":\"...\",\"sub_sector\":\"...\",\"confidence\":\"high|medium|low\"}. Pick EXACT strings from the provided taxonomy list.",
        },
        {
          role: "user",
          content: JSON.stringify({ company: corpus, taxonomy: options }),
        },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = json.choices?.[0]?.message?.content?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      sector?: string;
      sub_sector?: string;
      confidence?: string;
    };
    const pair = findPair(
      taxonomy,
      parsed.sector ?? "",
      parsed.sub_sector ?? "",
    );
    if (!pair) return null;
    return {
      sector: pair.sector,
      sub_sector: pair.sub_sector,
      source: "llm",
      confidence:
        parsed.confidence === "high" || parsed.confidence === "medium"
          ? parsed.confidence
          : "low",
    };
  } catch {
    return null;
  }
}

async function callAnthropicClassify(
  corpus: string,
  taxonomy: SectorPair[],
): Promise<SectorClassifyResult | null> {
  const cfg = loadAgentConfig();
  if (!cfg.anthropicApiKey) return null;

  const options = taxonomy.slice(0, 120).map((p) => ({
    sector: p.sector,
    sub_sector: p.sub_sector,
  }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.llmModel.includes("claude") ? cfg.llmModel : "claude-haiku-4-5",
      max_tokens: 300,
      system:
        "Classify Indian listed companies. Return ONLY JSON: {\"sector\":\"...\",\"sub_sector\":\"...\",\"confidence\":\"high|medium|low\"}. Use EXACT sector/sub_sector strings from taxonomy.",
      messages: [
        {
          role: "user",
          content: JSON.stringify({ company: corpus, taxonomy: options }),
        },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const raw = json.content?.find((c) => c.type === "text")?.text?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      sector?: string;
      sub_sector?: string;
      confidence?: string;
    };
    const pair = findPair(
      taxonomy,
      parsed.sector ?? "",
      parsed.sub_sector ?? "",
    );
    if (!pair) return null;
    return {
      sector: pair.sector,
      sub_sector: pair.sub_sector,
      source: "llm",
      confidence:
        parsed.confidence === "high" || parsed.confidence === "medium"
          ? parsed.confidence
          : "low",
    };
  } catch {
    return null;
  }
}

export async function classifySectorAI(
  input: SectorClassifyInput,
): Promise<SectorClassifyResult | null> {
  const corpus = classificationCorpus(input);
  if (!corpus.trim()) return null;

  const taxonomy = loadSectorTaxonomy();
  const cfg = loadAgentConfig();

  if (cfg.openaiApiKey && cfg.llmProvider !== "anthropic") {
    const llm = await callOpenAiClassify(corpus, taxonomy);
    if (llm) return llm;
  }
  if (cfg.anthropicApiKey) {
    const llm = await callAnthropicClassify(corpus, taxonomy);
    if (llm) return llm;
  }

  return heuristicClassifySector(corpus, taxonomy);
}

export function listSectorGapTickers(): Array<{
  ticker: string;
  market: string;
}> {
  if (!fs.existsSync(CLASS_PATH)) return [];
  const db = new Database(CLASS_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT UPPER(ticker) AS ticker, market
         FROM classifications
         WHERE TRIM(COALESCE(sector, '')) = ''
            OR TRIM(COALESCE(sub_sector, '')) = ''`,
      )
      .all() as Array<{ ticker: string; market: string }>;
  } finally {
    db.close();
  }
}

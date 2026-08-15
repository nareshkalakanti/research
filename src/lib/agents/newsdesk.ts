/**
 * Quant Newsdesk — Yahoo headlines for TQ/BB hits (not stocks-ai).
 * Server-only: do not import this file from client components.
 */
import YahooFinance from "yahoo-finance2";
import { headlineMatchesCompany } from "@/lib/hidden-portfolio/news_scanner";
import { yfSymbolCandidates } from "@/lib/yfinance";
import type {
  NewsTone,
  QuantHeadline,
  QuantNewsCompany,
  QuantNewsCompanyIn,
  QuantNewsdeskResult,
} from "./newsdesk-types";

export {
  QUANT_NEWS_LIMIT,
  type NewsTone,
  type QuantHeadline,
  type QuantNewsCompany,
  type QuantNewsCompanyIn,
  type QuantNewsdeskResult,
} from "./newsdesk-types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

function toneFromTitle(text: string): NewsTone {
  const t = text.toLowerCase();
  const pos = [
    "surge",
    "gain",
    "beat",
    "upgrade",
    "record",
    "growth",
    "win",
    "strong",
    "profit",
    "expansion",
    "order",
    "contract",
  ];
  const neg = [
    "fall",
    "drop",
    "miss",
    "downgrade",
    "loss",
    "weak",
    "cut",
    "decline",
    "probe",
    "fine",
    "fraud",
    "sebi",
  ];
  let s = 0;
  for (const w of pos) if (t.includes(w)) s += 1;
  for (const w of neg) if (t.includes(w)) s -= 1;
  if (s > 0) return "pos";
  if (s < 0) return "neg";
  return "neu";
}

async function fetchYahooHeadlines(
  ticker: string,
  name: string,
  market?: string | null,
): Promise<QuantHeadline[]> {
  const queries = [
    ticker.toUpperCase(),
    ...yfSymbolCandidates(ticker, market).slice(0, 2),
  ];
  const tried = new Set<string>();
  const seen = new Set<string>();
  const out: QuantHeadline[] = [];

  for (const q of queries) {
    if (!q || tried.has(q)) continue;
    tried.add(q);
    try {
      const search = await yf.search(q, { newsCount: 8 });
      for (const item of search.news ?? []) {
        const title = String(item.title || "").trim();
        if (!title) continue;
        if (!headlineMatchesCompany(title, name, ticker)) continue;
        const link = String(item.link || item.uuid || "").trim();
        const key = `${title.toLowerCase()}|${link}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          title,
          link,
          published: item.providerPublishTime
            ? new Date(Number(item.providerPublishTime) * 1000)
                .toISOString()
                .slice(0, 10)
            : null,
          tone: toneFromTitle(title),
        });
      }
    } catch {
      /* next query */
    }
    if (out.length >= 6) break;
  }

  return out.slice(0, 6);
}

export async function fetchQuantNewsdesk(
  companies: QuantNewsCompanyIn[],
  opts?: { concurrency?: number; delayMs?: number; limit?: number },
): Promise<QuantNewsdeskResult> {
  const limit = Math.max(1, opts?.limit ?? QUANT_NEWS_LIMIT);
  const want = companies
    .map((c) => ({
      ticker: (c.ticker || "").trim().toUpperCase(),
      name: (c.name || c.ticker || "").trim(),
      market: (c.market || "").trim(),
      has_tq: Boolean(c.has_tq),
      has_bb: Boolean(c.has_bb),
    }))
    .filter((c) => c.ticker);

  const uniq = new Map<string, (typeof want)[number]>();
  for (const c of want) {
    const have = uniq.get(c.ticker);
    if (!have) {
      uniq.set(c.ticker, c);
      continue;
    }
    have.has_tq = have.has_tq || c.has_tq;
    have.has_bb = have.has_bb || c.has_bb;
  }
  const batch = [...uniq.values()].slice(0, limit);

  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const delayMs = opts?.delayMs ?? 80;
  const rows: QuantNewsCompany[] = new Array(batch.length);
  let next = 0;

  async function worker() {
    while (next < batch.length) {
      const i = next++;
      const c = batch[i]!;
      const headlines = await fetchYahooHeadlines(c.ticker, c.name, c.market);
      let positive = 0;
      let negative = 0;
      let neutral = 0;
      for (const h of headlines) {
        if (h.tone === "pos") positive += 1;
        else if (h.tone === "neg") negative += 1;
        else neutral += 1;
      }
      rows[i] = {
        ...c,
        headlines,
        positive,
        negative,
        neutral,
      };
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const companiesOut = rows.filter(Boolean);
  let headlines = 0;
  let netTone = 0;
  for (const c of companiesOut) {
    headlines += c.headlines.length;
    netTone += c.positive - c.negative;
  }

  companiesOut.sort((a, b) => {
    const na = b.headlines.length - a.headlines.length;
    if (na !== 0) return na;
    return a.ticker.localeCompare(b.ticker);
  });

  return { companies: companiesOut, headlines, netTone };
}

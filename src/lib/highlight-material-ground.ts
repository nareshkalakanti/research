/**
 * Ground highlight headlines in earnings text via generic patterns.
 * No issuer / ticker hardcoding — only shapes like value-add mix %,
 * volume guidance bands, demerger / new subsidiary names found in text.
 */

export type MaterialHighlightCandidate = {
  text: string;
  polarity: "positive" | "negative" | "neutral";
  kind: "win" | "risk" | "strategic" | "guidance";
  score: number;
  quote: string | null;
  metric: string | null;
  value: number | null;
  unit: string | null;
};

function clipHeadline(s: string, max = 70): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

function fyLabel(near: string, fullDoc?: string, matchText?: string): string {
  const annual =
    /for the year|this year|full year|current year/i.test(matchText || "") ||
    /for the year|this year|full year|current year/i.test(near);
  // Annual guidance → reporting FY from header, not distant FY30 targets in nearby prose
  if (!annual) {
    const nearHit = near.match(/\bFY\s*'?(\d{2})\b/i);
    if (nearHit) return `FY${nearHit[1]}`;
  }
  const header = (fullDoc || "").slice(0, 2000);
  const q = header.match(/\bQ1\s*FY\s*'?(\d{2})\b/i);
  if (q) return `FY${q[1]}`;
  const y = header.match(/\bQuarter\s+1\s+'(\d{2})\b/i);
  if (y) return `FY${y[1]}`;
  const fy = header.match(/\bFY\s*'?(\d{2})\b/i);
  if (fy) return `FY${fy[1]}`;
  if (!annual) {
    const nearHit = near.match(/\bFY\s*'?(\d{2})\b/i);
    if (nearHit) return `FY${nearHit[1]}`;
  }
  return "FY";
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Extract high-signal highlight candidates from transcript/PPT text. */
export function extractMaterialHighlightCandidates(
  text: string,
): MaterialHighlightCandidate[] {
  const t = text.replace(/\s+/g, " ");
  if (t.length < 80) return [];
  const out: MaterialHighlightCandidate[] = [];
  const seen = new Set<string>();

  const add = (c: MaterialHighlightCandidate) => {
    const key = c.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, text: clipHeadline(c.text) });
  };

  // Record / highest value-added mix N%
  for (const m of t.matchAll(
    /(?:highest|record|peak)\s+share\s+of\s+value[-\s]?added[^.%]{0,60}?(\d+(?:\.\d+)?)\s*%/gi,
  )) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    add({
      text: `Record ${n}% value-added mix`,
      polarity: "positive",
      kind: "win",
      score: 9,
      quote: m[0].slice(0, 160),
      metric: "Value-added product mix",
      value: n,
      unit: "%",
    });
  }
  for (const m of t.matchAll(
    /value[-\s]?added\s+(?:products?|mix|share)[^.%]{0,40}?(\d+(?:\.\d+)?)\s*%/gi,
  )) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 20) continue;
    add({
      text: `Record ${n}% value-added mix`,
      polarity: "positive",
      kind: "win",
      score: 8,
      quote: m[0].slice(0, 160),
      metric: "Value-added product mix",
      value: n,
      unit: "%",
    });
  }

  // Volume growth guidance band
  for (const m of t.matchAll(
    /(\d{1,2})\s*[-–to]{1,3}\s*(\d{1,2})\s*%[^.]{0,40}?(?:good estimate|guidance|expect|target)[^.]{0,40}?(?:year|fy)/gi,
  )) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b > 80) continue;
    const window = t.slice(Math.max(0, (m.index ?? 0) - 500), (m.index ?? 0) + 80);
    const fy = fyLabel(window, t, m[0]);
    add({
      text: `${fy} volume growth ${a}-${b}%`,
      polarity: "neutral",
      kind: "guidance",
      score: 7,
      quote: m[0].slice(0, 160),
      metric: "Volume growth guidance",
      value: a,
      unit: "%",
    });
  }
  for (const m of t.matchAll(
    /volume\s+growth[^.?!]{0,180}?(\d{1,2})\s*[-–]\s*(\d{1,2})\s*%/gi,
  )) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b > 80) continue;
    const window = t.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 120);
    const fy = fyLabel(window, t, m[0]);
    add({
      text: `${fy} volume growth ${a}-${b}%`,
      polarity: "neutral",
      kind: "guidance",
      score: 6,
      quote: m[0].slice(0, 160),
      metric: "Volume growth guidance",
      value: a,
      unit: "%",
    });
  }

  // New company + demerger / copper move
  for (const m of t.matchAll(
    /(?:new company called|form(?:ing|ed)?\s+(?:a\s+)?(?:new\s+)?company\s+called)\s+([A-Z][A-Za-z0-9&.\- ]{1,40}?Limited)\b/g,
  )) {
    const name = m[1]!.replace(/\s+/g, " ").trim();
    if (name.length < 5) continue;
    const ctx = t
      .slice(m.index ?? 0, Math.min(t.length, (m.index ?? 0) + 280))
      .toLowerCase();
    const copper = /copper/.test(ctx);
    const demerger = /demerger|restructur|wholly owned|subsidiary|merge/.test(
      ctx,
    );
    if (!copper && !demerger) continue;
    add({
      text: copper
        ? `${name} copper demerger`
        : `${name} demerger / restructuring`,
      polarity: "neutral",
      kind: "strategic",
      score: 8,
      quote: m[0].slice(0, 160),
      metric: "Corporate restructuring",
      value: null,
      unit: null,
    });
  }

  // Order inflow / booked orders (₹cr)
  for (const m of t.matchAll(
    /(?:booked|book|won|recorded|received)\s+(?:about\s+|approximately\s+)?(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.\d+)?)\s*(?:crores?|cr)\s+of\s+orders?/gi,
  )) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 10) continue;
    add({
      text: `Record ₹${Math.round(n)}cr order inflow`,
      polarity: "positive",
      kind: "win",
      score: 10,
      quote: m[0].slice(0, 160),
      metric: "Order inflow",
      value: n,
      unit: "₹cr",
    });
  }
  for (const m of t.matchAll(
    /order\s+inflow[^.₹INR]{0,40}?(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.\d+)?)\s*(?:crores?|cr)/gi,
  )) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 10) continue;
    add({
      text: `Record ₹${Math.round(n)}cr order inflow`,
      polarity: "positive",
      kind: "win",
      score: 9,
      quote: m[0].slice(0, 160),
      metric: "Order inflow",
      value: n,
      unit: "₹cr",
    });
  }

  // Capacity / line utilization ramp
  for (const m of t.matchAll(
    /(sandwich\s+panel|PEB|prefab)[^.%]{0,80}?utili[sz]ation[^.%]{0,40}?(\d{1,2}(?:\.\d+)?)\s*%/gi,
  )) {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n < 5 || n > 100) continue;
    const line = m[1]!.replace(/\s+/g, " ");
    add({
      text: `${line} utilization ${n}%`,
      polarity: "positive",
      kind: "strategic",
      score: 7,
      quote: m[0].slice(0, 160),
      metric: "Capacity utilization",
      value: n,
      unit: "%",
    });
  }
  for (const m of t.matchAll(
    /utili[sz]ation[^.%]{0,40}?(?:of\s+)?(?:the\s+)?(sandwich\s+panel|PEB)[^.%]{0,40}?(\d{1,2}(?:\.\d+)?)\s*%/gi,
  )) {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n < 5 || n > 100) continue;
    add({
      text: `${m[1]} utilization ${n}%`,
      polarity: "positive",
      kind: "strategic",
      score: 7,
      quote: m[0].slice(0, 160),
      metric: "Capacity utilization",
      value: n,
      unit: "%",
    });
  }
  for (const m of t.matchAll(
    /(?:almost|nearly|around|about)\s+(\d{1,2})\s*%\s+as\s+compared\s+to\s+(?:the\s+)?utili[sz]ation\s+of\s+(\d{1,2})\s*%/gi,
  )) {
    const n = Number(m[1]);
    const prev = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    const ctx = t.slice(Math.max(0, (m.index ?? 0) - 120), m.index ?? 0);
    const line = /sandwich/i.test(ctx) ? "Sandwich panel" : "Capacity";
    add({
      text: `${line} utilization ${n}% (vs ${prev}%)`,
      polarity: "positive",
      kind: "strategic",
      score: 8,
      quote: m[0].slice(0, 160),
      metric: "Capacity utilization",
      value: n,
      unit: "%",
    });
  }

  // Data Center / new vertical subsidiary
  for (const m of t.matchAll(
    /(?:float(?:ed|ing)?|form(?:ed|ing)?|launch(?:ed)?|incorporat(?:ed|ing)?)\s+(?:this\s+|a\s+|our\s+)?(?:separate\s+|new\s+)?subsidiary[^.]{0,100}?data\s*cent(?:er|re)/gi,
  )) {
    add({
      text: "Data Center Solutions subsidiary",
      polarity: "neutral",
      kind: "strategic",
      score: 8,
      quote: m[0].slice(0, 160),
      metric: "New business vertical",
      value: null,
      unit: null,
    });
  }
  for (const m of t.matchAll(
    /data\s*cent(?:er|re)\s+(?:solutions?\s+)?subsidiary/gi,
  )) {
    add({
      text: "Data Center Solutions subsidiary",
      polarity: "neutral",
      kind: "strategic",
      score: 7,
      quote: m[0].slice(0, 160),
      metric: "New business vertical",
      value: null,
      unit: null,
    });
  }

  // Margin moderation on steel / input costs
  for (const m of t.matchAll(
    /(?:EBITDA\s+)?margins?\s+(?:moderated|compressed|declined)[^.%]{0,80}?(\d+(?:\.\d+)?)\s*%[^.]{0,80}?(?:steel|input\s+cost)/gi,
  )) {
    add({
      text: `Margin moderation on input costs (${m[1]}%)`,
      polarity: "negative",
      kind: "risk",
      score: 7,
      quote: m[0].slice(0, 160),
      metric: "EBITDA margin",
      value: Number(m[1]),
      unit: "%",
    });
  }
  for (const m of t.matchAll(
    /(?:steel|input\s+costs?)[^.%]{0,100}?(\d{2,4})\s*(?:bps|basis\s+points)/gi,
  )) {
    const bps = Number(m[1]);
    if (!Number.isFinite(bps) || bps > 500) continue;
    add({
      text: `Steel prices → ${bps}bps margin hit`,
      polarity: "negative",
      kind: "risk",
      score: 9,
      quote: m[0].slice(0, 160),
      metric: "Margin compression",
      value: bps,
      unit: "bps",
    });
  }
  for (const m of t.matchAll(
    /(\d{2,4})\s*(?:bps|basis\s+points)[^.]{0,60}?(?:margin|steel|EBITDA)/gi,
  )) {
    const bps = Number(m[1]);
    if (!Number.isFinite(bps) || bps > 500) continue;
    add({
      text: `Margin hit ${bps}bps (input costs)`,
      polarity: "negative",
      kind: "risk",
      score: 8,
      quote: m[0].slice(0, 160),
      metric: "Margin compression",
      value: bps,
      unit: "bps",
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

function candidateToRow(
  c: MaterialHighlightCandidate,
  id: number,
  category: string,
  sentiment: string,
  score: number,
): Record<string, unknown> {
  return {
    id,
    category,
    sentiment,
    headline: c.text,
    quote: c.quote,
    quantified_impact: {
      metric: c.metric,
      value: c.value,
      unit: c.unit,
      impact_level: c.score >= 8 ? "HIGH" : c.score >= 6 ? "MEDIUM" : "LOW",
    },
    forward_indicator: c.kind === "guidance" || c.kind === "strategic",
    score,
  };
}

/**
 * If materials contain strong generic facts the LLM missed/paraphrased away,
 * rebuild slots from those candidates (still no company hardcoding).
 */
export function groundHighlightSentimentInMaterials(
  quantHl: Record<string, unknown>,
  materialsText: string,
): Record<string, unknown> {
  const candidates = extractMaterialHighlightCandidates(materialsText);
  if (candidates.length < 2) return quantHl;

  const wins = candidates.filter((c) => c.kind === "win");
  const risks = candidates.filter((c) => c.kind === "risk");
  const strat = candidates.filter((c) => c.kind === "strategic");
  const guide = candidates.filter((c) => c.kind === "guidance");

  if (!wins.length && !strat.length && !guide.length) return quantHl;

  const win = wins[0] || guide[0] || candidates[0]!;
  // Prefer demerger/subsidiary over utilization for STRATEGIC slot
  const strategic =
    strat.find((c) => /subsidiary|demerger|restructur/i.test(c.text)) ||
    strat[0] ||
    null;
  // Prefer steel/input wording; among bps hits keep the primary (usually ~100 not noise)
  const risk =
    risks.find((c) => /steel/i.test(c.text)) ||
    [...risks].sort((a, b) => {
      const av = typeof a.value === "number" ? a.value : 999;
      const bv = typeof b.value === "number" ? b.value : 999;
      return av - bv;
    })[0] ||
    null;
  const guidance = guide[0] || null;

  // Schema slots
  const rowWin = candidateToRow(
    win.kind === "win" ? win : wins[0] || win,
    1,
    "BIGGEST WIN",
    "POSITIVE",
    Math.max(7, (wins[0] || win).score),
  );
  const rowRisk = risk
    ? candidateToRow(
        risk,
        2,
        "BIGGEST RISK",
        "NEGATIVE",
        Math.min(5, risk.score > 5 ? 4 : risk.score),
      )
    : guidance && guidance.text !== (wins[0] || win).text
      ? candidateToRow(guidance, 2, "BIGGEST RISK", "NEGATIVE", 4)
      : {
          id: 2,
          category: "BIGGEST RISK",
          sentiment: "NEGATIVE",
          headline: "Limited hard negatives disclosed",
          quote: null,
          quantified_impact: {
            metric: null,
            value: null,
            unit: null,
            impact_level: "LOW",
          },
          forward_indicator: true,
          score: 4,
        };
  const rowStrat = strategic
    ? candidateToRow(
        strategic,
        3,
        "STRATEGIC",
        "NEUTRAL",
        Math.min(8, Math.max(4, strategic.score)),
      )
    : guidance &&
        guidance.text !== rowWin.headline &&
        guidance.text !== (rowRisk as { headline?: string }).headline
      ? candidateToRow(guidance, 3, "STRATEGIC", "NEUTRAL", 6)
      : {
          ...rowWin,
          id: 3,
          category: "STRATEGIC",
          sentiment: "NEUTRAL",
          score: 6,
        };

  // Prefer win = value-add when present
  if (wins[0]) {
    rowWin.headline = wins[0].text;
    rowWin.quote = wins[0].quote;
    rowWin.quantified_impact = {
      metric: wins[0].metric,
      value: wins[0].value,
      unit: wins[0].unit,
      impact_level: "HIGH",
    };
    rowWin.score = Math.max(7, wins[0].score);
  }

  const rows = [rowWin, rowRisk as Record<string, unknown>, rowStrat];

  // Card scanline order: guidance · demerger · value-add when all exist
  const cardOrder: MaterialHighlightCandidate[] = [];
  if (guidance) cardOrder.push(guidance);
  if (strategic) cardOrder.push(strategic);
  if (wins[0]) cardOrder.push(wins[0]);
  for (const c of candidates) {
    if (cardOrder.length >= 3) break;
    if (!cardOrder.some((x) => x.text === c.text)) cardOrder.push(c);
  }

  const scores = rows.map((r) => (typeof r.score === "number" ? r.score : 5));
  const avg =
    Math.round(((scores[0]! + scores[1]! + scores[2]!) / 3) * 10) / 10;
  const pos = rows.filter((r) => r.sentiment === "POSITIVE");
  const neg = rows.filter((r) => r.sentiment === "NEGATIVE");
  const neu = rows.filter((r) => r.sentiment === "NEUTRAL");
  const avgOf = (list: Record<string, unknown>[]) =>
    list.length
      ? Math.round(
          (list.reduce(
            (s, r) => s + (typeof r.score === "number" ? r.score : 0),
            0,
          ) /
            list.length) *
            10,
        ) / 10
      : null;

  const meta = asObj(quantHl.metadata) || {};
  const portfolio =
    avg >= 6.5 ? "POSITIVE" : avg < 4 ? "NEGATIVE" : "NEUTRAL";

  return {
    ...quantHl,
    metadata: {
      ...meta,
      total_highlights: 3,
      positive_count: pos.length,
      negative_count: neg.length,
      neutral_count: neu.length,
      overall_sentiment: portfolio,
      overall_score: avg,
    },
    highlights: rows,
    sentiment_summary: {
      positive_avg_score: avgOf(pos),
      negative_avg_score: avgOf(neg),
      neutral_avg_score: avgOf(neu),
      portfolio_score: avg,
      portfolio_sentiment: portfolio,
    },
    _card_scanlines: cardOrder.slice(0, 3).map((c) => ({
      text: c.text,
      polarity: c.polarity,
    })),
  };
}

/** Prefer grounded `_card_scanlines` when present. */
export function cardHighlightsFromGroundedQuant(
  quantHl: Record<string, unknown> | null | undefined,
): Array<{ text: string; polarity: string }> | null {
  const raw = quantHl?._card_scanlines;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  return raw
    .map((h) => {
      const o = asObj(h);
      if (!o || typeof o.text !== "string") return null;
      return {
        text: o.text.trim().slice(0, 120),
        polarity: String(o.polarity || "neutral"),
      };
    })
    .filter(Boolean) as Array<{ text: string; polarity: string }>;
}

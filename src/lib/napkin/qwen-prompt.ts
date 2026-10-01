export const NAPKIN_QWEN_SYSTEM = `You are an equity research analyst.

Your job is NOT to decide whether the stock should be bought.
Your job is to analyse whether the company's business fundamentals provide
evidence supporting the earnings growth required by the valuation.

You will receive:
A) FINANCIAL DATA (authoritative — do not recalculate from memory)
B) NAPKIN CALCULATIONS (authoritative)
C) LATEST RESULT PDFs (newest first; typically latest quarter then prior/FY)
D) INVESTOR PRESENTATION if classified
E) ANNUAL REPORT if classified
F) CONCALL TRANSCRIPTS if classified — never treat an Outcome PDF as a concall

Do not use web search. Use only this packet.

RULES:
1. Never invent numbers.
2. Never invent management statements.
3. Never treat management guidance as an achieved result.
4. Clearly distinguish FACT, MANAGEMENT GUIDANCE, and ANALYST INFERENCE.
5. If evidence is unavailable say "Not available".
6. Cite the source document and page number whenever possible (Page 3, Page 7).
7. Financial calculations supplied in the packet are authoritative.
8. Do not recalculate financial numbers from memory.
9. Focus on evidence supporting future earnings growth.
10. Do not output PASS/FAIL or a buy/sell recommendation.

ANALYSE in this order (do not skip headings):
1. GROWTH DRIVERS — what the company does plus evidence for share, capacity, customers, products, volume, pricing, geography, order book, utilisation, capex, margins. Market share: explicit packet evidence or "NO DIRECT EVIDENCE FOUND".
2. MANAGEMENT TRACK RECORD — DATE, CLAIM, TIMEFRAME, TARGET, later RESULT if in the packet. Status only: ACHIEVED / PARTIALLY ACHIEVED / MISSED / DELAYED / UNKNOWN. Do not infer intent.
3. RISKS — only from the packet; else "Not available".
4. BEAR / BASE / BULL — EPS CAGR ranges only if supported by the packet. State assumptions. Else "Not available".
5. NAPKIN ASSESSMENT — copy Basic hurdle and Adjusted hurdle from the packet (do not recalculate). Base CAGR is your BASE-CASE EPS CAGR from evidence, or the packet historical 5Y EPS CAGR if you cannot support a forward base. Growth Gap = Expected EPS CAGR − Required CAGR (report vs adjusted hurdle and vs basic hurdle). Then Evidence, Thesis Breakers, Next Quarter Checks (measurable).

OUTPUT using these markdown headings exactly:
## GROWTH DRIVERS
## MANAGEMENT TRACK RECORD
## RISKS
## BEAR CASE
## BASE CASE
## BULL CASE
## NAPKIN ASSESSMENT
## SOURCE EVIDENCE
`;

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

function num(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return String(v);
}

export type NapkinQwenPacket = {
  company_name: string | null;
  ticker: string;
  yf_symbol: string | null;
  financials: Record<string, unknown>;
  napkin: Record<string, unknown>;
  filings: Array<{
    title: string;
    kind: string;
    url: string;
    pages: Array<{ page_number: number; text: string }>;
  }>;
};

export function buildNapkinQwenUser(packet: NapkinQwenPacket): string {
  const fin = packet.financials;
  const n = packet.napkin as {
    current_pe?: number | null;
    basic_required_cagr?: number | null;
    adjusted_required_cagr?: number | null;
    historical_eps_cagr_3y?: number | null;
    historical_eps_cagr_5y?: number | null;
    growth_gap_3y?: number | null;
    growth_gap_5y?: number | null;
  };
  const parts: string[] = [];
  parts.push(`TICKER: ${packet.ticker}`);
  parts.push(`YF_SYMBOL: ${packet.yf_symbol || "N/A"}`);
  parts.push(`COMPANY_NAME: ${packet.company_name || "N/A"}`);
  parts.push("");
  parts.push("A) FINANCIAL DATA (authoritative)");
  parts.push(JSON.stringify(fin, null, 2));
  parts.push("");
  parts.push("B) NAPKIN CALCULATIONS (authoritative)");
  parts.push(`current_pe: ${num(n.current_pe)}`);
  parts.push(`basic_hurdle: ${pct(n.basic_required_cagr)}`);
  parts.push(`adjusted_hurdle: ${pct(n.adjusted_required_cagr)}`);
  parts.push(`historical_eps_cagr_3y: ${pct(n.historical_eps_cagr_3y)}`);
  parts.push(`historical_eps_cagr_5y: ${pct(n.historical_eps_cagr_5y)}`);
  parts.push(`growth_gap_hist_vs_basic_5y: ${pct(n.growth_gap_5y)}`);
  parts.push(
    "Growth Gap = Expected EPS CAGR − Required CAGR (use adjusted hurdle when comparing to your base case).",
  );
  parts.push("");
  const byKind: Record<string, typeof packet.filings> = {};
  for (const doc of packet.filings) {
    (byKind[doc.kind] ||= []).push(doc);
  }
  const blocks: Array<{ key: string; heading: string }> = [
    { key: "RESULT", heading: "C) RESULT PDFs" },
    { key: "INVESTOR_PRESENTATION", heading: "D) INVESTOR PRESENTATION" },
    { key: "ANNUAL_REPORT", heading: "E) ANNUAL REPORT" },
    { key: "CONCALL_TRANSCRIPT", heading: "F) CONCALLS (if available)" },
  ];
  for (const block of blocks) {
    parts.push(block.heading);
    const docs = byKind[block.key] || [];
    if (!docs.length) {
      parts.push("Not available");
      parts.push("");
      continue;
    }
    for (const doc of docs) {
      parts.push(`--- DOCUMENT: ${doc.title} [${doc.kind}] ---`);
      parts.push(`URL: ${doc.url}`);
      for (const page of doc.pages) {
        const text = (page.text || "").trim();
        if (!text) continue;
        parts.push(`[[Page ${page.page_number}]]`);
        parts.push(text.slice(0, 6000));
      }
    }
    parts.push("");
  }
  return parts.join("\n").slice(0, 80_000);
}

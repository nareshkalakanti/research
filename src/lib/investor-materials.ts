import { loadAgentConfig } from "./agents/config";
import { ensureInvestorMaterialsSchema } from "./investor-materials-schema";
import { fetchInvestorMaterialUrl } from "./investor-material-fetch";
import {
  discoverInvestorMaterialSources,
  pickLatestSources,
} from "./investor-material-scrape";
import type { DiscoveredMaterialSource, InvestorMaterialKind } from "./investor-material-types";
import { checkLlmStatus, completeJson } from "./llm-client";
import { openSqliteNamed } from "./sqlite-utils";

const MAX_STORE = 120_000;

export type InvestorMaterial = {
  id: number;
  ticker: string;
  kind: InvestorMaterialKind;
  title: string;
  period: string | null;
  source_url: string | null;
  raw_text: string;
  brief_text: string | null;
  created_at: string;
  updated_at: string;
};

const DISTILL_SYSTEM = `Extract equity-research facts from an Indian company concall, PPT, or transcript.
Return ONLY valid JSON:
{
  "summary": "180-280 words. Management-stated capabilities, growth catalysts, capacity/capex (₹ amounts and FY labels when stated), guidance, order book, commissioning dates. Use exact numbers from source.",
  "capex_line": "One line — FY26/FY27 CAPEX: ₹X cr (project) or unclear",
  "growth_triggers": "2-4 clauses separated by · — only from source",
  "capabilities": "ONE sentence — key technical / commercial edge from source"
}
Use only source text. Do not invent. Do not repeat these field instructions in your output.`;

function isPromptLeak(s: string): boolean {
  return /one sentence —|one line —|exactly one of|separated by ·|only from source|180-280 words|commercial edge from source/i.test(
    s,
  );
}

function cleanDistillField(s: string, fallback = ""): string {
  const t = String(s || "").trim();
  if (!t || isPromptLeak(t)) return fallback;
  return t;
}

function db() {
  ensureInvestorMaterialsSchema();
  return openSqliteNamed("company_about.db", { readonly: false, wal: true });
}

function rowToMaterial(r: Record<string, unknown>): InvestorMaterial {
  return {
    id: Number(r.id),
    ticker: String(r.ticker),
    kind: (String(r.kind || "other") as InvestorMaterialKind) || "other",
    title: String(r.title || ""),
    period: r.period ? String(r.period) : null,
    source_url: r.source_url ? String(r.source_url) : null,
    raw_text: String(r.raw_text || ""),
    brief_text: r.brief_text ? String(r.brief_text) : null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export function listInvestorMaterials(ticker: string): InvestorMaterial[] {
  const key = ticker.toUpperCase();
  const conn = db();
  try {
    const rows = conn
      .prepare(
        `SELECT id, ticker, kind, title, period, source_url, raw_text, brief_text, created_at, updated_at
         FROM investor_materials WHERE ticker = ? ORDER BY updated_at DESC`,
      )
      .all(key) as Array<Record<string, unknown>>;
    return rows.map(rowToMaterial);
  } finally {
    conn.close();
  }
}

export function investorMaterialsCount(ticker: string): number {
  return listInvestorMaterials(ticker).length;
}

export function investorMaterialExistsByUrl(ticker: string, url: string): boolean {
  const key = url.trim().toLowerCase();
  if (!key) return false;
  return listInvestorMaterials(ticker).some(
    (m) => (m.source_url || "").trim().toLowerCase() === key,
  );
}

const PENDING_PREFIX = "[pending] ";

export function isPendingInvestorMaterial(m: Pick<InvestorMaterial, "raw_text">): boolean {
  return m.raw_text.startsWith(PENDING_PREFIX);
}

function placeholderText(input: {
  title: string;
  url: string;
  period?: string | null;
  kind: InvestorMaterialKind;
}): string {
  const lines = [
    `${PENDING_PREFIX}${input.title}`,
    input.period ? `Period: ${input.period}` : null,
    `Kind: ${input.kind}`,
    `URL: ${input.url}`,
  ].filter(Boolean);
  return lines.join("\n");
}

/** Drop BSE cover-letter noise before slide deck content. */
function trimInvestorMaterialBody(raw: string): string {
  const text = raw.trim();
  const markers = [
    /Investor Presentation/i,
    /Safe Harbor/i,
    /Financial Results/i,
    /Q[1-4]\s*FY/i,
    /Company Overview/i,
  ];
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index != null && m.index > 80) {
      return text.slice(m.index).trim();
    }
  }
  return text;
}

function materialBodyForBrief(m: InvestorMaterial): string {
  if (m.brief_text?.trim()) return m.brief_text.trim().slice(0, 3500);
  return trimInvestorMaterialBody(m.raw_text).slice(0, 3500);
}

/** Pick latest concall, ppt, and one results row for the Business dossier. */
function pickMaterialsForBrief(items: InvestorMaterial[]): InvestorMaterial[] {
  const usable = items.filter((m) => !isPendingInvestorMaterial(m));
  const picked: InvestorMaterial[] = [];
  const seen = new Set<string>();

  const add = (m: InvestorMaterial | undefined) => {
    if (!m || seen.has(m.id)) return;
    seen.add(String(m.id));
    picked.push(m);
  };

  for (const kind of ["concall", "ppt", "other"] as const) {
    if (kind === "other") {
      add(
        usable.find((m) => /annual\s*report|board\s*report/i.test(m.title || "")) ||
          usable.find((m) => m.kind === kind),
      );
    } else {
      add(usable.find((m) => m.kind === kind));
    }
  }

  for (const m of usable) {
    if (picked.length >= 3) break;
    add(m);
  }
  return picked;
}

/** Text block appended to Business LLM dossier. */
export function formatInvestorMaterialsBriefBlock(ticker: string): string | null {
  const items = listInvestorMaterials(ticker);
  if (!items.length) return null;

  const parts: string[] = ["Investor materials (concall / PPT / transcripts / results):"];
  for (const m of pickMaterialsForBrief(items)) {
    const head = [
      m.kind === "other" ? "RESULTS" : m.kind.toUpperCase(),
      m.title || "Untitled",
      m.period ? `(${m.period})` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (isPendingInvestorMaterial(m)) {
      parts.push(
        `\n[${head}]\nTranscript/PDF not fetched — source URL unavailable or blocked. No capex from this file.`,
      );
      continue;
    }

    const body = materialBodyForBrief(m);
    if (body.replace(/\s/g, "").length < 40) continue;
    parts.push(`\n[${head}]\n${body}`);
  }
  if (parts.length <= 1) return null;
  return parts.join("\n");
}

export async function distillInvestorMaterial(
  rawText: string,
  meta: { title?: string; kind?: string },
): Promise<string | null> {
  const cfg = loadAgentConfig();
  const llm = await checkLlmStatus(cfg);
  if (!llm.available) return null;

  try {
    const parsed = await completeJson(
      cfg,
      DISTILL_SYSTEM,
      `Source: ${meta.title || meta.kind || "investor material"}\n\n${rawText.slice(0, 12_000)}`,
    );
    const summary = cleanDistillField(parsed.summary);
    let capex = cleanDistillField(parsed.capex_line);
    if (!capex || /^unclear/i.test(capex)) {
      capex = /capex|capital expend|cap ex/i.test(rawText)
        ? "No explicit FY capex ₹ figure in source"
        : "No capex guidance in source";
    }
    const growth = cleanDistillField(parsed.growth_triggers);
    const cap = cleanDistillField(parsed.capabilities);
    return [
      summary,
      cap ? `Capability: ${cap}` : null,
      growth ? `Growth: ${growth}` : null,
      capex ? `CAPEX: ${capex}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return null;
  }
}

export async function saveInvestorMaterial(input: {
  ticker: string;
  kind?: InvestorMaterialKind;
  title?: string;
  period?: string | null;
  source_url?: string | null;
  text?: string;
  url?: string | null;
  distill?: boolean;
}): Promise<InvestorMaterial> {
  const ticker = input.ticker.toUpperCase();
  let raw = (input.text ?? "").trim();
  let title = (input.title ?? "").trim();
  let sourceUrl = input.source_url?.trim() || null;

  if (!raw && input.url?.trim()) {
    const fetched = await fetchInvestorMaterialUrl(input.url.trim(), { ticker });
    raw = fetched.text;
    sourceUrl = input.url.trim();
    if (!title && fetched.title) title = fetched.title;
  }

  if (raw.length < 80) {
    throw new Error("Need at least 80 characters of text (paste or fetch URL)");
  }

  const kind = input.kind ?? "concall";
  if (!title) title = kind === "ppt" ? "Investor presentation" : "Concall transcript";

  let brief_text: string | null = null;
  if (input.distill) {
    brief_text = await distillInvestorMaterial(raw, { title, kind });
  }

  const now = new Date().toISOString();
  const conn = db();
  try {
    const res = conn
      .prepare(
        `INSERT INTO investor_materials (ticker, kind, title, period, source_url, raw_text, brief_text, created_at, updated_at)
         VALUES (@ticker, @kind, @title, @period, @source_url, @raw_text, @brief_text, @created_at, @updated_at)`,
      )
      .run({
        ticker,
        kind,
        title,
        period: input.period?.trim() || null,
        source_url: sourceUrl,
        raw_text: raw.slice(0, MAX_STORE),
        brief_text,
        created_at: now,
        updated_at: now,
      });
    const row = conn
      .prepare(`SELECT * FROM investor_materials WHERE id = ?`)
      .get(Number(res.lastInsertRowid)) as Record<string, unknown>;
    return rowToMaterial(row);
  } finally {
    conn.close();
  }
}

export { MAX_STORE };

export function deleteInvestorMaterial(id: number): boolean {
  const conn = db();
  try {
    const res = conn.prepare(`DELETE FROM investor_materials WHERE id = ?`).run(id);
    return res.changes > 0;
  } finally {
    conn.close();
  }
}

export async function redistillInvestorMaterial(id: number): Promise<InvestorMaterial | null> {
  const conn = db();
  let row: Record<string, unknown> | undefined;
  try {
    row = conn.prepare(`SELECT * FROM investor_materials WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
  } finally {
    conn.close();
  }
  if (!row) return null;

  const material = rowToMaterial(row);
  const brief_text = await distillInvestorMaterial(material.raw_text, {
    title: material.title,
    kind: material.kind,
  });
  const now = new Date().toISOString();
  const conn2 = db();
  try {
    conn2
      .prepare(
        `UPDATE investor_materials SET brief_text = @brief_text, updated_at = @updated_at WHERE id = @id`,
      )
      .run({ id, brief_text, updated_at: now });
    const updated = conn2
      .prepare(`SELECT * FROM investor_materials WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    return rowToMaterial(updated);
  } finally {
    conn2.close();
  }
}

export type ImportInvestorMaterialsResult = {
  imported: InvestorMaterial[];
  skipped: Array<{ url: string; reason: string }>;
  errors: Array<{ url: string; error: string }>;
};

export async function enrichInvestorMaterialText(id: number): Promise<InvestorMaterial | null> {
  const conn = db();
  let row: Record<string, unknown> | undefined;
  try {
    row = conn.prepare(`SELECT * FROM investor_materials WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
  } finally {
    conn.close();
  }
  if (!row) return null;

  const material = rowToMaterial(row);
  if (!material.source_url || !isPendingInvestorMaterial(material)) {
    return material;
  }

  try {
    const fetched = await fetchInvestorMaterialUrl(material.source_url, {
      ticker: material.ticker,
    });
    const now = new Date().toISOString();
    const conn2 = db();
    let updated: InvestorMaterial;
    try {
      conn2
        .prepare(
          `UPDATE investor_materials SET raw_text = @raw_text, updated_at = @updated_at WHERE id = @id`,
        )
        .run({
          id,
          raw_text: fetched.text.slice(0, MAX_STORE),
          updated_at: now,
        });
      const row = conn2
        .prepare(`SELECT * FROM investor_materials WHERE id = ?`)
        .get(id) as Record<string, unknown>;
      updated = rowToMaterial(row);
    } finally {
      conn2.close();
    }
    void redistillInvestorMaterial(id).catch(() => {});
    return updated;
  } catch {
    return material;
  }
}

export async function importInvestorMaterialFromSource(input: {
  ticker: string;
  source: Pick<
    DiscoveredMaterialSource,
    "url" | "kind" | "title" | "period" | "provider"
  >;
  distill?: boolean;
  metadataOnly?: boolean;
}): Promise<InvestorMaterial> {
  const ticker = input.ticker.toUpperCase();
  if (investorMaterialExistsByUrl(ticker, input.source.url)) {
    throw new Error("Already imported from this URL");
  }

  const isTrendlyne =
    input.source.provider === "trendlyne_analyst_calls" ||
    /trendlyne\.com\/posts\//i.test(input.source.url);

  if (isTrendlyne) {
    const material = await saveInvestorMaterial({
      ticker,
      kind: input.source.kind,
      title: input.source.title,
      period: input.source.period,
      url: input.source.url,
      distill: input.distill === true,
    });
    void redistillInvestorMaterial(material.id).catch(() => {});
    return material;
  }

  if (input.metadataOnly) {
    return saveInvestorMaterial({
      ticker,
      kind: input.source.kind,
      title: input.source.title,
      period: input.source.period,
      source_url: input.source.url,
      text: placeholderText({
        title: input.source.title,
        url: input.source.url,
        period: input.source.period,
        kind: input.source.kind,
      }),
      distill: false,
    });
  }

  return saveInvestorMaterial({
    ticker,
    kind: input.source.kind,
    title: input.source.title,
    period: input.source.period,
    url: input.source.url,
    distill: input.distill === true,
  });
}

export async function importLatestInvestorMaterials(input: {
  ticker: string;
  limit?: number;
  kinds?: InvestorMaterialKind[];
  distill?: boolean;
}): Promise<ImportInvestorMaterialsResult> {
  const ticker = input.ticker.toUpperCase();
  const { sources } = await discoverInvestorMaterialSources(ticker);
  const picks = pickLatestSources(sources, {
    limit: input.limit ?? 2,
    kinds: input.kinds,
    skipImported: true,
    includeResults: true,
  });

  const imported: InvestorMaterial[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const errors: Array<{ url: string; error: string }> = [];

  const results = await Promise.all(
    picks.map(async (source) => {
      if (source.imported || investorMaterialExistsByUrl(ticker, source.url)) {
        return { type: "skip" as const, url: source.url, reason: "already imported" };
      }
      try {
        const material = await importInvestorMaterialFromSource({
          ticker,
          source,
          metadataOnly: true,
          distill: false,
        });
        return { type: "ok" as const, material };
      } catch (err) {
        return {
          type: "err" as const,
          url: source.url,
          error: err instanceof Error ? err.message : "Import failed",
        };
      }
    }),
  );

  for (const r of results) {
    if (r.type === "ok") imported.push(r.material);
    else if (r.type === "skip") skipped.push({ url: r.url, reason: r.reason });
    else errors.push({ url: r.url, error: r.error });
  }

  for (const material of imported) {
    if (isPendingInvestorMaterial(material)) {
      void enrichInvestorMaterialText(material.id).catch(() => {});
    } else {
      void redistillInvestorMaterial(material.id).catch(() => {});
    }
  }

  return { imported, skipped, errors };
}

export type { InvestorMaterialKind, DiscoveredMaterialSource } from "./investor-material-types";
export { discoverInvestorMaterialSources, pickLatestSources };

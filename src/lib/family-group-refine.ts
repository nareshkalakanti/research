/**
 * Local-LLM house labels — copy from member names / stored group_name only.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { DATA_DIR } from "./sqlite-utils";

export type RefineCompany = {
  ticker: string;
  name: string;
  group_name: string;
};

export type RefineGroup = {
  id: string;
  label: string;
  companies: RefineCompany[];
};

const CACHE_PATH = path.join(DATA_DIR, "family_group_refine.db");

function loadPrompt(): string {
  try {
    const p = path.join(process.cwd(), "prompts", "family-groups.system.txt");
    const t = fs.readFileSync(p, "utf8").trim();
    if (t) return t;
  } catch {
    /* fall through */
  }
  return "Return JSON {\"groups\":[{\"id\":\"\",\"label\":\"\"}]}. Copy labels from the cards. No invented names.";
}

function openCache(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(CACHE_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS family_labels (
      fingerprint TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

export function groupFingerprint(tickers: string[]): string {
  const key = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))]
    .sort()
    .join(",");
  return crypto.createHash("sha1").update(key).digest("hex");
}

export function cachedFamilyLabel(tickers: string[]): string | null {
  const fp = groupFingerprint(tickers);
  if (!fs.existsSync(CACHE_PATH)) return null;
  const db = openCache();
  try {
    const row = db
      .prepare(`SELECT label FROM family_labels WHERE fingerprint = ?`)
      .get(fp) as { label?: string } | undefined;
    return row?.label?.trim() || null;
  } finally {
    db.close();
  }
}

function saveLabel(tickers: string[], label: string): void {
  const db = openCache();
  try {
    db.prepare(
      `INSERT INTO family_labels (fingerprint, label, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         label = excluded.label,
         updated_at = excluded.updated_at`,
    ).run(groupFingerprint(tickers), label, new Date().toISOString());
  } finally {
    db.close();
  }
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  );
}

function labelAllowed(label: string, allowed: Set<string>): boolean {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 6) return false;
  const generic = new Set([
    "group",
    "limited",
    "ltd",
    "investment",
    "holdings",
    "industries",
    "company",
    "bank",
    "of",
    "and",
    "the",
  ]);
  if (words.every((w) => generic.has(w))) return false;
  return words.every((w) => generic.has(w) || allowed.has(w));
}

export async function refineFamilyGroupLabels(
  groups: RefineGroup[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!groups.length) return out;
  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available) return out;
  const cards = groups.map((g) => ({
    id: g.id,
    current_label: g.label,
    companies: g.companies.map((c) => ({
      ticker: c.ticker,
      name: c.name,
      group_name: c.group_name || "",
    })),
  }));
  const parsed = await completeJson(
    cfg,
    loadPrompt(),
    `Cards:\n${JSON.stringify(cards).slice(0, 14_000)}`,
    {
      temperature: 0.05,
      maxTokens: 900,
      jsonSchema: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
              },
              required: ["id", "label"],
            },
          },
        },
        required: ["groups"],
      },
    },
  );
  const rows = Array.isArray(parsed.groups) ? parsed.groups : [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { id?: string; label?: string };
    const id = String(r.id || "").trim();
    const label = String(r.label || "").replace(/\s+/g, " ").trim();
    const g = byId.get(id);
    if (!g || !label || label.includes("·")) continue;
    const allowed = tokenSet(
      g.companies.map((c) => `${c.name} ${c.group_name}`).join(" "),
    );
    if (!labelAllowed(label, allowed)) continue;
    out.set(id, label);
    saveLabel(
      g.companies.map((c) => c.ticker),
      label,
    );
  }
  return out;
}

let refineInFlight: Promise<void> | null = null;

export function scheduleFamilyGroupRefine(groups: RefineGroup[]): void {
  if (refineInFlight) return;
  const need = groups.filter((g) => !cachedFamilyLabel(g.companies.map((c) => c.ticker)));
  if (!need.length) return;
  refineInFlight = (async () => {
    try {
      for (let i = 0; i < 8; i++) {
        const batch = groups
          .filter((g) => !cachedFamilyLabel(g.companies.map((c) => c.ticker)))
          .slice(0, 18);
        if (!batch.length) break;
        await refineFamilyGroupLabels(batch);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[family-group-refine]", msg);
    } finally {
      refineInFlight = null;
    }
  })();
}

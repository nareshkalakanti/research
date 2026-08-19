import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { EvaluationResult, RunMode, VerdictLabel } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "agents.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      engine TEXT NOT NULL,
      universe_count INTEGER NOT NULL,
      debate_count INTEGER NOT NULL,
      buy_count INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      cap_segment TEXT,
      verdict TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      rationale TEXT,
      key_catalyst TEXT,
      winner TEXT,
      bull_score REAL,
      bear_score REAL,
      fired INTEGER NOT NULL DEFAULT 0,
      engine TEXT NOT NULL,
      price REAL,
      day_change_pct REAL,
      detected_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_verdicts_run ON agent_verdicts(run_id);
    CREATE INDEX IF NOT EXISTS idx_agent_verdicts_symbol ON agent_verdicts(symbol);
    CREATE INDEX IF NOT EXISTS idx_agent_verdicts_detected ON agent_verdicts(detected_at DESC);
  `);
  db = conn;
  return conn;
}

export function startRun(opts: {
  mode: RunMode;
  engine: string;
  universeCount: number;
}): number {
  const conn = getDb();
  const r = conn
    .prepare(
      `INSERT INTO agent_runs (mode, engine, universe_count, debate_count, buy_count, started_at)
       VALUES (?, ?, ?, 0, 0, ?)`,
    )
    .run(opts.mode, opts.engine, opts.universeCount, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function finishRun(
  runId: number,
  opts: { debateCount: number; buyCount: number },
): void {
  getDb()
    .prepare(
      `UPDATE agent_runs SET debate_count = ?, buy_count = ?, finished_at = ? WHERE id = ?`,
    )
    .run(opts.debateCount, opts.buyCount, new Date().toISOString(), runId);
}

export function saveVerdict(
  runId: number,
  opts: {
    symbol: string;
    name: string;
    cap_segment: string;
    evaluation: EvaluationResult;
    fired: boolean;
    price: number | null;
    day_change_pct: number | null;
  },
): void {
  const v = opts.evaluation.verdict;
  getDb()
    .prepare(
      `
      INSERT INTO agent_verdicts (
        run_id, symbol, name, cap_segment, verdict, confidence,
        rationale, key_catalyst, winner, bull_score, bear_score,
        fired, engine, price, day_change_pct, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      runId,
      opts.symbol,
      opts.name,
      opts.cap_segment,
      v.verdict,
      v.confidence,
      v.rationale,
      v.key_catalyst,
      v.winner,
      v.bull_score,
      v.bear_score,
      opts.fired ? 1 : 0,
      opts.evaluation.engine,
      opts.price,
      opts.day_change_pct,
      new Date().toISOString(),
    );
}

export type StoredVerdict = {
  id: number;
  run_id: number;
  symbol: string;
  name: string;
  cap_segment: string | null;
  verdict: VerdictLabel;
  confidence: number;
  rationale: string | null;
  key_catalyst: string | null;
  winner: string | null;
  fired: boolean;
  engine: string;
  price: number | null;
  day_change_pct: number | null;
  detected_at: string;
};

export function listRecentVerdicts(limit = 30): StoredVerdict[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM agent_verdicts
      ORDER BY detected_at DESC, id DESC
      LIMIT ?
      `,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: Number(r.id),
    run_id: Number(r.run_id),
    symbol: String(r.symbol),
    name: String(r.name),
    cap_segment: r.cap_segment != null ? String(r.cap_segment) : null,
    verdict: String(r.verdict) as VerdictLabel,
    confidence: Number(r.confidence),
    rationale: r.rationale != null ? String(r.rationale) : null,
    key_catalyst: r.key_catalyst != null ? String(r.key_catalyst) : null,
    winner: r.winner != null ? String(r.winner) : null,
    fired: Boolean(r.fired),
    engine: String(r.engine),
    price: r.price != null ? Number(r.price) : null,
    day_change_pct:
      r.day_change_pct != null ? Number(r.day_change_pct) : null,
    detected_at: String(r.detected_at),
  }));
}

export function listBuySignals(limit = 20): StoredVerdict[] {
  return listRecentVerdicts(200).filter((v) => v.fired).slice(0, limit);
}

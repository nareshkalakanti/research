/**
 * Careful Groww CEO/MD → existing DIN director links.
 * Groww has no full board / DIN. Only unique distinctive names are merged.
 */
import { invalidateGovernanceMapCache } from "./governance-map";
import {
  getGovernanceWriteDb,
  recordScanAttempt,
} from "./governance-write";

const RARE_LAST_MAX = 8;

export type DinNameHit = {
  person_id: string;
  din: string;
  name: string;
  reason: "token3" | "token2_rare";
};

export type GrowwDinLink = {
  ticker: string;
  groww_name: string;
  din: string;
  din_name: string;
  reason: DinNameHit["reason"];
};

export type GrowwDinMapResult = {
  linked: number;
  skipped_none: number;
  skipped_ambiguous: number;
  skipped_weak: number;
  links: GrowwDinLink[];
};

type DinPerson = {
  person_id: string;
  din: string;
  name: string;
  tokens: string[];
  signature: string;
};

export type DinNameIndex = {
  bySignature: Map<string, DinPerson[]>;
  lastFreq: Map<string, number>;
};

function nameTokens(raw: string): string[] {
  let text = raw.toLowerCase();
  text = text.replace(/\b(mr|mrs|ms|dr|shri|smt)\.?\b/g, " ");
  text = text.replace(/[^a-z0-9]+/g, " ");
  return text.split(/\s+/).filter((t) => t.length >= 2);
}

function signature(tokens: string[]): string {
  return [...tokens].sort().join(" ");
}

function uniquePeople(rows: DinPerson[]): DinPerson[] {
  const byId = new Map<string, DinPerson>();
  for (const row of rows) byId.set(row.person_id, row);
  return [...byId.values()];
}

export function loadDinNameIndex(): DinNameIndex {
  const db = getGovernanceWriteDb();
  const rows = db
    .prepare(
      `
      SELECT person_id, din, name
      FROM directors
      WHERE din IS NOT NULL AND TRIM(din) != ''
      `,
    )
    .all() as Array<{ person_id: string; din: string; name: string }>;

  const bySignature = new Map<string, DinPerson[]>();
  const lastFreq = new Map<string, number>();

  for (const r of rows) {
    const tokens = nameTokens(r.name);
    if (tokens.length < 2) continue;
    const person: DinPerson = {
      person_id: r.person_id,
      din: r.din.trim(),
      name: r.name,
      tokens,
      signature: signature(tokens),
    };
    const last = tokens[tokens.length - 1]!;
    lastFreq.set(last, (lastFreq.get(last) ?? 0) + 1);
    const list = bySignature.get(person.signature) ?? [];
    list.push(person);
    bySignature.set(person.signature, list);
  }

  return { bySignature, lastFreq };
}

export function matchGrowwNameToDin(
  rawName: string,
  index?: DinNameIndex,
): DinNameHit | null {
  const tokens = nameTokens(rawName);
  if (tokens.length < 2) return null;
  const idx = index ?? loadDinNameIndex();
  const hits = uniquePeople(idx.bySignature.get(signature(tokens)) ?? []);
  if (hits.length !== 1) return null;
  const hit = hits[0]!;
  if (tokens.length >= 3) {
    return {
      person_id: hit.person_id,
      din: hit.din,
      name: hit.name,
      reason: "token3",
    };
  }
  const last = tokens[tokens.length - 1]!;
  if ((idx.lastFreq.get(last) ?? 99) <= RARE_LAST_MAX) {
    return {
      person_id: hit.person_id,
      din: hit.din,
      name: hit.name,
      reason: "token2_rare",
    };
  }
  return null;
}

type GrowwSeatRow = {
  ticker: string;
  person_id: string;
  director_name: string;
};

function pendingGrowwSeats(): GrowwSeatRow[] {
  const db = getGovernanceWriteDb();
  return db
    .prepare(
      `
      SELECT s.ticker, s.person_id, d.name AS director_name
      FROM board_seats s
      JOIN directors d ON d.person_id = s.person_id
      WHERE s.person_id LIKE 'n:%'
        AND (s.source = 'groww' OR s.source = 'groww_din_map' OR s.source IS NULL OR s.source = '')
        AND s.ticker NOT IN (
          SELECT DISTINCT s2.ticker
          FROM board_seats s2
          JOIN directors d2 ON d2.person_id = s2.person_id
          WHERE d2.din IS NOT NULL AND TRIM(d2.din) != ''
        )
      `,
    )
    .all() as GrowwSeatRow[];
}

function previewMatch(seat: GrowwSeatRow, index: DinNameIndex): {
  kind: "link" | "none" | "ambiguous" | "weak";
  hit?: DinNameHit;
} {
  const tokens = nameTokens(seat.director_name);
  if (tokens.length < 2) return { kind: "none" };
  const hits = uniquePeople(index.bySignature.get(signature(tokens)) ?? []);
  if (hits.length > 1) return { kind: "ambiguous" };
  if (hits.length === 0) return { kind: "none" };
  const hit = matchGrowwNameToDin(seat.director_name, index);
  if (!hit) return { kind: "weak" };
  return { kind: "link", hit };
}

export function previewGrowwDinMap(): GrowwDinMapResult {
  const index = loadDinNameIndex();
  const result: GrowwDinMapResult = {
    linked: 0,
    skipped_none: 0,
    skipped_ambiguous: 0,
    skipped_weak: 0,
    links: [],
  };
  const seen = new Set<string>();
  for (const seat of pendingGrowwSeats()) {
    const key = `${seat.ticker}|${seat.person_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const preview = previewMatch(seat, index);
    if (preview.kind === "link" && preview.hit) {
      result.linked += 1;
      result.links.push({
        ticker: seat.ticker.toUpperCase(),
        groww_name: seat.director_name,
        din: preview.hit.din,
        din_name: preview.hit.name,
        reason: preview.hit.reason,
      });
    } else if (preview.kind === "ambiguous") {
      result.skipped_ambiguous += 1;
    } else if (preview.kind === "weak") {
      result.skipped_weak += 1;
    } else {
      result.skipped_none += 1;
    }
  }
  return result;
}

export function applyGrowwDinMap(): GrowwDinMapResult {
  const index = loadDinNameIndex();
  const result: GrowwDinMapResult = {
    linked: 0,
    skipped_none: 0,
    skipped_ambiguous: 0,
    skipped_weak: 0,
    links: [],
  };
  const jobs: Array<{
    ticker: string;
    oldPersonId: string;
    growwName: string;
    hit: DinNameHit;
  }> = [];
  const seen = new Set<string>();
  for (const seat of pendingGrowwSeats()) {
    const key = `${seat.ticker}|${seat.person_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const preview = previewMatch(seat, index);
    if (preview.kind === "link" && preview.hit) {
      jobs.push({
        ticker: seat.ticker.toUpperCase(),
        oldPersonId: seat.person_id,
        growwName: seat.director_name,
        hit: preview.hit,
      });
    } else if (preview.kind === "ambiguous") {
      result.skipped_ambiguous += 1;
    } else if (preview.kind === "weak") {
      result.skipped_weak += 1;
    } else {
      result.skipped_none += 1;
    }
  }

  const db = getGovernanceWriteDb();
  const hasSeat = db.prepare(
    `SELECT 1 FROM board_seats WHERE ticker = ? AND person_id = ?`,
  );
  const relink = db.prepare(
    `
    UPDATE board_seats
    SET person_id = ?, source = 'groww_din_map'
    WHERE ticker = ? AND person_id = ?
    `,
  );
  const dropOld = db.prepare(
    `DELETE FROM board_seats WHERE ticker = ? AND person_id = ?`,
  );
  const dropOrphan = db.prepare(
    `
    DELETE FROM directors
    WHERE person_id = ?
      AND (din IS NULL OR TRIM(din) = '')
      AND NOT EXISTS (
        SELECT 1 FROM board_seats s WHERE s.person_id = directors.person_id
      )
    `,
  );

  const tx = db.transaction(() => {
    for (const job of jobs) {
      if (hasSeat.get(job.ticker, job.hit.person_id)) {
        dropOld.run(job.ticker, job.oldPersonId);
      } else {
        relink.run(job.hit.person_id, job.ticker, job.oldPersonId);
      }
      dropOrphan.run(job.oldPersonId);
      recordScanAttempt(
        job.ticker,
        "groww_mapped",
        `Groww ${job.growwName} → DIN ${job.hit.din} (${job.hit.name})`,
      );
      result.linked += 1;
      result.links.push({
        ticker: job.ticker,
        groww_name: job.growwName,
        din: job.hit.din,
        din_name: job.hit.name,
        reason: job.hit.reason,
      });
    }
  });
  tx();
  invalidateGovernanceMapCache();
  return result;
}

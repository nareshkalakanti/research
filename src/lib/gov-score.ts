/** Director network score — ported from stocks-ai governance/score.py */

export const LARGE_MCAP_CR = 5_000;
export const SMALL_MCAP_CR = 1_000;

const CAP_CODE_BANDS: Array<{
  lo: number | null;
  hi: number | null;
  code: string;
  label: string;
}> = [
  { lo: 0, hi: 100, code: "NC", label: "Nano Cap (< 100 Cr)" },
  { lo: 100, hi: 500, code: "MIC", label: "Micro Cap (100–500 Cr)" },
  { lo: 500, hi: 5_000, code: "SC", label: "Small Cap (500–5,000 Cr)" },
  { lo: 5_000, hi: 20_000, code: "MC", label: "Mid Cap (5,000–20,000 Cr)" },
  { lo: 20_000, hi: null, code: "LC", label: "Large Cap (≥ 20,000 Cr)" },
];

const DIN_MATCH_WEIGHT = 1.0;
const NAME_MATCH_WEIGHT = 0.25;
const BRIDGE_BONUS = 15.0;
const HAS_LARGE_BONUS = 8.0;
const OVERLOAD_AFTER = 5;
const OVERLOAD_PENALTY_PER = 4.0;
const NAME_COLLISION_MIN_BOARDS = 5;

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

export function mcapCapCode(marketCapCr: number | null | undefined): string | null {
  if (marketCapCr == null) return null;
  const cap = Number(marketCapCr);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  for (const band of CAP_CODE_BANDS) {
    if (band.lo != null && cap < band.lo) continue;
    if (band.hi != null && cap >= band.hi) continue;
    return band.code;
  }
  return null;
}

export function mcapCapLabel(marketCapCr: number | null | undefined): string | null {
  const code = mcapCapCode(marketCapCr);
  if (!code) return null;
  return CAP_CODE_BANDS.find((b) => b.code === code)?.label ?? null;
}

export function isDinPerson(
  personId: string | null | undefined,
  din?: string | null,
): boolean {
  if (safeStr(din)) return true;
  const pid = safeStr(personId);
  return Boolean(pid) && !pid.startsWith("n:");
}

export function matchWeight(
  personId?: string | null,
  din?: string | null,
): number {
  return isDinPerson(personId, din) ? DIN_MATCH_WEIGHT : NAME_MATCH_WEIGHT;
}

export function roleWeight(
  designation?: string | null,
  category?: string | null,
): number {
  const text = `${safeStr(designation)} ${safeStr(category)}`.toLowerCase();
  if (text.includes("chair")) return 1.25;
  if (
    ["managing", "whole-time", "whole time", "ceo", "md"].some((x) =>
      text.includes(x),
    )
  ) {
    return 1.2;
  }
  if (text.includes("independent")) return 1.15;
  return 1.0;
}

export function mcapLogWeight(marketCapCr: number | null | undefined): number {
  if (marketCapCr == null) return 0.5;
  const cap = Number(marketCapCr);
  if (!Number.isFinite(cap) || cap <= 0) return 0.5;
  return Math.log10(1.0 + cap);
}

export function seatContribution(opts: {
  marketCapCr: number | null | undefined;
  personId?: string | null;
  din?: string | null;
  designation?: string | null;
  category?: string | null;
}): number {
  return (
    mcapLogWeight(opts.marketCapCr) *
    matchWeight(opts.personId, opts.din) *
    roleWeight(opts.designation, opts.category)
  );
}

export function likelyNameCollision(opts: {
  dinBacked: boolean;
  boardCount: number;
  minBoards?: number;
}): boolean {
  if (opts.dinBacked) return false;
  const n = Number(opts.boardCount);
  if (!Number.isFinite(n)) return false;
  return n >= Math.max(2, opts.minBoards ?? NAME_COLLISION_MIN_BOARDS);
}

export type SeatForScore = {
  ticker?: string | null;
  market_cap_cr?: number | null;
  person_id?: string | null;
  din?: string | null;
  designation?: string | null;
  category?: string | null;
};

export type DirectorScore = {
  dir_score: number;
  din_backed: boolean;
  name_collision: boolean;
  board_count: number;
  big_n: number;
  small_n: number;
  bridge: boolean;
  raw: number;
  base: number;
  bonus: number;
  overload_penalty: number;
  known_mcap_n: number;
  match_weight: number;
};

export function scoreDirectorSeats(
  seats: SeatForScore[],
  opts?: { personId?: string | null; din?: string | null },
): DirectorScore {
  const pid =
    safeStr(opts?.personId) ||
    safeStr(seats[0]?.person_id) ||
    "";
  const dinKey = safeStr(opts?.din) || safeStr(seats[0]?.din) || "";
  const dinBacked = isDinPerson(pid, dinKey);

  let raw = 0;
  let bigN = 0;
  let smallN = 0;
  let knownMcapN = 0;

  for (const seat of seats) {
    let mcapF: number | null = null;
    if (seat.market_cap_cr != null) {
      const n = Number(seat.market_cap_cr);
      if (Number.isFinite(n) && n > 0) mcapF = n;
    }
    if (mcapF != null) {
      knownMcapN += 1;
      if (mcapF >= LARGE_MCAP_CR) bigN += 1;
      if (mcapF <= SMALL_MCAP_CR) smallN += 1;
    }
    raw += seatContribution({
      marketCapCr: mcapF,
      personId: pid || seat.person_id,
      din: dinKey || seat.din,
      designation: seat.designation,
      category: seat.category,
    });
  }

  const tickers = new Set(
    seats.map((s) => safeStr(s.ticker).toUpperCase()).filter(Boolean),
  );
  let boardCount = tickers.size;
  if (boardCount <= 0) boardCount = seats.length;

  let bridge = false;
  let bonus = 0;
  if (bigN >= 1 && smallN >= 1) {
    bridge = true;
    bonus += BRIDGE_BONUS;
  } else if (bigN >= 1) {
    bonus += HAS_LARGE_BONUS;
  }

  const overload = Math.max(0, boardCount - OVERLOAD_AFTER) * OVERLOAD_PENALTY_PER;
  const base = 70.0 * (1.0 - Math.exp(-raw / 6.0));
  let score = base + bonus - overload;
  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  return {
    dir_score: score,
    din_backed: dinBacked,
    name_collision: likelyNameCollision({
      dinBacked,
      boardCount,
    }),
    board_count: boardCount,
    big_n: bigN,
    small_n: smallN,
    bridge,
    raw: Math.round(raw * 1000) / 1000,
    base: Math.round(base * 10) / 10,
    bonus,
    overload_penalty: overload,
    known_mcap_n: knownMcapN,
    match_weight: matchWeight(pid, dinKey),
  };
}

import { loadAllCompanies } from "@/lib/db";
import { loadBreakoutMap } from "@/lib/signals";
import { capTier, type CapTier } from "@/lib/types";
import type { EvidenceBundle } from "./types";

export type QuantListMarket = "NSE" | "NSE SME" | "BSE SME" | "All";

function matchesMarket(companyMarket: string, list: QuantListMarket): boolean {
  if (list === "All") return true;
  if (list === "NSE") {
    return companyMarket === "NSE" || companyMarket === "NSE SME";
  }
  return companyMarket === list;
}

export function countQuantUniverse(list: QuantListMarket): number {
  return loadAllCompanies().filter((c) => matchesMarket(c.market, list)).length;
}

export function countQuantSignals(
  list: QuantListMarket,
  cap: CapTier | "All",
): { bb: number; tq: number; hits: number } {
  const breakouts = loadBreakoutMap();
  let bb = 0;
  let tq = 0;
  for (const c of loadAllCompanies()) {
    if (!matchesMarket(c.market, list)) continue;
    if (cap !== "All" && capTier(c.mcap_cr) !== cap) continue;
    const flags = breakouts.get(c.ticker.toUpperCase());
    if (flags?.has_bb) bb += 1;
    if (flags?.has_tq) tq += 1;
  }
  const hitSet = new Set<string>();
  for (const c of loadAllCompanies()) {
    if (!matchesMarket(c.market, list)) continue;
    if (cap !== "All" && capTier(c.mcap_cr) !== cap) continue;
    const flags = breakouts.get(c.ticker.toUpperCase());
    if (flags?.has_bb || flags?.has_tq) {
      hitSet.add(c.ticker.toUpperCase());
    }
  }
  return { bb, tq, hits: hitSet.size };
}

export function listQuantShortlist(
  list: QuantListMarket,
  cap: CapTier | "All",
  bbAnd: boolean,
  limit = 24,
): Array<{ ticker: string; market: string }> {
  const breakouts = loadBreakoutMap();
  const out: Array<{ ticker: string; market: string }> = [];

  for (const c of loadAllCompanies()) {
    if (!matchesMarket(c.market, list)) continue;
    if (cap !== "All" && capTier(c.mcap_cr) !== cap) continue;
    const flags = breakouts.get(c.ticker.toUpperCase());
    const hasBb = !!flags?.has_bb;
    const hasTq = !!flags?.has_tq;
    if (bbAnd ? hasBb && hasTq : hasBb || hasTq) {
      out.push({ ticker: c.ticker.toUpperCase(), market: c.market });
    }
  }

  out.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return out.slice(0, limit);
}

export function attachWeeklySignals(bundle: EvidenceBundle): EvidenceBundle {
  const flags = loadBreakoutMap().get(bundle.symbol.toUpperCase());
  if (!flags) return bundle;
  return {
    ...bundle,
    weekly: {
      has_bb: !!flags.has_bb,
      has_tq: !!flags.has_tq,
      bb: flags.bb,
      tq: flags.tq,
    },
  };
}

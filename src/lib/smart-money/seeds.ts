/**
 * Curated seed positions (public shareholding) when live NSE API is blocked.
 */
import fs from "fs";
import path from "path";
import type { ShareholdingHit } from "./shareholding";
import { bareSymbol } from "@/lib/bulk-deals/nse";
import { loadHiddenUniverse } from "@/lib/hidden-portfolio/universe";
import { primaryInvestorIds } from "./investors";

const SEEDS_PATH = path.join(process.cwd(), "data", "smart_money_seeds.json");

type SeedFile = {
  shareholding?: Array<{
    symbol: string;
    company_name?: string;
    holder_name: string;
    investor_ids: string[];
    pct?: number;
    shares?: number;
    as_of_date?: string;
    source?: string;
  }>;
};

export function loadShareholdingSeeds(): ShareholdingHit[] {
  if (!fs.existsSync(SEEDS_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(SEEDS_PATH, "utf8")) as SeedFile;
  const smeSet = new Set(
    loadHiddenUniverse({ includeDbSme: true }).map((r) => bareSymbol(r.symbol)),
  );
  const fetchedAt = new Date().toISOString();

  return (raw.shareholding ?? []).map((s) => {
    const sym = bareSymbol(s.symbol);
    const investor_ids = s.investor_ids ?? [];
    return {
      symbol: sym,
      company_name: s.company_name ?? null,
      holder_name: s.holder_name,
      investor_ids,
      primary_hit: investor_ids.some((id) => primaryInvestorIds().includes(id)),
      pct: s.pct ?? null,
      shares: s.shares ?? null,
      as_of_date: s.as_of_date ?? null,
      in_sme_universe: smeSet.has(sym),
      fetched_at: fetchedAt,
    };
  });
}

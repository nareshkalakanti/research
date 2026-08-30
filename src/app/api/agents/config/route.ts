import { NextResponse } from "next/server";
import { loadAgentConfig, publicAgentConfig } from "@/lib/agents/config";
import {
  countUniverseEntries,
  listDemoSymbols,
  loadUniverseFile,
} from "@/lib/agents/evidence";
import { loadAllCompanies } from "@/lib/db";
import { loadEdge } from "@/lib/edge";
import { loadHoldings } from "@/lib/holdings";
import { checkLlmStatus } from "@/lib/llm-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = loadAgentConfig();
  const uni = loadUniverseFile();
  const demo = listDemoSymbols();
  const companies = loadAllCompanies();
  const nseDb = companies.filter((c) => c.market === "NSE").length;
  const smeDb = companies.filter((c) => c.market === "NSE SME").length;
  const holdCount = loadHoldings().length;
  const edgeCount = loadEdge().length;
  const llm = await checkLlmStatus(cfg);

  return NextResponse.json({
    ok: true,
    ...publicAgentConfig(cfg),
    llm,
    demoSymbols: demo,
    markets: {
      NSE: nseDb,
      "NSE SME": smeDb,
      All: nseDb + smeDb,
      Hold: holdCount,
      Edge: edgeCount,
    },
    universeCounts: {
      large: uni.large.length,
      mid: uni.mid.length,
      small: uni.small.length,
      total: uni.large.length + uni.mid.length + uni.small.length,
      scout: {
        NSE: countUniverseEntries("NSE"),
        "NSE SME": countUniverseEntries("NSE SME"),
        All: countUniverseEntries("All"),
        Hold: countUniverseEntries("Hold"),
        Edge: countUniverseEntries("Edge"),
      },
    },
    disclaimer:
      "Analysis only. No trades are placed. Not investment advice.",
  });
}

import { NextRequest, NextResponse } from "next/server";
import {
  FUND_WATCHLIST_KEYS,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";
import {
  hasBrutalSelection,
  pendingBrutalTickers,
  runBrutalScanBatch,
  type BrutalSelection,
} from "@/lib/brutal-scan";
import { parseAgeMin } from "@/lib/company-age";
import type { CapTier } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  market?: string;
  tickers?: string[];
  limit?: number;
  concurrency?: number;
  missingOnly?: boolean;
  scope?: "selection" | "list";
  cap?: CapTier | "All";
  hold?: boolean;
  edge?: boolean;
  sme?: boolean;
  note?: boolean;
  ageMin?: number | null;
  age25?: boolean;
  funds?: FundFilterState;
};

function parseFunds(raw: unknown): FundFilterState {
  const out: FundFilterState = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of FUND_WATCHLIST_KEYS) {
    if (obj[key] === true || obj[key] === 1 || obj[key] === "1") {
      out[key as FundWatchlistKey] = true;
    }
  }
  return out;
}

function selectionFromBody(body: Body): BrutalSelection {
  return {
    cap: (body.cap || "All") as CapTier | "All",
    hold: body.hold === true,
    edge: body.edge === true,
    sme: body.sme === true,
    note: body.note === true,
    ageMin:
      parseAgeMin(body.ageMin) ?? (body.age25 === true ? 25 : null),
    funds: parseFunds(body.funds),
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market") || "All";
  const pending = pendingBrutalTickers({ market });
  return NextResponse.json({
    ok: true,
    pending: pending.length,
    sample: pending.slice(0, 20),
  });
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  try {
    const selection = selectionFromBody(body);
    const useSelection =
      body.scope === "selection" || hasBrutalSelection(selection);
    const result = await runBrutalScanBatch({
      market: body.market || "All",
      tickers: body.tickers,
      selection: useSelection ? selection : null,
      limit: body.limit,
      concurrency: body.concurrency,
      missingOnly: body.missingOnly !== false,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Brutal scan failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}

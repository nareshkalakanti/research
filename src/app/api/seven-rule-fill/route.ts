import { NextRequest, NextResponse } from "next/server";
import {
  FUND_WATCHLIST_KEYS,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";
import {
  hasSevenRuleFillSelection,
  pendingSevenRuleFillTickers,
  runSevenRuleFillBatch,
  type SevenRuleFillSelection,
} from "@/lib/seven-rule-fill";
import { parseAgeMin } from "@/lib/company-age";
import type { CapTier } from "@/lib/types";

export const runtime = "nodejs";
/** Slow batches — allow long waits between Screener hits. */
export const maxDuration = 300;

type Body = {
  market?: string;
  tickers?: string[];
  limit?: number;
  scope?: "selection" | "list";
  cap?: CapTier | "All";
  hold?: boolean;
  edge?: boolean;
  sme?: boolean;
  note?: boolean;
  ageMin?: number | null;
  age25?: boolean;
  funds?: FundFilterState;
  fundAll?: boolean;
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

function selectionFromBody(body: Body): SevenRuleFillSelection {
  return {
    cap: (body.cap || "All") as CapTier | "All",
    hold: body.hold === true,
    edge: body.edge === true,
    sme: body.sme === true,
    note: body.note === true,
    ageMin: parseAgeMin(body.ageMin) ?? (body.age25 === true ? 25 : null),
    funds: parseFunds(body.funds),
    fundAll: body.fundAll === true,
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market") || "All";
  const pending = pendingSevenRuleFillTickers({ market });
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
      body.scope === "selection" || hasSevenRuleFillSelection(selection);
    const result = await runSevenRuleFillBatch({
      market: body.market || "All",
      tickers: body.tickers,
      selection: useSelection ? selection : null,
      limit: body.limit,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "7-Rule fill failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}

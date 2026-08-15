import { NextRequest, NextResponse } from "next/server";
import {
  QUANT_NEWS_LIMIT,
  fetchQuantNewsdesk,
  type QuantNewsCompanyIn,
} from "@/lib/agents/newsdesk";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let companies: QuantNewsCompanyIn[] = [];
  try {
    const body = (await req.json()) as { companies?: QuantNewsCompanyIn[] };
    if (Array.isArray(body.companies)) companies = body.companies;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!companies.length) {
    return NextResponse.json({
      ok: true,
      companies: [],
      headlines: 0,
      netTone: 0,
    });
  }

  try {
    const result = await fetchQuantNewsdesk(companies, {
      limit: QUANT_NEWS_LIMIT,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "news fetch failed",
        companies: [],
        headlines: 0,
        netTone: 0,
      },
      { status: 500 },
    );
  }
}

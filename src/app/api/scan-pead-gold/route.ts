import { NextResponse } from "next/server";
import { runPeadHhhGold } from "@/lib/scan-pead-gold";
import { buildIqMasterRows } from "@/lib/iq-master";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const gold = runPeadHhhGold();
    const names = new Map(
      buildIqMasterRows(gold.checks.map((c) => c.ticker)).map((r) => [
        r.ticker.toUpperCase(),
        {
          company: r.company,
          sector: r.sector,
          sub_sector: r.sub_sector,
        },
      ]),
    );
    return NextResponse.json({
      ...gold,
      // HTTP/payload success — do not overwrite with gold.ok (partial Match/Fail).
      ok: true,
      all_match: gold.ok,
      checks: gold.checks.map((c) => {
        const meta = names.get(c.ticker.toUpperCase());
        return {
          ...c,
          company: meta?.company || c.ticker,
          sector: meta?.sector ?? null,
          sub_sector: meta?.sub_sector ?? null,
        };
      }),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Gold check failed",
      },
      { status: 500 },
    );
  }
}

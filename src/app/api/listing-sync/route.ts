import { NextRequest, NextResponse } from "next/server";
import {
  lastListingSync,
  runListingSync,
  runListingSyncIfDue,
} from "@/lib/listing-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET — last sync time + summary. ?dry=1 — preview changes without writing. */
export async function GET(req: NextRequest) {
  try {
    if (req.nextUrl.searchParams.get("dry") === "1") {
      const res = await runListingSync({ dryRun: true });
      return NextResponse.json(res);
    }
    return NextResponse.json({ ok: true, last: lastListingSync() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 },
    );
  }
}

/**
 * POST — run the listing sync now.
 * { ifDue: true } — the app pings this on open: starts a background run only
 * when the last sync is ~20h+ old (one at a time) and returns immediately.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      scanBoards?: boolean;
      ifDue?: boolean;
    };
    if (body.ifDue) {
      const job = runListingSyncIfDue();
      void job.then((res) => {
        if (res) {
          console.log(
            `[listing-sync] ${res.skipped ?? `+${res.added.nse.length} NSE, +${res.added.nse_sme.length} NSE SME, +${res.added.bse_sme.length} BSE SME, ${res.retagged.length} retagged, ${res.renamed.length} renamed, ${res.delisted.length} delisted`}`,
          );
        }
      }).catch((e) => console.warn("[listing-sync] failed:", e));
      return NextResponse.json({ ok: true, last: lastListingSync() });
    }
    const res = await runListingSync({ scanBoards: body.scanBoards !== false });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 },
    );
  }
}

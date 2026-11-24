import { NextRequest, NextResponse } from "next/server";
import { findIdentitySuspects, identityRepairJob, startIdentityRepair } from "@/lib/identity-repair";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: job status; GET ?suspects=1 lists stocks whose saved data may be another company's. */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("suspects") === "1") {
    const suspects = findIdentitySuspects();
    return NextResponse.json({ ok: true, n: suspects.length, suspects });
  }
  return NextResponse.json({ ok: true, job: identityRepairJob() });
}

/** POST {refreshList?}: start the identity repair in the background. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { refreshList?: boolean };
  return NextResponse.json({ ok: true, job: startIdentityRepair({ refreshList: body.refreshList }) });
}

import { NextRequest, NextResponse } from "next/server";
import { boardroomJob, startBoardroomJob, stopBoardroomJob } from "@/lib/boardroom-job";

export const runtime = "nodejs";

/**
 * GET  /api/boardroom-job                           → progress of the board-filing scan
 * POST /api/boardroom-job { days?, limit?, pendingOnly? } → start (one at a time)
 * POST /api/boardroom-job { action: "stop" }        → stop after the current batch
 */
export async function GET() {
  return NextResponse.json({ ok: true, job: boardroomJob() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    days?: number;
    limit?: number;
    pendingOnly?: boolean;
  };
  if (body.action === "stop") return NextResponse.json({ ok: true, stopping: stopBoardroomJob(), job: boardroomJob() });
  const job = startBoardroomJob({ days: body.days, limit: body.limit, pendingOnly: body.pendingOnly });
  return NextResponse.json({ ok: true, job });
}

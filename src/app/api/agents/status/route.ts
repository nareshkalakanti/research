import { NextResponse } from "next/server";
import { getAgentRunState } from "@/lib/agents/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getAgentRunState());
}

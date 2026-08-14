import { NextResponse } from "next/server";
import { getQuantRunState } from "@/lib/agents/quant-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getQuantRunState());
}

import { NextResponse } from "next/server";
import { networkFillStatus, runNetworkFillBatch } from "@/lib/network-fill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET() {
  return NextResponse.json(networkFillStatus());
}

export async function POST() {
  try {
    return NextResponse.json(await runNetworkFillBatch());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { groupThemesByBlog, loadThemes } from "@/lib/themes";

export const runtime = "nodejs";

export async function GET() {
  const file = loadThemes();
  return NextResponse.json({
    meta: file.meta,
    themes: file.themes,
    groups: groupThemesByBlog(file.themes),
  });
}

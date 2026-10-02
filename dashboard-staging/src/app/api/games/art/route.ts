import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const title = request.nextUrl.searchParams.get("title")?.trim().replace(/[_-]+/g, " ");
  if (!title || title.length > 120) return NextResponse.json({ artUrl: null }, { status: 400 });
  try {
    const response = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=US`, { next: { revalidate: 60 * 60 * 24 } });
    const data = await response.json();
    const item = data.items?.find((candidate: { name?: string }) => candidate.name?.toLowerCase() === title.toLowerCase()) || data.items?.[0];
    return NextResponse.json({ artUrl: item?.tiny_image || null }, { headers: { "Cache-Control": "public, max-age=86400" } });
  } catch { return NextResponse.json({ artUrl: null }); }
}

import { NextResponse } from "next/server";
import { scanGameLibrary } from "@/lib/games";

export const dynamic = "force-dynamic";
export async function GET() {
  try { return NextResponse.json(await scanGameLibrary()); }
  catch (error) { return NextResponse.json({ error: String(error) }, { status: 500 }); }
}

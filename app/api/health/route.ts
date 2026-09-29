import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";

/**
 * Liveness probe, also run daily by Vercel Cron (see vercel.json). Supabase's free
 * tier suspends a project after roughly a week without database traffic, which takes
 * the whole app down until someone restores it by hand; this query is that traffic.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const { error } = await serviceClient()
    .from("trips")
    .select("id", { count: "exact", head: true });

  if (error) {
    return NextResponse.json({ ok: false, database: error.message }, { status: 503 });
  }
  return NextResponse.json({ ok: true, database: "reachable", checkedAt: new Date().toISOString() });
}

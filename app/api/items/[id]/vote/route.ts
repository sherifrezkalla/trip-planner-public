import { NextResponse } from "next/server";
import { voteSchema } from "@/lib/schema";
import { serviceClient } from "@/lib/db";
import { authTraveler } from "@/lib/auth";
import { broadcastTripUpdate } from "@/lib/realtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = voteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  const { slug, token, value } = parsed.data;

  const db = serviceClient();
  const auth = await authTraveler(db, slug, token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  const { data: item } = await db
    .from("itinerary_items").select("id, status").eq("id", id).eq("trip_id", trip.id).single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if (item.status !== "planned") {
    return NextResponse.json({ error: "Only planned activities can be voted on" }, { status: 409 });
  }

  const { data: existing } = await db
    .from("votes").select("id, value").eq("item_id", id).eq("traveler_id", me.id).maybeSingle();
  if (existing && existing.value === value) {
    const { error } = await db.from("votes").delete().eq("id", existing.id); // toggle off
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await db.from("votes").upsert(
      { item_id: id, traveler_id: me.id, value },
      { onConflict: "item_id,traveler_id" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({});
}

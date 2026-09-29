import { NextResponse } from "next/server";
import { authTraveler } from "@/lib/auth";
import { serviceClient } from "@/lib/db";
import { broadcastTripUpdate } from "@/lib/realtime";
import { createSuggestionSchema } from "@/lib/schema";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = createSuggestionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a suggestion of up to 240 characters" }, { status: 400 });
  }

  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { error } = await db.from("trip_suggestions").insert({
    trip_id: auth.trip.id,
    traveler_id: auth.me.id,
    text: parsed.data.text,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({}, { status: 201 });
}

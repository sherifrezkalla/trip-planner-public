import { NextResponse } from "next/server";
import { createTripSchema } from "@/lib/schema";
import { makeSlug } from "@/lib/ids";
import { serviceClient } from "@/lib/db";
import { fetchPlacePhotoRef } from "@/lib/photos";
import { allowTripCreate } from "@/lib/public-request-limit";

/**
 * Creating a trip, which is unauthenticated by design: there is no traveller
 * yet, and the private link this returns is what creates the first one.
 *
 * That makes it the third route answering anyone who asks, and the second that
 * spends money doing so — every call fetches a destination photo from the same
 * billed Places API the destination search proxies, and leaves a permanent row
 * behind. It had no ceiling at all, which the architecture note did not record
 * because it described only two public routes.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const parsed = createTripSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  // After validation, so a malformed body costs no slot, and before the photo
  // lookup, so a refused caller spends nothing.
  if (!await allowTripCreate(req.headers)) {
    return NextResponse.json(
      { error: "Too many trips created from here. Try again in a little while." },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }

  const t = parsed.data;
  const slug = makeSlug();
  // Best effort: a missing photo must never block creating a trip.
  const photoRef = process.env.GOOGLE_MAPS_API_KEY
    ? ((await fetchPlacePhotoRef(t.destinationPlaceId, process.env.GOOGLE_MAPS_API_KEY)) ?? "")
    : "";
  const { error } = await serviceClient().from("trips").insert({
    slug,
    title: t.title,
    photo_ref: photoRef,
    destination_name: t.destinationName,
    destination_place_id: t.destinationPlaceId,
    lat: t.lat,
    lng: t.lng,
    start_date: t.startDate,
    end_date: t.endDate,
    budget_level: t.budgetLevel,
    explore_radius_km: t.exploreRadiusKm,
    vibe_note: t.vibeNote,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ slug }, { status: 201 });
}

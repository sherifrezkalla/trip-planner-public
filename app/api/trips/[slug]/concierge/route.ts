import { NextResponse } from "next/server";
import type { ModelMessage } from "ai";
import { authTraveler } from "@/lib/auth";
import {
  buildConciergeInstructions,
  CONCIERGE_REQUESTS_PER_HOUR,
  conversationForModel,
  toConciergePlaces,
  type ConciergeContext,
} from "@/lib/concierge";
import { serviceClient } from "@/lib/db";
import { haversineKm } from "@/lib/geo";
import {
  findItineraryMatches,
  tripDateForDayIndex,
  type ItineraryLookupItem,
  type ItineraryMatchStatus,
} from "@/lib/itinerary-finder";
import { askConcierge } from "@/lib/llm";
import { searchPlaces, type PlaceCandidate } from "@/lib/places";
import { conciergeChatSchema } from "@/lib/schema";

export const maxDuration = 90;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = conciergeChatSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Send a question of up to 2,000 characters" }, { status: 400 });
  }
  if (!process.env.OLLAMA_API_KEY) {
    return NextResponse.json({ error: "The trip concierge is not configured yet" }, { status: 503 });
  }

  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const hourAgo = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  const { count, error: countError } = await db
    .from("concierge_requests")
    .select("id", { count: "exact", head: true })
    .eq("traveler_id", auth.me.id)
    .gte("created_at", hourAgo);
  if (countError) return NextResponse.json({ error: "Could not start the concierge" }, { status: 503 });
  if ((count ?? 0) >= CONCIERGE_REQUESTS_PER_HOUR) {
    return NextResponse.json(
      { error: "You have reached the concierge limit for this hour. Please try again later." },
      { status: 429 },
    );
  }
  const { error: usageError } = await db
    .from("concierge_requests")
    .insert({ traveler_id: auth.me.id });
  if (usageError) return NextResponse.json({ error: "Could not start the concierge" }, { status: 503 });

  const latestQuestion = parsed.data.messages.at(-1)!.content;
  const radiusKm = auth.trip.explore_radius_km ?? 15;
  const base = { lat: auth.trip.lat, lng: auth.trip.lng };
  const [travelersResult, itineraryResult, suggestionsResult] = await Promise.all([
    db
      .from("travelers")
      .select("interests, pace, dietary, constraints_note")
      .eq("trip_id", auth.trip.id),
    db
      .from("itinerary_items")
      .select("id, day_index, block, status, candidate_id, venue_candidates(name, area, maps_url, venue_candidate_categories(category))")
      .eq("trip_id", auth.trip.id)
      .order("day_index")
      .order("position"),
    db.from("trip_suggestions").select("text").eq("trip_id", auth.trip.id).order("created_at"),
  ]);
  if (travelersResult.error || itineraryResult.error || suggestionsResult.error) {
    return NextResponse.json({ error: "Could not read the trip details" }, { status: 503 });
  }

  type ItineraryRow = {
    id: string;
    day_index: number;
    block: string;
    status: string | null;
    candidate_id: string | null;
    venue_candidates: {
      name: string;
      area: string | null;
      maps_url: string | null;
      venue_candidate_categories: { category: string }[] | null;
    } | null;
  };
  const itineraryRows = (itineraryResult.data ?? []) as unknown as ItineraryRow[];
  // The deterministic finder answers from the stored plan alone. Nothing here
  // touches reservation, confirmation, or booking columns: those belong to the
  // organizer, and the concierge must not leak them.
  const lookupItems: ItineraryLookupItem[] = itineraryRows.map((row) => {
    const venue = row.venue_candidates;
    return {
      itemId: row.id,
      candidateKey: row.candidate_id ?? row.id,
      dayIndex: row.day_index,
      date: tripDateForDayIndex(auth.trip.start_date, row.day_index),
      block: row.block,
      status: (row.status ?? "planned") as ItineraryMatchStatus,
      name: venue?.name ?? "Unknown stop",
      area: venue?.area ?? "",
      mapsUrl: venue?.maps_url ?? "",
      categories: (venue?.venue_candidate_categories ?? []).map((entry) => entry.category),
    };
  });
  const finder = findItineraryMatches(latestQuestion, lookupItems, auth.trip.destination_name);

  // Deterministic-first: only spend a Google Places search when the question
  // is not answerable from the plan itself.
  const placeCandidates: PlaceCandidate[] = finder.matches.length > 0
    ? []
    : await searchPlaces({
      query: `${latestQuestion} in ${auth.trip.destination_name}`,
      category: "concierge",
      lat: base.lat,
      lng: base.lng,
      radiusKm,
      area: auth.trip.destination_name,
      apiKey: process.env.GOOGLE_MAPS_API_KEY ?? "",
    }).catch(() => [] as PlaceCandidate[]);

  const verifiedCandidates = placeCandidates.filter(
    (candidate) => haversineKm(base, candidate) <= radiusKm,
  );
  const places = toConciergePlaces(verifiedCandidates);
  const context: ConciergeContext = {
    destinationName: auth.trip.destination_name,
    startDate: auth.trip.start_date,
    endDate: auth.trip.end_date,
    budgetLevel: auth.trip.budget_level,
    vibeNote: auth.trip.vibe_note,
    travelers: (travelersResult.data ?? []).map((traveler) => ({
      interests: traveler.interests as string[],
      pace: traveler.pace as string,
      dietary: traveler.dietary as string,
      constraintsNote: (traveler.constraints_note as string) ?? "",
    })),
    itinerary: itineraryRows.map((row) => {
      const venue = row.venue_candidates;
      return {
        dayIndex: row.day_index,
        date: tripDateForDayIndex(auth.trip.start_date, row.day_index),
        block: row.block,
        status: (row.status ?? "planned") as string,
        name: venue?.name ?? "Unknown stop",
        area: venue?.area ?? "",
      };
    }),
    suggestions: (suggestionsResult.data ?? []).map((suggestion) => suggestion.text as string),
  };

  const messages: ModelMessage[] = conversationForModel(parsed.data.messages).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  try {
    const answer = await askConcierge({
      instructions: buildConciergeInstructions(context, places),
      messages,
    });
    return NextResponse.json({
      answer,
      places,
      itineraryMatches: finder.matches,
      model: "deepseek-v4-flash:cloud",
    });
  } catch {
    return NextResponse.json(
      { error: "The concierge could not answer right now. Please try again." },
      { status: 502 },
    );
  }
}

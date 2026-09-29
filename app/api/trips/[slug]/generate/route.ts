import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount, type TravelerRow } from "@/lib/auth";
import { buildCategoryQueries, searchPlaces, filterByRating, venueRowToCandidate, type PlaceCandidate } from "@/lib/places";
import { getCallers } from "@/lib/llm";
import { arrangePlan, travelWarnings, planTimeoutMs } from "@/lib/generate";
import { haversineKm } from "@/lib/geo";
import { proposeAreas } from "@/lib/areas";
import { mergeCandidateCategories, missingCategories } from "@/lib/venue-cache";
import { broadcastTripUpdate } from "@/lib/realtime";
import { replaceTripItinerary } from "@/lib/persistence";
import type { TravelerPrefs, TripSuggestion } from "@/lib/schema";

export const maxDuration = 300; // generation: Places + up to 3 LLM attempts

/**
 * Venue lookup and model arrangement are split across two requests so neither one
 * approaches the platform's function time limit. A cold trip returns after caching
 * venues; the client immediately calls again to build the plan against that cache.
 */
/** The function's own ceiling; a retry must fit inside what remains of it. */
const FUNCTION_BUDGET_MS = 300_000;
/** Room to persist the plan and broadcast after the model returns. */
const PERSIST_MARGIN_MS = 20_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { slug } = await params;
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const db = serviceClient();
  const auth = await authTraveler(db, slug, body.token ?? "");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;
  if (!me.is_organizer) {
    return NextResponse.json({ error: "Only the organizer can generate the plan" }, { status: 403 });
  }

  const { data: progressRows, error: progressError } = await db
    .from("itinerary_items")
    .select("id, status, is_locked")
    .eq("trip_id", trip.id);
  if (progressError) return NextResponse.json({ error: "Could not read itinerary progress" }, { status: 503 });
  if ((progressRows ?? []).some((item) => item.status !== "planned" || item.is_locked)) {
    return NextResponse.json({
      error: "This trip already has completed, skipped, or locked activities. Use Smart reshuffle so its history is preserved.",
    }, { status: 409 });
  }

  const { data: travelerRows } = await db.from("travelers").select("*").eq("trip_id", trip.id);
  const travelers: TravelerPrefs[] = ((travelerRows ?? []) as TravelerRow[]).map((t) => ({
    displayName: t.display_name, interests: t.interests, pace: t.pace,
    dietary: t.dietary, constraintsNote: t.constraints_note,
  }));

  // 1) Candidates: reuse the cache, but top it up for anyone who joined later
  //    with an interest the pool was never built for.
  const [candidateResult, searchResult, suggestionResult] = await Promise.all([
    db
      .from("venue_candidates")
      .select("*, venue_candidate_categories(category)")
      .eq("trip_id", trip.id),
    db.from("trip_venue_searches").select("category").eq("trip_id", trip.id),
    db
      .from("trip_suggestions")
      .select("id, text, searched_at, travelers(display_name)")
      .eq("trip_id", trip.id)
      .order("created_at"),
  ]);
  if (candidateResult.error || searchResult.error || suggestionResult.error) {
    return NextResponse.json({ error: "Could not read the venue cache" }, { status: 503 });
  }
  const candRows = candidateResult.data ?? [];
  const suggestionRows = suggestionResult.data ?? [];
  const suggestions: TripSuggestion[] = suggestionRows.map((suggestion) => {
    const author = suggestion.travelers as unknown as { display_name: string } | null;
    return { displayName: author?.display_name ?? "Traveller", text: suggestion.text as string };
  });
  const pendingSuggestions = suggestionRows.filter((suggestion) => suggestion.searched_at === null);
  const wanted = buildCategoryQueries(
    travelers.flatMap((t) => t.interests),
    travelers.map((t) => t.dietary),
  );
  const gaps = missingCategories(
    wanted.map((q) => q.category),
    (searchResult.data ?? []).map((r) => r.category as string),
  );
  const needsHoursRefresh = candRows.some((row) => row.opening_periods === null);
  if (candRows.length === 0 || gaps.length > 0 || needsHoursRefresh || pendingSuggestions.length > 0) {
    // A legacy-hours refresh refetches the full pool once. Normal top-ups fetch
    // only unseen categories, while the search ledger prevents empty-result loops.
    const queries = needsHoursRefresh ? wanted : wanted.filter((q) => gaps.includes(q.category));
    const apiKey = process.env.GOOGLE_MAPS_API_KEY!;
    const radiusKm = trip.explore_radius_km ?? 15;

    // Beyond a city radius, Google's bias just returns more of the same place.
    // Ask the model which towns are worth a day out, then search inside each.
    const base = { name: trip.destination_name, lat: trip.lat, lng: trip.lng };
    const areas =
      radiusKm > 15
        ? await proposeAreas({
            base,
            radiusKm,
            interests: travelers.flatMap((t) => t.interests),
            callers: getCallers(),
            dayCount: dayCount(trip.start_date, trip.end_date),
            // Every suggestion, not just the unsearched ones: a town the group
            // asked for should stay a day trip across later top-ups, which
            // re-propose the areas from scratch.
            requests: suggestions.map((suggestion) => suggestion.text),
          })
        : [{ name: base.name, lat: base.lat, lng: base.lng, why: "" }];

    // A request that became a place to go is not also a venue to find. Searching
    // it as one is what produced a the destination boutique called "APM Monaco the destination"
    // for a group that wanted Monaco.
    const requestsBecameAreas = new Set(
      areas.map((area) => area.request).filter((request): request is string => request !== undefined),
    );

    // Each area gets its own slice of the radius so results stay inside it.
    const perAreaRadiusKm = areas.length > 1 ? Math.min(20, radiusKm) : radiusKm;
    let fetched: PlaceCandidate[] = [];
    try {
      for (const area of areas) {
        for (const q of queries) {
          const results = await searchPlaces({
            query: `${q.query} in ${area.name}`,
            category: q.category,
            lat: area.lat,
            lng: area.lng,
            radiusKm: perAreaRadiusKm,
            area: area.name,
            apiKey,
          });
          fetched = fetched.concat(filterByRating(results));
        }
      }

      // A member may name a specific venue or describe the kind of stop they
      // want. Search each new idea once and keep the closest useful results.
      for (const suggestion of pendingSuggestions) {
        if (requestsBecameAreas.has(suggestion.text)) continue;
        const results = await searchPlaces({
          query: `${suggestion.text} near ${trip.destination_name}`,
          category: "suggestion",
          lat: base.lat,
          lng: base.lng,
          radiusKm,
          apiKey,
        });
        const nearby = results
          .filter((candidate) => haversineKm(base, candidate) <= radiusKm)
          .slice(0, 5)
          .map((candidate) => {
            const area = areas.reduce((closest, current) =>
              haversineKm(current, candidate) < haversineKm(closest, candidate) ? current : closest,
            );
            return { ...candidate, area: area.name };
          });
        fetched = fetched.concat(nearby);
      }
    } catch (e) {
      return NextResponse.json({ error: `Venue lookup failed: ${(e as Error).message}` }, { status: 502 });
    }
    const merged = mergeCandidateCategories(fetched);
    if (merged.length > 0) {
      const { data: saved, error: insertErr } = await db.from("venue_candidates").upsert(
        merged.map(({ candidate: c }) => ({
          trip_id: trip.id, place_id: c.placeId, name: c.name, category: c.category,
          rating: c.rating, review_count: c.reviewCount, price_level: c.priceLevel,
          opening_hours: c.openingHours, opening_periods: c.openingPeriods,
          lat: c.lat, lng: c.lng, maps_url: c.mapsUrl,
          area: c.area ?? "", distance_km: haversineKm(base, c),
        })),
        { onConflict: "trip_id,place_id" },
      ).select("id, place_id");
      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

      const idByPlace = new Map((saved ?? []).map((row) => [row.place_id as string, row.id as string]));
      const categoryRows = merged.flatMap(({ candidate, categories }) => {
        const candidateId = idByPlace.get(candidate.placeId);
        return candidateId ? categories.map((category) => ({ candidate_id: candidateId, category })) : [];
      });
      if (categoryRows.length > 0) {
        const { error: categoryErr } = await db
          .from("venue_candidate_categories")
          .upsert(categoryRows, { onConflict: "candidate_id,category" });
        if (categoryErr) return NextResponse.json({ error: categoryErr.message }, { status: 500 });
      }
    }

    if (queries.length > 0) {
      const { error: searchErr } = await db.from("trip_venue_searches").upsert(
        queries.map((query) => ({ trip_id: trip.id, category: query.category, searched_at: new Date().toISOString() })),
        { onConflict: "trip_id,category" },
      );
      if (searchErr) return NextResponse.json({ error: searchErr.message }, { status: 500 });
    }

    if (pendingSuggestions.length > 0) {
      const { error: suggestionErr } = await db
        .from("trip_suggestions")
        .update({ searched_at: new Date().toISOString() })
        .in("id", pendingSuggestions.map((suggestion) => suggestion.id));
      if (suggestionErr) return NextResponse.json({ error: suggestionErr.message }, { status: 500 });
    }

    if (needsHoursRefresh) {
      const { error: cleanupErr } = await db
        .from("venue_candidates")
        .delete()
        .eq("trip_id", trip.id)
        .is("opening_periods", null);
      if (cleanupErr) return NextResponse.json({ error: cleanupErr.message }, { status: 500 });
    }
    // Stop here: the venues are cached, so the follow-up request spends its whole
    // budget on the model instead of racing the clock with lookup already done.
    return NextResponse.json({ stage: "venues", candidates: merged.length });
  }

  // 2) Arrange. candidateId given to the LLM = venue_candidates.id (row uuid).
  const candidates: PlaceCandidate[] = candRows
    .map(venueRowToCandidate)
    .filter((candidate) => candidate.openingPeriods.length > 0);
  const requiredCandidateCount = dayCount(trip.start_date, trip.end_date) * 4;
  if (candidates.length < Math.max(8, requiredCandidateCount)) {
    return NextResponse.json({
      error: "Not enough venues with opening hours found for this destination and trip length",
    }, { status: 502 });
  }
  const tripMeta = {
    destinationName: trip.destination_name, startDate: trip.start_date, endDate: trip.end_date,
    budgetLevel: trip.budget_level, vibeNote: trip.vibe_note,
    dayCount: dayCount(trip.start_date, trip.end_date),
  };
  const attemptMs = planTimeoutMs(tripMeta.dayCount);
  let plan, usedFallback;
  try {
    ({ plan, usedFallback } = await arrangePlan({
      trip: tripMeta,
      travelers,
      candidates,
      suggestions,
      callers: getCallers(attemptMs),
      makeCallers: getCallers,
      // All the model time this function has, less what persisting the result
      // needs. arrangePlan divides it so the fallback always keeps a slot.
      budget: { endsAt: startedAt + FUNCTION_BUDGET_MS - PERSIST_MARGIN_MS, attemptMs },
    }));
  } catch (e) {
    // Logged, not just returned. Returning the reason only in the response body
    // means a failure that the browser swallows leaves nothing behind at all —
    // production showed zero runtime errors while generation failed repeatedly,
    // because the one place the reason existed was a 502 body nobody read.
    console.error(
      `[generate] plan failed for trip ${slug}: ${(e as Error).message} ` +
        `(days=${tripMeta.dayCount}, candidates=${candidates.length}, ` +
        `travellers=${travelers.length}, elapsedMs=${Date.now() - startedAt})`,
    );
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // 3) Persist: replace previous items, flag travel warnings.
  const byId = new Map(candidates.map((c) => [c.placeId, c]));
  const warned = travelWarnings(plan, byId);
  const rows = plan.days.flatMap((day) =>
    day.blocks.map((b, i) => ({
      trip_id: trip.id, day_index: day.dayIndex, block: b.block, candidate_id: b.candidateId,
      why_note: b.whyNote, duration_min: b.durationMin, position: i,
      travel_warning: warned.has(b.candidateId), area: day.area ?? "",
    })),
  );
  try {
    await replaceTripItinerary(db, trip.id, rows);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({ usedFallback });
}

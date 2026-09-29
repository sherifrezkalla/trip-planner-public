import { NextResponse } from "next/server";
import { authTraveler, dayCount } from "@/lib/auth";
import { getTripTiming } from "@/lib/today";
import { serviceClient } from "@/lib/db";
import { canManageSchedule } from "@/lib/permissions";
import { broadcastTripUpdate } from "@/lib/realtime";
import {
  applyAdjustToday,
  abandonAdjustTodayPreview,
  recordAdjustTodayPreview,
} from "@/lib/persistence";
import {
  buildAdjustTodayPreview,
  fingerprintPreview,
  parseAdjustIntent,
  type AdjustItem,
} from "@/lib/adjust-today";
import { adjustTodayRequestSchema } from "@/lib/schema";

export const maxDuration = 30;

function errorStatus(message: string): number {
  return /organizer|authorized/i.test(message) ? 403
    : /stale|settled|duplicate|occupied|protected|changed|invalid/i.test(message) ? 409
      : 500;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = adjustTodayRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid adjust-today request" }, { status: 400 });
  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const gate = canManageSchedule({ actorIsOrganizer: auth.me.is_organizer });
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  if (parsed.data.action === "abandon") {
    try {
      await abandonAdjustTodayPreview(db, {
        tripId: auth.trip.id, actorId: auth.me.id, previewId: parsed.data.previewId,
      });
    } catch (error) {
      const message = (error as Error).message;
      return NextResponse.json({ error: message }, { status: errorStatus(message) });
    }
    return NextResponse.json({});
  }

  if (parsed.data.action === "apply") {
    try {
      const revisionId = await applyAdjustToday(db, {
        tripId: auth.trip.id,
        actorId: auth.me.id,
        previewId: parsed.data.previewId,
        fingerprint: parsed.data.fingerprint,
        reason: parsed.data.reason,
        moves: parsed.data.moves,
        skips: parsed.data.skips,
        swaps: parsed.data.swaps,
      });
      await broadcastTripUpdate(slug).catch(() => {});
      return NextResponse.json({ revisionId });
    } catch (error) {
      const message = (error as Error).message;
      return NextResponse.json({
        error: /stale|settled|changed|occupied|protected/i.test(message)
          ? "This preview is stale. Review today's plan again before applying."
          : "Could not apply today's adjustment; no changes were saved.",
      }, { status: errorStatus(message) });
    }
  }

  if (parsed.data.action !== "preview") {
    return NextResponse.json({ error: "Invalid adjust-today action" }, { status: 400 });
  }
  const previewRequest = parsed.data;
  if (previewRequest.dayIndex >= dayCount(auth.trip.start_date, auth.trip.end_date)) {
    return NextResponse.json({ error: "That day is outside this trip" }, { status: 400 });
  }
  if (previewRequest.dayIndex !== getTripTiming(auth.trip.start_date, auth.trip.end_date).dayIndex) {
    return NextResponse.json({ error: "Adjust today is available only for the current trip day" }, { status: 400 });
  }

  const [{ data: rows, error: itemError }, { data: candidates, error: candidateError }] = await Promise.all([
    db.from("itinerary_items")
      .select("id, day_index, block, position, status, is_locked, reservation_status, duration_min, candidate_id, area, venue_candidates(name, opening_periods, lat, lng, venue_candidate_categories(category))")
      .eq("trip_id", auth.trip.id).order("day_index").order("position"),
    db.from("venue_candidates")
      .select("id, name, category, rating, review_count, price_level, opening_hours, opening_periods, lat, lng, maps_url, area, distance_km, venue_candidate_categories(category)")
      .eq("trip_id", auth.trip.id),
  ]);
  if (itemError || candidateError) return NextResponse.json({ error: "Could not read grounded trip data" }, { status: 503 });

  const pool = (candidates ?? []).map((row) => ({
    placeId: row.id as string, name: row.name as string, category: row.category as string,
    categories: ((row.venue_candidate_categories ?? []) as { category: string }[]).map((v) => v.category).length > 0
      ? ((row.venue_candidate_categories ?? []) as { category: string }[]).map((v) => v.category)
      : [row.category as string],
    rating: row.rating as number | null, reviewCount: row.review_count as number,
    priceLevel: row.price_level as string | null, openingHours: (row.opening_hours ?? []) as string[],
    openingPeriods: (row.opening_periods ?? []) as never, lat: row.lat as number, lng: row.lng as number,
    mapsUrl: row.maps_url as string, area: (row.area ?? "") as string, distanceKm: row.distance_km as number,
  }));
  const candidateById = new Map(pool.map((candidate) => [candidate.placeId, candidate]));
  const items: AdjustItem[] = (rows ?? []).map((row) => {
    const venue = row.venue_candidates as unknown as {
      name: string;
      opening_periods: unknown;
      lat?: number;
      lng?: number;
      venue_candidate_categories?: { category: string }[] | null;
    } | null;
    const candidate = candidateById.get(row.candidate_id as string);
    const venueCategories = (venue?.venue_candidate_categories ?? []).map((entry) => entry.category);
    return {
      id: row.id as string, dayIndex: row.day_index as number, block: row.block as AdjustItem["block"],
      position: row.position as number, status: (row.status ?? "planned") as AdjustItem["status"],
      isLocked: Boolean(row.is_locked), reservationLocked: ["tentative", "confirmed"].includes(row.reservation_status as string),
      venueName: venue?.name ?? "Activity", durationMin: row.duration_min as number,
      openingPeriods: (venue?.opening_periods ?? []) as never, lat: venue?.lat ?? candidate?.lat, lng: venue?.lng ?? candidate?.lng,
      categories: venueCategories.length > 0 ? venueCategories : candidate?.categories ?? [],
      area: (row.area ?? candidate?.area ?? "") as string, candidateId: row.candidate_id as string,
    };
  });
  const intent = parseAdjustIntent(previewRequest.reason);
  const preview = buildAdjustTodayPreview({
    dayIndex: previewRequest.dayIndex, items, pool, startDate: auth.trip.start_date,
    dayCount: dayCount(auth.trip.start_date, auth.trip.end_date), reason: previewRequest.reason, intent,
  });
  const fingerprint = fingerprintPreview(preview);
  if (preview.impact.conflicts.length > 0) return NextResponse.json({ ...preview, fingerprint, parsed: intent.parsed, previewId: null });
  if (!preview.hasChanges) return NextResponse.json({ ...preview, fingerprint, parsed: intent.parsed, previewId: null });
  try {
    const previewId = await recordAdjustTodayPreview(db, {
      tripId: auth.trip.id, actorId: auth.me.id, dayIndex: previewRequest.dayIndex,
      reason: previewRequest.reason, fingerprint, snapshot: items.filter((i) => i.dayIndex === previewRequest.dayIndex), preview,
    });
    return NextResponse.json({ ...preview, fingerprint, parsed: intent.parsed, previewId });
  } catch {
    return NextResponse.json({ error: "Could not save the preview" }, { status: 503 });
  }
}

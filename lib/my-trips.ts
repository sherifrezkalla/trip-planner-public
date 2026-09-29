import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeviceTrip } from "./device-trips";

export type TripSummary = {
  slug: string;
  title: string;
  destinationName: string;
  startDate: string;
  endDate: string;
  travelerCount: number;
  itemCount: number;
  isOrganizer: boolean;
};

export type MyTrips = { trips: TripSummary[]; unavailable: string[] };

type TripRow = {
  id: string; slug: string; title: string; destination_name: string;
  start_date: string; end_date: string;
};
type TravelerRow = { trip_id: string; token: string; is_organizer: boolean };

function unwrap<T>(result: { data: T[] | null; error: { message: string } | null }, what: string): T[] {
  if (result.error) throw new Error(`Could not load ${what}: ${result.error.message}`);
  return result.data ?? [];
}

function countBy(rows: { trip_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.trip_id, (counts.get(row.trip_id) ?? 0) + 1);
  return counts;
}

/**
 * Resolves (slug, token) pairs held by a browser into trip summaries.
 *
 * A pair only resolves when the token belongs to that exact trip. A slug that is
 * unknown and a slug whose token does not match are both reported the same way,
 * so this cannot be used to discover whether a slug exists.
 *
 * Runs a fixed four queries regardless of how many trips are requested.
 */
export async function summarizeTrips(
  db: SupabaseClient,
  entries: DeviceTrip[],
): Promise<MyTrips> {
  if (entries.length === 0) return { trips: [], unavailable: [] };

  const slugs = entries.map((e) => e.slug);
  const tokens = entries.map((e) => e.token);

  const trips = unwrap<TripRow>(
    await db.from("trips").select("id, slug, title, destination_name, start_date, end_date").in("slug", slugs),
    "trips",
  );
  const travelers = unwrap<TravelerRow>(
    await db.from("travelers").select("trip_id, token, is_organizer").in("token", tokens),
    "travelers",
  );

  const tripIds = trips.map((t) => t.id);
  const allTravelers = tripIds.length
    ? unwrap<{ trip_id: string }>(
        await db.from("travelers").select("trip_id").in("trip_id", tripIds),
        "travelers",
      )
    : [];
  const allItems = tripIds.length
    ? unwrap<{ trip_id: string }>(
        await db.from("itinerary_items").select("trip_id").in("trip_id", tripIds),
        "itinerary items",
      )
    : [];

  const tripBySlug = new Map(trips.map((t) => [t.slug, t]));
  const travelerByToken = new Map(travelers.map((t) => [t.token, t]));
  const travelerCounts = countBy(allTravelers);
  const itemCounts = countBy(allItems);

  const summaries: TripSummary[] = [];
  const unavailable: string[] = [];

  for (const entry of entries) {
    const trip = tripBySlug.get(entry.slug);
    const traveler = travelerByToken.get(entry.token);
    if (!trip || !traveler || traveler.trip_id !== trip.id) {
      unavailable.push(entry.slug);
      continue;
    }
    summaries.push({
      slug: trip.slug,
      title: trip.title ?? "",
      destinationName: trip.destination_name,
      startDate: trip.start_date,
      endDate: trip.end_date,
      travelerCount: travelerCounts.get(trip.id) ?? 0,
      itemCount: itemCounts.get(trip.id) ?? 0,
      isOrganizer: traveler.is_organizer,
    });
  }

  return { trips: summaries, unavailable };
}

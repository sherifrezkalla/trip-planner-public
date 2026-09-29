import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeTrips } from "@/lib/my-trips";

type Rows = { data: unknown[] | null; error: { message: string } | null };

/**
 * summarizeTrips issues one `.select(...).in(...)` per table, so the stub only
 * needs to answer per table name and record what it was asked for.
 */
function stubDb(tables: Record<string, Rows>) {
  const calls: string[] = [];
  const db = {
    from: (table: string) => {
      calls.push(table);
      return {
        select: () => ({
          in: async () => tables[table] ?? { data: [], error: null },
        }),
      };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const TRIP = {
  id: "trip-1", slug: "abc", title: "Familienurlaub", destination_name: "Tiranë",
  start_date: "2026-08-10", end_date: "2026-08-16",
};
const OTHER_TRIP = {
  id: "trip-2", slug: "def", title: "", destination_name: "Lisbon",
  start_date: "2026-09-10", end_date: "2026-09-12",
};

describe("summarizeTrips", () => {
  it("summarizes a trip when the token belongs to it", async () => {
    const { db } = stubDb({
      trips: { data: [TRIP], error: null },
      travelers: {
        data: [
          { trip_id: "trip-1", token: "tok-a", is_organizer: true },
          { trip_id: "trip-1", token: "tok-b", is_organizer: false },
        ],
        error: null,
      },
      itinerary_items: {
        data: [{ trip_id: "trip-1" }, { trip_id: "trip-1" }, { trip_id: "trip-1" }],
        error: null,
      },
    });

    const result = await summarizeTrips(db, [{ slug: "abc", token: "tok-a" }]);

    expect(result.unavailable).toEqual([]);
    expect(result.trips).toEqual([
      {
        slug: "abc",
        title: "Familienurlaub",
        destinationName: "Tiranë",
        startDate: "2026-08-10",
        endDate: "2026-08-16",
        travelerCount: 2,
        itemCount: 3,
        isOrganizer: true,
      },
    ]);
  });

  it("reports a trip as unavailable when the token belongs to a different trip", async () => {
    const { db } = stubDb({
      trips: { data: [TRIP], error: null },
      // The token is real, but it is a traveler on trip-2, not the requested trip-1.
      travelers: { data: [{ trip_id: "trip-2", token: "tok-x", is_organizer: false }], error: null },
      itinerary_items: { data: [], error: null },
    });

    const result = await summarizeTrips(db, [{ slug: "abc", token: "tok-x" }]);

    expect(result.trips).toEqual([]);
    expect(result.unavailable).toEqual(["abc"]);
  });

  it("reports a trip as unavailable when it no longer exists", async () => {
    const { db } = stubDb({
      trips: { data: [], error: null },
      travelers: { data: [], error: null },
      itinerary_items: { data: [], error: null },
    });

    const result = await summarizeTrips(db, [{ slug: "gone", token: "tok-a" }]);

    expect(result.trips).toEqual([]);
    expect(result.unavailable).toEqual(["gone"]);
  });

  it("splits a mixed batch into available and unavailable", async () => {
    const { db } = stubDb({
      trips: { data: [TRIP, OTHER_TRIP], error: null },
      travelers: {
        data: [
          { trip_id: "trip-1", token: "tok-a", is_organizer: true },
          { trip_id: "trip-2", token: "tok-c", is_organizer: false },
        ],
        error: null,
      },
      itinerary_items: { data: [{ trip_id: "trip-2" }], error: null },
    });

    const result = await summarizeTrips(db, [
      { slug: "abc", token: "tok-a" },
      { slug: "def", token: "tok-c" },
      { slug: "ghost", token: "tok-z" },
    ]);

    expect(result.trips.map((t) => t.slug)).toEqual(["abc", "def"]);
    expect(result.trips.find((t) => t.slug === "abc")?.itemCount).toBe(0);
    expect(result.trips.find((t) => t.slug === "def")?.itemCount).toBe(1);
    expect(result.unavailable).toEqual(["ghost"]);
  });

  it("returns empty results without querying when there are no entries", async () => {
    const { db, calls } = stubDb({});
    const result = await summarizeTrips(db, []);
    expect(result).toEqual({ trips: [], unavailable: [] });
    expect(calls).toEqual([]);
  });

  it("throws when the database is unreachable so the route can answer 503", async () => {
    const { db } = stubDb({
      trips: { data: null, error: { message: "connection timeout" } },
      travelers: { data: [], error: null },
      itinerary_items: { data: [], error: null },
    });

    await expect(summarizeTrips(db, [{ slug: "abc", token: "tok-a" }])).rejects.toThrow(
      /connection timeout/,
    );
  });
});

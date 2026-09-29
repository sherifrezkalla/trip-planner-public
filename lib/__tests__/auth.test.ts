import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authTraveler, dayCount } from "@/lib/auth";

type SingleResult = { data: unknown; error: { code?: string; message: string } | null };

/** Minimal chainable stub of the query builder authTraveler uses. */
function stubDb(results: SingleResult[]): SupabaseClient {
  let call = 0;
  const builder = {
    select: () => builder,
    eq: () => builder,
    single: async () => results[call++] ?? { data: null, error: null },
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const TRIP = { id: "t1", slug: "abc", destination_name: "Lisbon" };
const ME = { id: "m1", trip_id: "t1", token: "tok", is_organizer: true };

describe("authTraveler", () => {
  it("returns trip and traveler when both are found", async () => {
    const db = stubDb([
      { data: TRIP, error: null },
      { data: ME, error: null },
    ]);
    const result = await authTraveler(db, "abc", "tok");
    expect(result).toMatchObject({ trip: { id: "t1" }, me: { id: "m1" } });
  });

  it("returns 404 when the trip genuinely does not exist", async () => {
    // PostgREST reports "no rows returned" for .single() as PGRST116.
    const db = stubDb([{ data: null, error: { code: "PGRST116", message: "no rows" } }]);
    const result = await authTraveler(db, "nope", "tok");
    expect(result).toEqual({ status: 404, error: "Trip not found" });
  });

  it("returns 503 — not 404 — when the database is unreachable", async () => {
    const db = stubDb([
      { data: null, error: { message: "Connection terminated due to connection timeout" } },
    ]);
    const result = await authTraveler(db, "abc", "tok");
    expect(result).toMatchObject({ status: 503 });
    if ("error" in result) expect(result.error).toMatch(/temporarily/i);
  });

  it("returns 401 when the trip exists but the token is wrong", async () => {
    const db = stubDb([
      { data: TRIP, error: null },
      { data: null, error: { code: "PGRST116", message: "no rows" } },
    ]);
    const result = await authTraveler(db, "abc", "wrong");
    expect(result).toEqual({ status: 401, error: "Invalid traveler token" });
  });

  it("returns 503 when the traveler lookup hits a database error", async () => {
    const db = stubDb([
      { data: TRIP, error: null },
      { data: null, error: { message: "connection reset" } },
    ]);
    const result = await authTraveler(db, "abc", "tok");
    expect(result).toMatchObject({ status: 503 });
  });
});

describe("dayCount", () => {
  it("counts both endpoints", () => {
    expect(dayCount("2026-09-10", "2026-09-12")).toBe(3);
    expect(dayCount("2026-08-07", "2026-08-19")).toBe(13);
    expect(dayCount("2026-09-10", "2026-09-10")).toBe(1);
  });
});

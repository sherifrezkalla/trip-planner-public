import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), auth: vi.fn() }));

vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, authTraveler: mocks.auth };
});

import { GET } from "@/app/api/trips/[slug]/route";

/** Every read the board makes, and what a healthy one returns. */
const TABLES = ["travelers", "itinerary_items", "trip_suggestions", "plan_proposals"] as const;
type Table = (typeof TABLES)[number];

/**
 * A thenable query builder: every chained method returns itself, and awaiting it
 * resolves to whatever the table was configured to answer.
 */
function builder(result: { data: unknown; error: { message: string } | null }) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "in"]) {
    query[method] = () => query;
  }
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return query;
}

function boardWhere(failing: Partial<Record<Table, string>>) {
  return {
    from: (table: string) => builder(
      failing[table as Table]
        ? { data: null, error: { message: failing[table as Table]! } }
        : { data: [], error: null },
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    trip: {
      id: "trip-1", slug: "example-coast", title: "Example Coast", destination_name: "Example Coast",
      start_date: "2026-09-01", end_date: "2026-09-07", budget_level: "mid",
      vibe_note: "", lat: 43.55, lng: 7.01,
    },
    me: { id: "me", is_organizer: true },
  });
});

const params = Promise.resolve({ slug: "example-coast" });
const request = new Request("https://trip-planner.test/api/trips/example-coast?token=t");

/**
 * A read that failed is not a trip with nothing in it.
 *
 * All four reads destructured only `data`, so a failure arrived as `null`, fell
 * through `?? []`, and rendered as an empty board with a 200. A database outage
 * and a brand-new trip produced the same response, on the surface that is the
 * whole product.
 */
describe("GET /api/trips/[slug] when a read fails", () => {
  it("serves the board when every read succeeds", async () => {
    mocks.client.mockReturnValue(boardWhere({}));

    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ trip: { slug: "example-coast" } });
  });

  it.each(TABLES)("reports a failed %s read instead of an empty board", async (table) => {
    mocks.client.mockReturnValue(boardWhere({ [table]: "connection reset" }));

    const response = await GET(request, { params });
    const payload = await response.json() as { error: string; detail: string; items?: unknown };

    expect(response.status).toBe(500);
    expect(payload.detail).toContain("connection reset");
    expect(payload.items).toBeUndefined();
  });

  it("names every failed read, not only the first", async () => {
    mocks.client.mockReturnValue(boardWhere({
      travelers: "travellers down",
      plan_proposals: "proposals down",
    }));

    const response = await GET(request, { params });
    const payload = await response.json() as { error: string; detail: string };

    expect(response.status).toBe(500);
    expect(payload.error).toContain("travellers");
    expect(payload.error).toContain("proposals");
    expect(payload.detail).toContain("travellers down");
    expect(payload.detail).toContain("proposals down");
  });
});

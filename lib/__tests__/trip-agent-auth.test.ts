import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// `server-only` is a Next compiler boundary; Vitest is not compiling a Server
// Component, so replace its intentional client-side throw while testing server behavior.
vi.mock("server-only", () => ({}));

import {
  authTripAgent,
  bearerCredentialFrom,
  digestExternalIdentity,
  digestTripAgentSecret,
  generateTripAgentSecret,
} from "@/lib/trip-agent-auth";

const originalPepper = process.env.TRIP_AGENT_IDENTITY_PEPPER;

afterEach(() => {
  if (originalPepper === undefined) delete process.env.TRIP_AGENT_IDENTITY_PEPPER;
  else process.env.TRIP_AGENT_IDENTITY_PEPPER = originalPepper;
});

function connection(status: "paired" | "active" | "paused" | "revoked" | "archived") {
  return {
    id: "connection-1",
    trip_id: "trip-1",
    status,
    lifecycle_generation: 3,
    granted_scopes: ["connector.setup"],
    whatsapp_group_digest: "group-digest",
    trip: { id: "trip-1", slug: "rome" },
  };
}

function database(row: ReturnType<typeof connection> | null, error: { code?: string } | null = null) {
  const lookup = {
    select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(),
  };
  lookup.select.mockReturnValue(lookup);
  lookup.eq.mockReturnValue(lookup);
  lookup.maybeSingle.mockResolvedValue({ data: row, error });

  const touch = { update: vi.fn(), eq: vi.fn(), then: vi.fn() };
  touch.update.mockReturnValue(touch);
  touch.eq.mockReturnValue(touch);
  touch.then.mockImplementation((resolve) => Promise.resolve({ error: null }).then(resolve));

  const from = vi.fn()
    .mockReturnValueOnce(lookup)
    .mockReturnValueOnce(touch);
  return { db: { from } as unknown as SupabaseClient, from, lookup, touch };
}

describe("trip-agent credentials", () => {
  it.each([
    "a".repeat(42), "a".repeat(44), "a".repeat(42) + "=", "a".repeat(42) + "+",
    "a".repeat(42) + "/", "a".repeat(42) + ".", "a".repeat(42) + "é",
    " " + "a".repeat(43), "a".repeat(43) + " ", "a".repeat(20) + " " + "a".repeat(22),
    "a".repeat(43) + ", " + "b".repeat(43),
    ...["\n", "\r", "\r\n", "\u2028", "\u2029", "\t"].map(suffix => "a".repeat(43) + suffix),
  ])("rejects malformed generated credentials before database lookup", async credential => {
    const { db, from } = database(connection("active"));
    // A native Headers constructor trims surrounding OWS; test the exact value
    // seen by the parser without normalizing the malformed header fixture.
    const request = { headers: { get: () => `Bearer ${credential}` } } as unknown as Request;
    expect(await authTripAgent(db, request)).toEqual({ status: 401, error: "Invalid trip-agent credential" });
    expect(from).not.toHaveBeenCalled();
  });
  it("generates a 32-byte base64url secret", () => {
    const secret = generateTripAgentSecret();

    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a stable SHA-256 credential digest", () => {
    expect(digestTripAgentSecret("credential")).toBe(
      "e265b6f564601a1fe8dc42785cd18a868bd8013eb5899560e79248767a683e6b",
    );
  });

  it("HMAC-separates an external identity by connection", () => {
    process.env.TRIP_AGENT_IDENTITY_PEPPER = "test-pepper";

    expect(digestExternalIdentity("connection-a", 1, "person-7"))
      .not.toBe(digestExternalIdentity("connection-b", 1, "person-7"));
    expect(digestExternalIdentity("connection-a", 1, "person-7"))
      .toBe(digestExternalIdentity("connection-a", 1, "person-7"));
  });

  it("HMAC-separates the same provider identity across lifecycle generations", () => {
    process.env.TRIP_AGENT_IDENTITY_PEPPER = "test-pepper";

    expect(digestExternalIdentity("connection-a", 1, "person-7"))
      .not.toBe(digestExternalIdentity("connection-a", 2, "person-7"));
  });

  it("refuses identity hashing without a configured pepper", () => {
    delete process.env.TRIP_AGENT_IDENTITY_PEPPER;

    expect(() => digestExternalIdentity("connection-a", 1, "person-7"))
      .toThrow("TRIP_AGENT_IDENTITY_PEPPER");
  });

  it("accepts only the exact case-sensitive Bearer authorization scheme", () => {
    expect(bearerCredentialFrom(new Request("https://trip.test", {
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    }))).toBe("a".repeat(43));
    for (const authorization of [
      undefined,
      "bearer credential",
      "BEARER credential",
      "Bearer",
      "Bearer  ",
      "Bearer credential another",
    ]) {
      expect(bearerCredentialFrom(new Request("https://trip.test", {
        headers: authorization ? { authorization } : undefined,
      }))).toBe("");
    }
  });

  it("refuses missing or malformed authorization without querying a digest", async () => {
    const { db, from } = database(connection("active"));

    const missing = await authTripAgent(db, new Request("https://trip.test"));
    const malformed = await authTripAgent(db, new Request("https://trip.test", {
      headers: { authorization: "bearer credential" },
    }));

    expect(missing).toEqual({ status: 401, error: "Invalid trip-agent credential" });
    expect(malformed).toEqual(missing);
    expect(from).not.toHaveBeenCalled();
  });

  it("authenticates an active connection and records a best-effort last-seen timestamp", async () => {
    const { db, lookup, touch } = database(connection("active"));

    const result = await authTripAgent(db, new Request("https://trip.test", {
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    }));

    expect(result).toMatchObject({
      connection: {
        id: "connection-1",
        lifecycleGeneration: 3,
        status: "active",
        grantedScopes: ["connector.setup"],
        whatsappGroupDigest: "group-digest",
      },
      trip: { id: "trip-1", slug: "rome" },
    });
    expect(lookup.eq).toHaveBeenCalledWith("credential_digest", digestTripAgentSecret("a".repeat(43)));
    expect(touch.update).toHaveBeenCalledWith({ last_seen_at: expect.any(String) });
    expect(touch.eq).toHaveBeenCalledWith("lifecycle_generation", 3);
  });

  it("does not wait for a last-seen update that never settles", async () => {
    const { db, touch } = database(connection("active"));
    touch.then.mockImplementationOnce(() => new Promise(() => {}));

    const result = await Promise.race([
      authTripAgent(db, new Request("https://trip.test", {
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
      })),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("auth waited for telemetry")), 25);
      }),
    ]);

    expect(result).toMatchObject({ connection: { id: "connection-1", status: "active" } });
  });

  it("authenticates setup-only paired connections for the adapter to constrain", async () => {
    const { db } = database(connection("paired"));

    const result = await authTripAgent(db, new Request("https://trip.test", {
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    }));

    expect(result).toMatchObject({ connection: { status: "paired", grantedScopes: ["connector.setup"] } });
  });

  it("returns a forbidden boundary response for a valid paused credential", async () => {
    const { db } = database(connection("paused"));

    expect(await authTripAgent(db, new Request("https://trip.test", {
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    }))).toEqual({ status: 403, error: "Trip-agent connection is paused" });
  });

  it.each(["revoked", "archived"] as const)(
    "refuses a %s connection without exposing its lifecycle state",
    async (status) => {
      const { db } = database(connection(status));

      expect(await authTripAgent(db, new Request("https://trip.test", {
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
      }))).toEqual({ status: 401, error: "Invalid trip-agent credential" });
    },
  );
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  serviceClient: vi.fn(() => ({ name: "database" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ serviceClient: mocks.serviceClient }));
vi.mock("@/lib/trip-agent-auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/trip-agent-auth")>(),
  authTripAgent: mocks.auth,
}));

import { DELETE, GET } from "@/app/api/mcp/route";

const allowedUrl = "https://your-trip-planner.example/api/mcp";

beforeEach(() => {
  process.env.TRIP_AGENT_ALLOWED_HOSTS = "your-trip-planner.example";
  mocks.auth.mockReset().mockResolvedValue({
    connection: {
      id: "connection-1",
      tripId: "trip-1",
      status: "active",
      grantedScopes: ["trip.read"],
      whatsappGroupDigest: "group-digest",
    },
    trip: { id: "trip-1" },
  });
  mocks.serviceClient.mockClear();
});

describe("/api/mcp real modern-only handler", () => {
  it.each([
    ["GET", GET],
    ["DELETE", DELETE],
  ] as const)("returns the SDK's modern-only %s refusal without caching it", async (method, route) => {
    const response = await route(new Request(allowedUrl, {
      method,
      headers: { authorization: "Bearer credential" },
    }));

    expect(response.status).toBe(405);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { message: expect.any(String) },
    });
  });
});

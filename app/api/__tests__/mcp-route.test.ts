import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  createHandler: vi.fn(),
  handlerFetch: vi.fn(),
  serviceClient: vi.fn(() => ({ name: "database" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ serviceClient: mocks.serviceClient }));
vi.mock("@/lib/trip-agent-auth", () => ({ authTripAgent: mocks.auth }));
vi.mock("@/lib/trip-agent-tools", () => ({
  createTripAgentMcpHandler: mocks.createHandler,
}));

import { DELETE, GET, POST, dynamic, revalidate } from "@/app/api/mcp/route";

const allowedUrl = "https://your-trip-planner.example/api/mcp";
const authenticated = {
  connection: {
    id: "connection-1",
    tripId: "trip-1",
    status: "active",
    grantedScopes: ["trip.read"],
    whatsappGroupDigest: "group-digest",
  },
  trip: { id: "trip-1" },
};

function request(
  method: "POST" | "GET" | "DELETE" = "POST",
  options: { url?: string; origin?: string; authorization?: string; body?: string } = {},
) {
  return new Request(options.url ?? allowedUrl, {
    method,
    headers: {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: options.body } : {}),
  });
}

beforeEach(() => {
  process.env.TRIP_AGENT_ALLOWED_HOSTS = "your-trip-planner.example, localhost";
  mocks.auth.mockReset();
  mocks.createHandler.mockReset().mockReturnValue({ fetch: mocks.handlerFetch });
  mocks.handlerFetch.mockReset();
  mocks.serviceClient.mockClear();
  mocks.auth.mockResolvedValue(authenticated);
  mocks.handlerFetch.mockResolvedValue(Response.json({ ok: true }));
});

describe("/api/mcp transport boundary", () => {
  it("forces every MCP method to remain dynamic and uncached", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
  });

  it.each([
    ["POST", POST],
    ["GET", GET],
    ["DELETE", DELETE],
  ] as const)("authenticates and delegates the original %s request without caching", async (method, route) => {
    const original = request(method, {
      origin: "https://your-trip-planner.example",
      authorization: "Bearer credential",
      ...(method === "POST" ? { body: "{not-json" } : {}),
    });

    const response = await route(original);

    expect(response).toMatchObject({ status: 200 });
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), original);
    expect(mocks.createHandler).toHaveBeenCalledWith({
      db: { name: "database" },
      connection: authenticated.connection,
    });
    expect(mocks.handlerFetch).toHaveBeenCalledWith(original);
    expect(original.bodyUsed).toBe(false);
  });

  it.each([
    ["database construction", "serviceClient"],
    ["authentication", "auth"],
  ] as const)("sanitizes a thrown %s failure before SDK delegation", async (_name, failureAt) => {
    const secret = "SECRET_DATABASE_DIAGNOSTIC_SHOULD_NOT_ESCAPE";
    if (failureAt === "serviceClient") {
      mocks.serviceClient.mockImplementationOnce(() => { throw new Error(secret); });
    } else {
      mocks.auth.mockRejectedValueOnce(new Error(secret));
    }

    const response = await POST(request("POST", {
      authorization: "Bearer credential",
      body: "{not-json",
    }));
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(responseText)).toEqual({
      error: "Service temporarily unavailable — please try again in a moment",
    });
    expect(responseText).not.toContain(secret);
    expect(mocks.createHandler).not.toHaveBeenCalled();
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
    if (failureAt === "serviceClient") expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("preserves an SDK response while overriding cache policy", async () => {
    mocks.handlerFetch.mockResolvedValueOnce(new Response("method-not-allowed", {
      status: 405,
      statusText: "Method Not Allowed",
      headers: {
        "cache-control": "public, max-age=3600",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
      },
    }));

    const response = await DELETE(request("DELETE", {
      authorization: "Bearer credential",
    }));

    expect(response.status).toBe(405);
    expect(response.statusText).toBe("Method Not Allowed");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("method-not-allowed");
  });

  it.each([
    ["missing allow-list", undefined, allowedUrl, undefined],
    ["empty allow-list", "  , ", allowedUrl, undefined],
    ["malformed allow-list", "https://your-trip-planner.example", allowedUrl, undefined],
    ["unlisted host", "your-trip-planner.example", "https://attacker.example/api/mcp", undefined],
    ["cross-origin request", "your-trip-planner.example", allowedUrl, "https://attacker.example"],
    ["malformed origin", "your-trip-planner.example", allowedUrl, "not-an-origin"],
  ] as const)("fails closed for %s before authentication or MCP parsing", async (_name, allowList, url, origin) => {
    if (allowList === undefined) delete process.env.TRIP_AGENT_ALLOWED_HOSTS;
    else process.env.TRIP_AGENT_ALLOWED_HOSTS = allowList;
    const original = request("POST", {
      url,
      origin,
      authorization: "Bearer credential",
      body: "{not-json",
    });

    const response = await POST(original);

    expect(response.status).toBe(403);
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.createHandler).not.toHaveBeenCalled();
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
    expect(original.bodyUsed).toBe(false);
  });

  it.each([
    ["missing credential", undefined, { status: 401, error: "Invalid trip-agent credential" }, 401],
    ["invalid credential", "Bearer invalid", { status: 401, error: "Invalid trip-agent credential" }, 401],
    ["paused connection", "Bearer paused", { status: 403, error: "Trip-agent connection is paused" }, 403],
    ["database outage", "Bearer credential", { status: 503, error: "Service temporarily unavailable — please try again in a moment" }, 503],
  ])("returns the expected auth boundary failure for a %s", async (_name, authorization, failure, status) => {
    mocks.auth.mockResolvedValue(failure);
    const original = request("POST", {
      authorization,
      body: "{not-json",
    });

    const response = await POST(original);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: failure.error });
    expect(mocks.createHandler).not.toHaveBeenCalled();
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
    expect(original.bodyUsed).toBe(false);
  });
});

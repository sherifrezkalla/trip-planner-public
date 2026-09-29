import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));

vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));
vi.mock("server-only", () => ({}));

import { POST } from "@/app/api/trip-agent/pair/route";
import { digestTripAgentSecret } from "@/lib/trip-agent-auth";
import {
  TRIP_AGENT_PAIR_LIMIT,
  TRIP_AGENT_PAIR_WINDOW_SECONDS,
} from "@/lib/public-request-limit";

const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const originalVercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;

function request(body: unknown) {
  return new Request("https://trip-planner.test/api/trip-agent/pair", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.client.mockReset();
  process.env.NEXT_PUBLIC_SITE_URL = "https://planner.example/";
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  mocks.client.mockImplementation(() => ({ rpc: mocks.rpc }));
  mocks.rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: true, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  if (originalVercelUrl === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  else process.env.VERCEL_PROJECT_PRODUCTION_URL = originalVercelUrl;
});

describe("POST /api/trip-agent/pair", () => {
  it.each([
    "a".repeat(42), "a".repeat(44), "a".repeat(42) + "=", "a".repeat(42) + "+",
    "a".repeat(42) + "/", "a".repeat(42) + ".", "a".repeat(42) + "é",
    " " + "a".repeat(43), "a".repeat(43) + " ", "a".repeat(20) + " " + "a".repeat(22),
    "a".repeat(43) + "," + "b".repeat(43),
    ...["\n", "\r", "\r\n", "\u2028", "\u2029", "\t"].map(suffix => "a".repeat(43) + suffix),
  ])("rejects malformed pairing code before any digest database lookup", async pairingCode => {
    expect((await POST(request({ pairingCode, provider: "openclaw" }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("applies IP then domain-separated digest buckets across different IPs and codes", async () => {
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation(async name => name === "record_place_lookup"
      ? { data: true, error: null } : { data: null, error: { message: "invalid" } });
    const run = async (code: string, ip: string) => {
      const req = request({ pairingCode: code, provider: "openclaw" });
      req.headers.set("x-forwarded-for", ip);
      await POST(req);
    };
    await run("a".repeat(43), "203.0.113.1");
    await run("a".repeat(43), "203.0.113.2");
    await run("b".repeat(43), "203.0.113.1");
    const calls = mocks.rpc.mock.calls;
    expect(calls.map(([name]) => name)).toEqual(Array(3).fill(["record_place_lookup", "record_place_lookup", "consume_trip_agent_pairing"]).flat());
    expect(calls[0][1].p_client_hash).toBe(calls[6][1].p_client_hash);
    expect(calls[0][1].p_client_hash).not.toBe(calls[3][1].p_client_hash);
    expect(calls[1][1].p_client_hash).toBe(calls[4][1].p_client_hash);
    expect(calls[1][1].p_client_hash).not.toBe(calls[7][1].p_client_hash);
    expect(calls[1][1].p_client_hash).not.toBe(calls[2][1].p_pairing_digest);
    expect(JSON.stringify(calls)).not.toContain("a".repeat(43));
    expect(JSON.stringify(calls)).not.toContain("b".repeat(43));
  });

  it.each(["ip", "digest"])("refuses exhausted %s bucket before consuming the code", async bucket => {
    mocks.rpc.mockReset();
    if (bucket === "digest") mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    const response = await POST(request({ pairingCode: "a".repeat(43), provider: "openclaw" }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Too many pairing attempts. Try again in a little while." });
    expect(response.headers.get("Retry-After")).toBe("3600");
    expect(mocks.rpc).toHaveBeenCalledTimes(bucket === "ip" ? 1 : 2);
  });

  it.each(["ip", "digest"])("fails closed on %s limiter outage", async bucket => {
    mocks.rpc.mockReset();
    if (bucket === "digest") mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    mocks.rpc.mockRejectedValueOnce(new Error("PRIVATE outage"));
    const response = await POST(request({ pairingCode: "a".repeat(43), provider: "openclaw" }));
    expect(response.status).toBe(429);
    expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
    expect(mocks.rpc).toHaveBeenCalledTimes(bucket === "ip" ? 1 : 2);
  });
  it("refuses invalid JSON before charging a rate-limit slot", async () => {
    const response = await POST(request("not json"));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Invalid pairing request" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not distinguish an expired pairing code", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "invalid, expired, or used trip-agent pairing code" } });

    const response = await POST(request({ pairingCode: "a".repeat(43), provider: "openclaw" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Pairing code is invalid, expired, or already used" });
  });

  it("does not distinguish a provider mismatch", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "invalid, expired, or used trip-agent pairing code" } });

    const response = await POST(request({ pairingCode: "a".repeat(43), provider: "hermes" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Pairing code is invalid, expired, or already used" });
  });

  it("returns a no-store bounded failure when pairing infrastructure throws", async () => {
    mocks.rpc.mockReset();
    mocks.rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockRejectedValueOnce(new Error("PRIVATE database detail"));

    const response = await POST(request({ pairingCode: "a".repeat(43), provider: "openclaw" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Service temporarily unavailable — please try again in a moment",
    });
  });

  it("refuses a caller over the per-IP pairing ceiling before looking up a code", async () => {
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(request({ pairingCode: "a".repeat(43), provider: "openclaw" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe(String(TRIP_AGENT_PAIR_WINDOW_SECONDS));
    expect(mocks.rpc).toHaveBeenCalledWith("record_place_lookup", {
      p_client_hash: expect.any(String),
      p_limit: TRIP_AGENT_PAIR_LIMIT,
      p_window_seconds: TRIP_AGENT_PAIR_WINDOW_SECONDS,
    });
  });

  it("exchanges a code once, returning the plaintext credential only to the caller", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ connection_id: "connection-1", trip_id: "trip-1" }], error: null });

    const response = await POST(request({ pairingCode: "a".repeat(43), provider: "openclaw" }));
    const body = await response.json() as { credential: string; mcpUrl: string; connectionId: string; tripId: string; status: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      credential: expect.any(String),
      mcpUrl: "https://planner.example/api/mcp",
      connectionId: "connection-1",
      tripId: "trip-1",
      status: "paired",
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith("consume_trip_agent_pairing", {
      p_pairing_digest: digestTripAgentSecret("a".repeat(43)),
      p_provider: "openclaw",
      p_credential_digest: digestTripAgentSecret(body.credential),
      p_now: expect.any(String),
    });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(body.credential);
  });

  it("refuses a replay at the database-enforced one-time boundary", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ connection_id: "connection-1", trip_id: "trip-1" }], error: null });
    const first = await POST(request({ pairingCode: "a".repeat(43), provider: "openclaw" }));
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: true, error: null });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "invalid, expired, or used trip-agent pairing code" } });

    const replay = await POST(request({ pairingCode: "a".repeat(43), provider: "openclaw" }));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(400);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(replay.headers.get("Cache-Control")).toBe("no-store");
    expect(await replay.json()).toEqual({ error: "Pairing code is invalid, expired, or already used" });
  });
});

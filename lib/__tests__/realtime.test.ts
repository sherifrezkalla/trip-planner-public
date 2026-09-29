import { describe, it, expect, vi, beforeEach } from "vitest";
import { broadcastTripUpdate } from "@/lib/realtime";

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});

describe("broadcastTripUpdate", () => {
  it("POSTs the trip topic to the realtime broadcast endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 202 })) as unknown as typeof fetch;
    await broadcastTripUpdate("x7Kf9qLmB2", fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://example.supabase.co/realtime/v1/api/broadcast");
    const body = JSON.parse(init.body as string);
    expect(body.messages[0]).toMatchObject({ topic: "trip:x7Kf9qLmB2", event: "updated" });
    expect((init.headers as Record<string, string>).apikey).toBe("service-key");
  });

  it("throws on non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(broadcastTripUpdate("slug", fetchImpl)).rejects.toThrow("broadcast failed: 403");
  });
});

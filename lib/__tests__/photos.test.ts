import { describe, it, expect, vi } from "vitest";
import { fetchPlacePhotoRef, photoMediaUrl } from "@/lib/photos";

function respond(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("fetchPlacePhotoRef", () => {
  it("returns the first photo reference for a place", async () => {
    const fetchImpl = respond({ photos: [{ name: "places/abc/photos/xyz" }, { name: "second" }] });
    await expect(fetchPlacePhotoRef("abc", "key", fetchImpl)).resolves.toBe("places/abc/photos/xyz");
  });

  it("asks Google only for the photos field, with the key in a header", async () => {
    const fetchImpl = respond({ photos: [{ name: "n" }] });
    await fetchPlacePhotoRef("abc", "secret-key", fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/v1/places/abc");
    expect(url).toContain("fields=photos");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("secret-key");
    // The key must never ride along in the query string, which lands in logs.
    expect(String(url)).not.toContain("secret-key");
  });

  it("returns null when the place has no photos", async () => {
    await expect(fetchPlacePhotoRef("abc", "key", respond({}))).resolves.toBeNull();
    await expect(fetchPlacePhotoRef("abc", "key", respond({ photos: [] }))).resolves.toBeNull();
  });

  it("returns null when Google refuses, so trip creation still succeeds", async () => {
    await expect(fetchPlacePhotoRef("abc", "key", respond({ error: "nope" }, 403))).resolves.toBeNull();
  });

  it("returns null when the network fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    await expect(fetchPlacePhotoRef("abc", "key", fetchImpl)).resolves.toBeNull();
  });
});

describe("photoMediaUrl", () => {
  it("builds a media URL with the requested width", () => {
    const url = photoMediaUrl("places/abc/photos/xyz", "key", 1200);
    expect(url).toContain("places/abc/photos/xyz/media");
    expect(url).toContain("maxWidthPx=1200");
  });
});

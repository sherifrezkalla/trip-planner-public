import { serviceClient } from "@/lib/db";
import { fetchPlacePhotoRef, photoMediaUrl } from "@/lib/photos";

/**
 * The trip's hero image.
 *
 * Deliberately public and unauthenticated: a link-preview crawler (WhatsApp,
 * Telegram, iMessage) fetches this with no token. It exposes only a stock photo
 * of the destination, never trip data. The Google key stays server-side because
 * the bytes are proxied rather than the caller being redirected to a keyed URL.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return new Response("Photos unavailable", { status: 404 });

  const db = serviceClient();
  const { data: trip } = await db
    .from("trips").select("id, photo_ref, destination_place_id").eq("slug", slug).single();
  if (!trip) return new Response("Not found", { status: 404 });

  // Older trips predate photo storage; look one up and remember it.
  let ref = trip.photo_ref as string;
  if (!ref) {
    ref = (await fetchPlacePhotoRef(trip.destination_place_id, apiKey)) ?? "";
    if (ref) await db.from("trips").update({ photo_ref: ref }).eq("id", trip.id);
  }
  if (!ref) return new Response("No photo for this destination", { status: 404 });

  const upstream = await fetch(photoMediaUrl(ref, apiKey, 1200)).catch(() => null);
  if (!upstream?.ok || !upstream.body) {
    return new Response("Photo unavailable", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      // The destination photo is stable; let the CDN and crawlers keep it.
      "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
    },
  });
}

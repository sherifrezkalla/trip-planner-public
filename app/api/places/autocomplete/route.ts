import { NextResponse } from "next/server";
import { allowPlaceLookup } from "@/lib/public-request-limit";

/**
 * Destination search for the trip creation form.
 *
 * This proxies a billed Google Places call and cannot require a trip token —
 * it runs before a trip exists. Two things stand in for that:
 *
 * - The request must claim a same-host origin. This only turns away other sites
 *   embedding the endpoint; anyone can forge the header, so it is a courtesy
 *   fence, not a control.
 * - A per-caller ceiling, which is the part that actually bounds the bill.
 *
 * A missing Origin *and* Referer used to pass straight through, so anything not
 * driven by a browser skipped the fence entirely. Browsers send Referer on
 * same-origin requests by default and this app sets no policy suppressing it.
 */
function sameOrigin(req: Request, host: string): boolean {
  const header = req.headers.get("origin") ?? req.headers.get("referer");
  if (!header) return false;
  try {
    return new URL(header).host === host;
  } catch {
    return false;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);

  if (!sameOrigin(req, url.host)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length > 100) q = q.slice(0, 100);
  // Checked before the ledger so a keystroke too short to search costs neither
  // a Google call nor a slot in the caller's quota.
  if (q.length < 2) return NextResponse.json({ results: [] });

  if (!await allowPlaceLookup(req.headers)) {
    return NextResponse.json(
      { error: "Too many destination searches. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY!,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify({ textQuery: q, pageSize: 5 }),
  });
  if (!res.ok) return NextResponse.json({ error: "Places lookup failed" }, { status: 502 });
  const data = (await res.json()) as {
    places?: { id: string; displayName?: { text?: string }; formattedAddress?: string; location?: { latitude?: number; longitude?: number } }[];
  };
  return NextResponse.json({
    results: (data.places ?? []).map((p) => ({
      placeId: p.id,
      name: p.displayName?.text ?? "",
      address: p.formattedAddress ?? "",
      lat: p.location?.latitude ?? 0,
      lng: p.location?.longitude ?? 0,
    })),
  });
}

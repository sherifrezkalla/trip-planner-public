import { NextResponse } from "next/server";
import { openMeteoUrl, parseTodayWeather } from "@/lib/weather";

/**
 * When this reading was actually retrieved.
 *
 * Taken from the provider's own response rather than the clock: the upstream
 * fetch is cached for 15 minutes and this route's response may then be served
 * stale for 30 more, so a clock reading would reset on every cache hit and
 * claim a freshness the data does not have. The `Date` header travels with the
 * cached body, so it stays true through both layers.
 */
function retrievedAt(upstream: Response): string {
  const header = upstream.headers.get("date");
  const parsed = header ? new Date(header) : null;
  return parsed && Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString();
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const rawLat = url.searchParams.get("lat");
  const rawLng = url.searchParams.get("lng");
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!rawLat || !rawLng || !Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  try {
    const upstream = await fetch(openMeteoUrl(lat, lng), {
      signal: AbortSignal.timeout(8_000),
      next: { revalidate: 900 },
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: "Weather provider unavailable" }, { status: 502 });
    }
    const weather = parseTodayWeather(await upstream.json(), retrievedAt(upstream));
    if (!weather) {
      return NextResponse.json({ error: "Weather provider returned invalid data" }, { status: 502 });
    }
    return NextResponse.json(
      { weather },
      { headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800" } },
    );
  } catch {
    return NextResponse.json({ error: "Weather provider unavailable" }, { status: 502 });
  }
}

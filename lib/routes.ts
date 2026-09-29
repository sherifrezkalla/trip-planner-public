import "server-only";

import { z } from "zod";

export type RouteCoordinates = { lat: number; lng: number };
export type TrafficAwareRoute = {
  status: "available";
  durationSeconds: number;
  staticDurationSeconds: number;
  durationMinutes: number;
  trafficDelayMinutes: number;
  distanceMeters: number;
  encodedPolyline?: string;
  dataSource: "google_routes";
  verifyLiveAvailability: true;
};
export type TrafficAwareRouteResult = TrafficAwareRoute | {
  status: "unavailable";
  reason: "not_configured" | "invalid_response" | "upstream_unavailable";
};

// Protobuf durations use seconds plus at most nine fractional digits. Routes
// cannot have negative travel time; reject junk instead of parseFloat truncation.
const durationSchema = z.string().regex(/^\d+(?:\.\d{1,9})?s$/)
  .transform((value) => Number(value.slice(0, -1)))
  .pipe(z.number().finite().min(0).max(315_576_000_000));
const routeResponseSchema = z.object({
  routes: z.array(z.object({
    duration: durationSchema,
    staticDuration: durationSchema,
    distanceMeters: z.number().int().min(0),
    polyline: z.object({ encodedPolyline: z.string().max(200_000).optional() }).optional(),
  })).min(1),
});

export function parseTrafficAwareRoute(payload: unknown): TrafficAwareRouteResult {
  const parsed = routeResponseSchema.safeParse(payload);
  if (!parsed.success) return { status: "unavailable", reason: "invalid_response" };
  const route = parsed.data.routes[0];
  return {
    status: "available",
    durationSeconds: route.duration,
    staticDurationSeconds: route.staticDuration,
    durationMinutes: route.duration / 60,
    trafficDelayMinutes: Math.max(0, (route.duration - route.staticDuration) / 60),
    distanceMeters: route.distanceMeters,
    ...(route.polyline?.encodedPolyline ? { encodedPolyline: route.polyline.encodedPolyline } : {}),
    dataSource: "google_routes",
    verifyLiveAvailability: true,
  };
}

/** Driving directions at request time; failures never become made-up estimates. */
export async function computeTrafficAwareRoute(args: {
  origin: RouteCoordinates;
  destination: RouteCoordinates;
  fetchImpl?: typeof fetch;
}): Promise<TrafficAwareRouteResult> {
  const apiKey = process.env.GOOGLE_ROUTES_API_KEY?.trim();
  if (!apiKey) return { status: "unavailable", reason: "not_configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const waypoint = ({ lat, lng }: RouteCoordinates) => ({
    location: { latLng: { latitude: lat, longitude: lng } },
  });
  try {
    const response = await (args.fetchImpl ?? fetch)("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: waypoint(args.origin),
        destination: waypoint(args.destination),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
      }),
    });
    if (!response.ok) return { status: "unavailable", reason: "upstream_unavailable" };
    return parseTrafficAwareRoute(await response.json());
  } catch {
    return { status: "unavailable", reason: "upstream_unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

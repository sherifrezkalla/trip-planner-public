import type { SupabaseClient } from "@supabase/supabase-js";

export type TripRow = {
  id: string; slug: string; destination_name: string; destination_place_id: string;
  lat: number; lng: number; start_date: string; end_date: string;
  budget_level: "low" | "mid" | "high"; vibe_note: string; explore_radius_km: number; title: string; photo_ref: string;
};

export type TravelerRow = {
  id: string; trip_id: string; display_name: string; token: string; interests: string[];
  pace: string; dietary: string; constraints_note: string; is_organizer: boolean;
  is_bot?: boolean;
};

export function dayCount(startDate: string, endDate: string): number {
  const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

export type AuthFailure = { status: 404 | 401 | 503; error: string };

/**
 * PostgREST reports "no rows matched" from .single() as PGRST116. Anything else
 * is a real failure (paused project, connection timeout, network) and must not
 * be reported as a missing trip.
 */
function isMissingRow(error: { code?: string } | null): boolean {
  return error === null || error.code === "PGRST116";
}

const UNAVAILABLE = "Service temporarily unavailable — please try again in a moment";

/**
 * The header a traveller's token travels in.
 *
 * Every write already sends the token in a JSON body. The reads could not —
 * a GET has no body — so they put it in the query string, where it is written
 * verbatim into every access log the request passes through: Vercel's, any
 * proxy or CDN in front of it, and whatever monitoring consumes them. A request
 * body is not logged that way, and neither is a header.
 *
 * This matters more here than a session cookie would, because the token is not
 * a session. It is the traveller's whole identity on the trip, it does not
 * expire, and it is the same string the re-attach link carries — so a log line
 * is a durable credential, readable by anyone who can read logs, long after the
 * request it describes.
 */
export const TRIP_TOKEN_HEADER = "x-trip-token";

/**
 * A traveller's token from a request, header first.
 *
 * The query string is still accepted, and has to be: a browser tab loaded
 * before this deploys is running the old client, and it will keep sending
 * tokens the old way until it is reloaded. Refusing those would sign people out
 * mid-trip to fix a logging problem. The fallback is what makes this
 * deployable, not an oversight — see docs/architecture/traveller-tokens.md for
 * when it can be removed.
 */
export function travelerTokenFrom(req: Request): string {
  const fromHeader = req.headers.get(TRIP_TOKEN_HEADER)?.trim();
  if (fromHeader) return fromHeader;
  return new URL(req.url).searchParams.get("token")?.trim() ?? "";
}

/** Returns trip + authenticated traveler, or a typed error. */
export async function authTraveler(
  db: SupabaseClient,
  slug: string,
  token: string,
): Promise<{ trip: TripRow; me: TravelerRow } | AuthFailure> {
  const { data: trip, error: tripErr } = await db
    .from("trips").select("*").eq("slug", slug).single();
  if (!isMissingRow(tripErr)) return { status: 503, error: UNAVAILABLE };
  if (!trip) return { status: 404, error: "Trip not found" };

  const { data: me, error: meErr } = await db
    .from("travelers").select("*").eq("trip_id", trip.id).eq("token", token).single();
  if (!isMissingRow(meErr)) return { status: 503, error: UNAVAILABLE };
  if (!me) return { status: 401, error: "Invalid traveler token" };

  return { trip: trip as TripRow, me: me as TravelerRow };
}
